import AVFoundation
import MediaPlayer
import Observation
import UIKit

/// Lecture, file d'attente, écran verrouillé et centre de contrôle.
@MainActor
@Observable
final class PlayerModel {
    /// Instance unique, partagée entre l'app et CarPlay.
    static let shared = PlayerModel()

    // MARK: État visible

    private(set) var queue: [Track] = []
    private(set) var index: Int = 0
    private(set) var isPlaying = false
    private(set) var isLoading = false
    private(set) var currentTime: TimeInterval = 0
    private(set) var duration: TimeInterval = 0
    private(set) var isShuffled = false
    var repeatMode: RepeatMode = .off {
        didSet { saveSession() }
    }
    /// Fin du minuteur de veille.
    private(set) var sleepTimerEnd: Date?
    var errorMessage: String?

    enum RepeatMode: Int, Codable {
        case off, all, one
    }

    let library = LibraryStore()
    let downloads = DownloadStore()
    let account = AccountStore()

    var current: Track? { queue.indices.contains(index) ? queue[index] : nil }
    var hasNext: Bool { index + 1 < queue.count }
    var upNext: [Track] { hasNext ? Array(queue[(index + 1)...]) : [] }

    // MARK: Interne

    @ObservationIgnored private let player = AVPlayer()
    @ObservationIgnored private let client = InnerTubeClient()
    @ObservationIgnored private var timeObserver: Any?
    @ObservationIgnored private var loadTask: Task<Void, Never>?
    @ObservationIgnored private var statusObservation: NSKeyValueObservation?
    @ObservationIgnored private var artwork: MPMediaItemArtwork?
    @ObservationIgnored private var failureCount = 0
    /// Ordre de la file avant le mode aléatoire.
    @ObservationIgnored private var unshuffledQueue: [Track]?
    @ObservationIgnored private var sleepTask: Task<Void, Never>?
    @ObservationIgnored private var lastSessionSave = Date.distantPast
    /// Vraie durée du titre en cours (métadonnées ou paramètre « dur » du flux).
    /// AVPlayer annonce souvent le double pour les flux audio de YouTube : on ne s'y fie pas.
    @ObservationIgnored private var expectedDuration: TimeInterval?
    /// Durées lues dans les adresses de flux, réutilisées pour les fichiers en cache.
    @ObservationIgnored private var knownDurations: [String: TimeInterval] = [:]
    /// Évite de passer deux fois au titre suivant (fin détectée + notification).
    @ObservationIgnored private var endHandled = false

    init() {
        configureAudioSession()
        configureRemoteCommands()
        player.automaticallyWaitsToMinimizeStalling = true
        // AirPlay : l'iPhone lit le titre et envoie le son à l'appareil. Sans ça, iOS confie
        // l'adresse du flux à l'enceinte ou à l'Apple TV, qui ne peut pas l'ouvrir (adresse liée
        // à l'iPhone, ou fichier local du cache) : « cannot play ».
        player.allowsExternalPlayback = false
        loadDurations()
        restoreSession()

        timeObserver = player.addPeriodicTimeObserver(forInterval: CMTime(seconds: 0.5, preferredTimescale: 600), queue: .main) { [weak self] time in
            Task { @MainActor in self?.tick(time) }
        }
        NotificationCenter.default.addObserver(forName: AVPlayerItem.didPlayToEndTimeNotification, object: nil, queue: .main) { [weak self] note in
            let item = note.object as AnyObject?
            Task { @MainActor in
                guard let self, item === self.player.currentItem, !self.endHandled else { return }
                self.endHandled = true
                self.trackDidEnd()
            }
        }
        NotificationCenter.default.addObserver(forName: AVAudioSession.interruptionNotification, object: nil, queue: .main) { [weak self] note in
            let raw = note.userInfo?[AVAudioSessionInterruptionTypeKey] as? UInt
            let optionsRaw = note.userInfo?[AVAudioSessionInterruptionOptionKey] as? UInt ?? 0
            Task { @MainActor in self?.handleInterruption(typeRaw: raw, optionsRaw: optionsRaw) }
        }
    }

    // MARK: Commandes

    /// Lance une liste à partir d'un index, puis complète la file avec la radio du titre.
    func play(_ tracks: [Track], startAt start: Int = 0, shuffled: Bool = false) {
        guard !tracks.isEmpty else { return }
        if shuffled {
            unshuffledQueue = tracks
            queue = tracks.shuffled()
            index = 0
            isShuffled = true
        } else {
            unshuffledQueue = nil
            isShuffled = false
            queue = tracks
            index = min(max(start, 0), tracks.count - 1)
        }
        load()
        if queue.count - index <= 1 { extendWithRadio(from: queue[index]) }
    }

    func startRadio(from track: Track) {
        play([track], startAt: 0)
    }

    /// Lance un album, une playlist ou un artiste.
    func play(_ collection: MusicCollection, shuffled: Bool = false) {
        Task {
            do {
                let tracks = try await client.allTracks(of: collection)
                guard !tracks.isEmpty else { throw NovaError.emptyPage }
                play(tracks, shuffled: shuffled)
            } catch {
                errorMessage = "« \(collection.title) » : \(error.localizedDescription)"
            }
        }
    }

    func enqueue(_ collection: MusicCollection) {
        Task {
            guard let tracks = try? await client.allTracks(of: collection) else { return }
            enqueue(tracks)
        }
    }

    func playNext(_ track: Track) {
        guard current != nil else { play([track], startAt: 0); return }
        if let existing = queue.indices.first(where: { $0 > index && queue[$0].id == track.id }) {
            queue.remove(at: existing)
        }
        queue.insert(track, at: min(index + 1, queue.count))
        saveSession()
    }

    func enqueue(_ track: Track) {
        enqueue([track])
    }

    func enqueue(_ tracks: [Track]) {
        guard !tracks.isEmpty else { return }
        guard current != nil else { play(tracks); return }
        queue.append(contentsOf: tracks)
        saveSession()
    }

    func toggleShuffle() {
        guard let current else { return }
        if isShuffled {
            // Retour à l'ordre d'origine, en gardant les titres ajoutés depuis.
            var restored = unshuffledQueue ?? queue
            let known = Set(restored.map(\.id))
            restored += queue.filter { !known.contains($0.id) }
            queue = restored
            index = restored.firstIndex { $0.id == current.id } ?? 0
            unshuffledQueue = nil
            isShuffled = false
        } else {
            unshuffledQueue = queue
            let upcoming = upNext.shuffled()
            queue.replaceSubrange((index + 1)..<queue.count, with: upcoming)
            isShuffled = true
        }
        saveSession()
    }

    func cycleRepeat() {
        switch repeatMode {
        case .off: repeatMode = .all
        case .all: repeatMode = .one
        case .one: repeatMode = .off
        }
    }

    func clearUpNext() {
        guard current != nil, hasNext else { return }
        queue.removeSubrange((index + 1)..<queue.count)
        saveSession()
    }

    /// Minuteur de veille : met en pause après `minutes`, ou l'annule avec `nil`.
    func setSleepTimer(minutes: Int?) {
        sleepTask?.cancel()
        sleepTimerEnd = nil
        guard let minutes else { return }
        sleepTimerEnd = Date().addingTimeInterval(TimeInterval(minutes * 60))
        sleepTask = Task { [weak self] in
            try? await Task.sleep(for: .seconds(minutes * 60))
            guard !Task.isCancelled, let self else { return }
            self.pause()
            self.sleepTimerEnd = nil
        }
    }

    func toggleLike(_ track: Track) {
        let liked = library.toggleLike(track)
        guard account.isSignedIn else { return }
        Task { try? await client.setLiked(liked, videoID: track.id) }
    }

    func jump(to position: Int) {
        guard queue.indices.contains(position) else { return }
        index = position
        load()
    }

    func removeFromQueue(at offsets: IndexSet) {
        // Positions relatives à « À suivre ».
        let absolute = IndexSet(offsets.map { $0 + index + 1 })
        queue.remove(atOffsets: absolute)
        saveSession()
    }

    func moveInQueue(from source: IndexSet, to destination: Int) {
        let base = index + 1
        var upcoming = upNext
        upcoming.move(fromOffsets: source, toOffset: destination)
        queue.replaceSubrange(base..., with: upcoming)
        saveSession()
    }

    func togglePlay() {
        isPlaying ? pause() : resume()
    }

    func resume() {
        guard current != nil else { return }
        if player.currentItem == nil { load(resumeAt: currentTime); return }
        try? AVAudioSession.sharedInstance().setActive(true)
        player.play()
        isPlaying = true
        updateNowPlaying()
    }

    func pause() {
        player.pause()
        isPlaying = false
        updateNowPlaying()
        saveSession()
    }

    func next() {
        guard hasNext else {
            if repeatMode == .all, !queue.isEmpty {
                index = 0
                load()
            } else if let current {
                extendWithRadio(from: current, thenAdvance: true)
            }
            return
        }
        index += 1
        load()
    }

    func previous() {
        if currentTime > 3 || index == 0 {
            seek(to: 0)
        } else {
            index -= 1
            load()
        }
    }

    func seek(to seconds: TimeInterval) {
        // Revenir avant la fin réarme la détection de fin de titre.
        if seconds < (expectedDuration ?? .infinity) - 1 { endHandled = false }
        guard player.currentItem != nil else {
            currentTime = max(0, seconds)
            return
        }
        let target = CMTime(seconds: max(0, seconds), preferredTimescale: 600)
        currentTime = max(0, seconds)
        player.seek(to: target, toleranceBefore: .zero, toleranceAfter: .zero) { [weak self] _ in
            Task { @MainActor in self?.updateNowPlaying() }
        }
    }

    // MARK: Chargement

    private func load(resumeAt startTime: TimeInterval = 0) {
        guard let track = current else { return }
        loadTask?.cancel()
        statusObservation = nil
        player.pause()
        player.replaceCurrentItem(with: nil)
        isLoading = true
        isPlaying = false
        currentTime = startTime
        duration = track.duration ?? knownDurations[track.id] ?? 0
        expectedDuration = track.duration ?? knownDurations[track.id]
        endHandled = false
        artwork = nil
        updateNowPlaying()
        if expectedDuration == nil { fetchDuration(for: track) }
        saveSession(force: true)

        loadTask = Task { [weak self] in
            guard let self else { return }
            do {
                let url = try await self.playableURL(for: track)
                try Task.checkCancellation()
                self.start(url: url, track: track, at: startTime)
            } catch is CancellationError {
            } catch {
                guard !Task.isCancelled else { return }
                self.handleFailure(error, track: track)
            }
        }
        loadArtwork(for: track)
    }

    private func playableURL(for track: Track) async throws -> URL {
        if let file = downloads.localURL(for: track.id) { return file }
        if let local = await AudioCache.shared.localURL(for: track.id) { return local }
        let stream = try await StreamResolver.audioStream(for: track.id)
        if stream.isM4A {
            // Le fichier complet est mis en cache une fois la lecture lancée,
            // pour ne pas ralentir le démarrage en se disputant la connexion.
            Task.detached(priority: .utility) {
                try? await Task.sleep(for: .seconds(12))
                guard NetworkMonitor.shared.allowsCaching else { return }
                await AudioCache.shared.store(remote: stream.url, id: track.id)
            }
        }
        return stream.url
    }

    private func start(url: URL, track: Track, at startTime: TimeInterval) {
        // Le flux de YouTube indique la durée exacte dans son adresse (« dur=… »).
        if let dur = URLComponents(url: url, resolvingAgainstBaseURL: false)?
            .queryItems?.first(where: { $0.name == "dur" })?.value.flatMap(TimeInterval.init), dur > 0 {
            // Secours seulement : la durée de YouTube Music (métadonnées ou radio) reste prioritaire.
            if expectedDuration == nil {
                rememberDuration(dur, for: track.id)
                expectedDuration = dur
                duration = dur
            }
        }
        let item = AVPlayerItem(url: url)
        item.preferredForwardBufferDuration = 30
        statusObservation = item.observe(\.status, options: [.new]) { [weak self] item, _ in
            let failed = item.status == .failed
            let error = item.error
            Task { @MainActor in
                guard let self, failed else { return }
                self.handleFailure(error ?? NovaError.noPlayableStream, track: track)
            }
        }
        player.replaceCurrentItem(with: item)
        if startTime > 1 {
            player.seek(to: CMTime(seconds: startTime, preferredTimescale: 600))
        }
        try? AVAudioSession.sharedInstance().setActive(true)
        // Démarre dès les premières secondes reçues, sans attendre un gros tampon.
        player.playImmediately(atRate: 1)
        isPlaying = true
        isLoading = false
        failureCount = 0
        library.recordPlay(track, addToHistory: PlaybackSettings.recordHistory)
        updateNowPlaying()
        prefetchNext()
    }

    private func handleFailure(_ error: Error, track: Track) {
        guard current?.id == track.id else { return }
        isLoading = false
        isPlaying = false
        failureCount += 1
        // On saute le titre illisible, sans boucler à l'infini.
        if failureCount < 3, hasNext {
            index += 1
            load()
        } else {
            errorMessage = "« \(track.title) » : \(error.localizedDescription)"
            failureCount = 0
        }
    }

    private func trackDidEnd() {
        if repeatMode == .one {
            endHandled = false
            seek(to: 0)
            player.play()
            return
        }
        // Fin de la file sans radio automatique : on s'arrête.
        if !hasNext, repeatMode == .off, !PlaybackSettings.autoplayRadio {
            pause()
            seek(to: 0)
            return
        }
        next()
    }

    /// Prépare le titre suivant dans le cache pour un enchaînement instantané.
    /// Prépare les titres suivants : flux résolus tout de suite (démarrage instantané),
    /// fichier du prochain titre mis en cache après le démarrage du titre en cours.
    private func prefetchNext() {
        let upcoming = queue.dropFirst(index + 1).prefix(2).filter { downloads.localURL(for: $0.id) == nil }
        for (offset, next) in upcoming.enumerated() {
            Task.detached(priority: .background) {
                guard await !AudioCache.shared.contains(next.id),
                      let stream = try? await StreamResolver.audioStream(for: next.id) else { return }
                guard offset == 0, stream.isM4A else { return }
                try? await Task.sleep(for: .seconds(20))
                guard NetworkMonitor.shared.allowsCaching else { return }
                await AudioCache.shared.store(remote: stream.url, id: next.id)
            }
        }
    }

    private func extendWithRadio(from seed: Track, thenAdvance: Bool = false) {
        Task { [weak self] in
            guard let self, let radio = try? await self.client.radio(for: seed.id) else { return }
            let known = Set(self.queue.map(\.id))
            let fresh = radio.filter { !known.contains($0.id) }
            guard !fresh.isEmpty else { return }
            self.queue.append(contentsOf: fresh)
            self.saveSession()
            if thenAdvance, self.current?.id == seed.id { self.next() } else { self.prefetchNext() }
        }
    }

    // MARK: Temps

    private func tick(_ time: CMTime) {
        let seconds = time.seconds
        if seconds.isFinite, player.currentItem != nil { currentTime = seconds }
        if isPlaying, Date().timeIntervalSince(lastSessionSave) > 15 { saveSession() }
        if let expected = expectedDuration, expected > 0 {
            // Durée connue : on garde la vraie, même si AVPlayer annonce le double.
            if abs(duration - expected) > 0.5 {
                duration = expected
                updateNowPlaying()
            }
            // AVPlayer peut attendre la « seconde moitié » qui n'existe pas : on passe au suivant nous-mêmes.
            if isPlaying, !endHandled, currentTime >= expected - 0.4 {
                endHandled = true
                trackDidEnd()
            }
        } else if let itemDuration = player.currentItem?.duration.seconds, itemDuration.isFinite, itemDuration > 0,
                  abs(itemDuration - duration) > 0.5 {
            duration = itemDuration
            updateNowPlaying()
        }
    }

    // MARK: Session audio

    private func configureAudioSession() {
        let session = AVAudioSession.sharedInstance()
        try? session.setCategory(.playback, mode: .default, policy: .longFormAudio)
    }

    private func handleInterruption(typeRaw: UInt?, optionsRaw: UInt) {
        guard let typeRaw, let type = AVAudioSession.InterruptionType(rawValue: typeRaw) else { return }
        switch type {
        case .began:
            isPlaying = false
            updateNowPlaying()
        case .ended:
            if AVAudioSession.InterruptionOptions(rawValue: optionsRaw).contains(.shouldResume) { resume() }
        @unknown default:
            break
        }
    }

    // MARK: Écran verrouillé et centre de contrôle

    private func configureRemoteCommands() {
        let center = MPRemoteCommandCenter.shared()
        center.playCommand.addTarget { [weak self] _ in
            Task { @MainActor in self?.resume() }
            return .success
        }
        center.pauseCommand.addTarget { [weak self] _ in
            Task { @MainActor in self?.pause() }
            return .success
        }
        center.togglePlayPauseCommand.addTarget { [weak self] _ in
            Task { @MainActor in self?.togglePlay() }
            return .success
        }
        center.nextTrackCommand.addTarget { [weak self] _ in
            Task { @MainActor in self?.next() }
            return .success
        }
        center.previousTrackCommand.addTarget { [weak self] _ in
            Task { @MainActor in self?.previous() }
            return .success
        }
        center.changePlaybackPositionCommand.addTarget { [weak self] event in
            guard let event = event as? MPChangePlaybackPositionCommandEvent else { return .commandFailed }
            let position = event.positionTime
            Task { @MainActor in self?.seek(to: position) }
            return .success
        }
    }

    private func updateNowPlaying() {
        guard let track = current else {
            MPNowPlayingInfoCenter.default().nowPlayingInfo = nil
            return
        }
        var info: [String: Any] = [
            MPMediaItemPropertyTitle: track.title,
            MPMediaItemPropertyArtist: track.artist,
            MPNowPlayingInfoPropertyElapsedPlaybackTime: currentTime,
            MPNowPlayingInfoPropertyPlaybackRate: isPlaying ? 1.0 : 0.0,
            MPNowPlayingInfoPropertyMediaType: MPNowPlayingInfoMediaType.audio.rawValue,
        ]
        if let album = track.album { info[MPMediaItemPropertyAlbumTitle] = album }
        if duration > 0 { info[MPMediaItemPropertyPlaybackDuration] = duration }
        if let artwork { info[MPMediaItemPropertyArtwork] = artwork }
        MPNowPlayingInfoCenter.default().nowPlayingInfo = info
    }

    private func loadArtwork(for track: Track) {
        Task { [weak self] in
            // Pochette carrée en haute définition (écran verrouillé, CarPlay), miniature vidéo sinon.
            let urls = track.hasSquareArtwork ? track.artworkURLs(pixels: 1000) : track.videoThumbnailURLs
            guard let image = await ImageLoader.load(urls) else { return }
            guard let self, self.current?.id == track.id else { return }
            self.artwork = MPMediaItemArtwork(boundsSize: image.size) { _ in image }
            self.updateNowPlaying()
        }
    }

    // MARK: Reprise de la session

    private struct Session: Codable {
        var queue: [Track]
        var index: Int
        var time: TimeInterval
        var repeatMode: RepeatMode
        var unshuffledQueue: [Track]?
    }

    @ObservationIgnored private let sessionURL = FileManager.default
        .urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
        .appendingPathComponent("Nova", isDirectory: true)
        .appendingPathComponent("session.json")

    /// Enregistre la file et la position pour les retrouver au prochain lancement.
    func saveSession(force: Bool = false) {
        guard force || Date().timeIntervalSince(lastSessionSave) > 1 else { return }
        lastSessionSave = Date()
        let session = Session(queue: queue, index: index, time: currentTime,
                              repeatMode: repeatMode, unshuffledQueue: unshuffledQueue)
        try? FileManager.default.createDirectory(at: sessionURL.deletingLastPathComponent(), withIntermediateDirectories: true)
        try? JSONEncoder().encode(session).write(to: sessionURL, options: .atomic)
    }

    private func restoreSession() {
        guard let data = try? Data(contentsOf: sessionURL),
              let session = try? JSONDecoder().decode(Session.self, from: data),
              session.queue.indices.contains(session.index) else { return }
        queue = session.queue
        index = session.index
        currentTime = session.time
        duration = session.queue[session.index].duration ?? 0
        repeatMode = session.repeatMode
        unshuffledQueue = session.unshuffledQueue
        isShuffled = session.unshuffledQueue != nil
        updateNowPlaying()
    }

    // MARK: Durées réelles

    @ObservationIgnored private let durationsURL = FileManager.default
        .urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
        .appendingPathComponent("Nova", isDirectory: true)
        .appendingPathComponent("durations.json")

    private func loadDurations() {
        guard let data = try? Data(contentsOf: durationsURL),
              let saved = try? JSONDecoder().decode([String: TimeInterval].self, from: data) else { return }
        knownDurations = saved
    }

    private func rememberDuration(_ duration: TimeInterval, for id: String) {
        guard duration > 0, knownDurations[id] != duration else { return }
        knownDurations[id] = duration
        // On complète aussi la file d'attente (affichage des durées dans les listes).
        for position in queue.indices where queue[position].id == id && queue[position].duration == nil {
            queue[position].duration = duration
        }
        try? FileManager.default.createDirectory(at: durationsURL.deletingLastPathComponent(), withIntermediateDirectories: true)
        try? JSONEncoder().encode(knownDurations).write(to: durationsURL, options: .atomic)
    }

    /// Titre sans durée connue (import, accueil…) : YouTube Music la donne dans la radio du titre,
    /// dont le premier élément est le titre lui-même. AVPlayer, lui, annonce souvent le double.
    private func fetchDuration(for track: Track) {
        Task { [weak self] in
            guard let self, let radio = try? await self.client.radio(for: track.id) else { return }
            for item in radio {
                if let value = item.duration { self.rememberDuration(value, for: item.id) }
            }
            guard let value = radio.first(where: { $0.id == track.id })?.duration,
                  self.current?.id == track.id else { return }
            self.expectedDuration = value
            self.duration = value
            self.updateNowPlaying()
        }
    }
}
