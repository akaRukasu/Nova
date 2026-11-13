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

    private(set) var queue: [Track] = [] {
        didSet { upcomingChanged() }
    }
    private(set) var index: Int = 0 {
        didSet { upcomingChanged() }
    }
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
    /// Vrai pour un clip sans pochette carrée sur YouTube Music : le lecteur montre alors la vidéo en 16:9.
    private(set) var currentIsVideoOnly = false
    /// Transition AutoMix / fondu en cours (badge dans le lecteur).
    private(set) var isTransitioning = false
    private(set) var autoplayQueue: [Track] = []
    var errorMessage: String?
    private(set) var source: PlaybackSource = .octave
    var showsOctaveAccount = false
    @ObservationIgnored private(set) lazy var octave = OctaveWebPlayer()
    @ObservationIgnored private var preferredSource: PlaybackSource = .octave
    @ObservationIgnored private var playingPlaylistID: UUID?
    @ObservationIgnored private var octaveTrack: Track?
    @ObservationIgnored private var octaveNext: (original: Track, recording: Track)?
    @ObservationIgnored private var octaveMonitor: Task<Void, Never>?
    @ObservationIgnored private var octavePreload: Task<Void, Never>?
    @ObservationIgnored private var octaveSession = 0
    @ObservationIgnored private var octaveSeekAt = Date.distantPast

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

    /// Lecteur du titre en cours. Pendant une transition, le titre qui se termine passe sur `fadingOut`.
    @ObservationIgnored private var player = AVPlayer()
    @ObservationIgnored private var fadingOut: AVPlayer?
    @ObservationIgnored private var fadeTask: Task<Void, Never>?
    /// Transition lancée, titre suivant en préparation : l'ancien lecteur ne pilote plus l'état.
    @ObservationIgnored private var crossfadeStarting = false
    @ObservationIgnored private let client = InnerTubeClient()
    @ObservationIgnored private var timeObserver: Any?
    @ObservationIgnored private var loadTask: Task<Void, Never>?
    @ObservationIgnored private var statusObservation: NSKeyValueObservation?
    @ObservationIgnored private var artwork: MPMediaItemArtwork?
    @ObservationIgnored private var failureCount = 0
    /// Reprises automatiques du titre en cours (flux coupé, lien expiré…), limitées.
    @ObservationIgnored private var recoveryCount = 0
    @ObservationIgnored private var recoveringSince: Date?
    @ObservationIgnored private var recoveryTrackID: String?
    /// Reprise programmée (pause entre deux essais) : la surveillance n'en relance pas d'autre.
    @ObservationIgnored private var recoveryPending = false
    @ObservationIgnored private var waitingSince: Date?
    @ObservationIgnored private var watchdog: Task<Void, Never>?
    /// Téléphone en veille : temps accordé par iOS pour charger le titre suivant (silence entre deux titres).
    @ObservationIgnored private var loadingBackgroundTask: UIBackgroundTaskIdentifier = .invalid
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

    // AutoMix : analyses des titres, transition préparée, titre suivant déjà calé et programmé.
    @ObservationIgnored private var knownAnalyses: [String: TrackAnalysis] = [:]
    @ObservationIgnored private var mixPlan: MixPlan?
    @ObservationIgnored private var planTask: Task<Void, Never>?
    @ObservationIgnored private var lastPlanCheck = Date.distantPast
    @ObservationIgnored private var pendingMix: (player: AVPlayer, plan: MixPlan, task: Task<Void, Never>)?
    @ObservationIgnored private var rateTask: Task<Void, Never>?
    /// Volume du titre en cours selon l'égaliseur de volume (1 = inchangé).
    @ObservationIgnored private var currentGain: Double = 1

    init() {
        configureAudioSession()
        configureRemoteCommands()
        Self.configure(player)
        loadDurations()
        restoreSession()
        attachTimeObserver()
        NotificationCenter.default.addObserver(forName: AVPlayerItem.didPlayToEndTimeNotification, object: nil, queue: .main) { [weak self] note in
            let item = note.object as AnyObject?
            Task { @MainActor in
                guard let self, self.source == .youtube, item === self.player.currentItem, !self.endHandled else { return }
                self.endHandled = true
                self.trackDidEnd()
            }
        }
        // Flux coupé en pleine lecture (lien expiré, réseau changé, YouTube qui ralentit…).
        NotificationCenter.default.addObserver(forName: AVPlayerItem.failedToPlayToEndTimeNotification, object: nil, queue: .main) { [weak self] note in
            let item = note.object as AnyObject?
            Task { @MainActor in
                guard let self, self.source == .youtube, item === self.player.currentItem else { return }
                self.recoverPlayback(reason: "fin de flux inattendue")
            }
        }
        // Casque débranché, enceinte Bluetooth éteinte : iOS met en pause, l'interface suit.
        NotificationCenter.default.addObserver(forName: AVAudioSession.routeChangeNotification, object: nil, queue: .main) { [weak self] note in
            let reason = (note.userInfo?[AVAudioSessionRouteChangeReasonKey] as? UInt)
                .flatMap(AVAudioSession.RouteChangeReason.init(rawValue:))
            Task { @MainActor in
                guard let self, reason == .oldDeviceUnavailable else { return }
                self.finishTransition()
                self.player.pause()
                self.isPlaying = false
                self.updateNowPlaying()
            }
        }
        // Services audio d'iOS relancés : on reconfigure et on reprend.
        NotificationCenter.default.addObserver(forName: AVAudioSession.mediaServicesWereResetNotification, object: nil, queue: .main) { [weak self] _ in
            Task { @MainActor in
                guard let self else { return }
                self.configureAudioSession()
                if self.isPlaying { self.recoverPlayback(reason: "services audio relancés") }
            }
        }
        NotificationCenter.default.addObserver(forName: NetworkMonitor.didChangeNetwork, object: nil, queue: .main) { [weak self] _ in
            Task { @MainActor in self?.waitingSince = nil }
        }
        startWatchdog()
        NotificationCenter.default.addObserver(forName: AVAudioSession.interruptionNotification, object: nil, queue: .main) { [weak self] note in
            let raw = note.userInfo?[AVAudioSessionInterruptionTypeKey] as? UInt
            let optionsRaw = note.userInfo?[AVAudioSessionInterruptionOptionKey] as? UInt ?? 0
            Task { @MainActor in self?.handleInterruption(typeRaw: raw, optionsRaw: optionsRaw) }
        }
    }

    private static func configure(_ player: AVPlayer) {
        player.automaticallyWaitsToMinimizeStalling = true
        // AirPlay : l'iPhone lit le titre et envoie le son à l'appareil. Sans ça, iOS confie
        // l'adresse du flux à l'enceinte ou à l'Apple TV, qui ne peut pas l'ouvrir (adresse liée
        // à l'iPhone, ou fichier local du cache) : « cannot play ».
        player.allowsExternalPlayback = false
    }

    private func attachTimeObserver() {
        timeObserver = player.addPeriodicTimeObserver(forInterval: CMTime(seconds: 0.25, preferredTimescale: 600), queue: .main) { [weak self] time in
            Task { @MainActor in self?.tick(time) }
        }
    }

    /// Créée hors de l'acteur principal : iOS demande l'image depuis un autre fil (écran verrouillé).
    nonisolated private static func makeArtwork(_ image: UIImage) -> MPMediaItemArtwork {
        MPMediaItemArtwork(boundsSize: image.size) { @Sendable _ in image }
    }

    // MARK: Veille

    /// Pendant le chargement d'un titre, rien ne joue : sans ce délai, iOS peut endormir l'app
    /// (écran verrouillé) avant que le titre suivant ou la reprise ne démarre.
    private func beginLoadingBackgroundTask() {
        guard loadingBackgroundTask == .invalid else { return }
        loadingBackgroundTask = UIApplication.shared.beginBackgroundTask(withName: "Chargement du titre") { [weak self] in
            // Rendu tout de suite (sur le fil principal) : sinon iOS ferme l'app.
            MainActor.assumeIsolated { self?.endLoadingBackgroundTask() }
        }
    }

    private func endLoadingBackgroundTask() {
        guard loadingBackgroundTask != .invalid else { return }
        UIApplication.shared.endBackgroundTask(loadingBackgroundTask)
        loadingBackgroundTask = .invalid
    }

    // MARK: Reprise automatique

    /// Toutes les 2 s : si la musique devrait jouer mais n'avance plus, on relance le titre là où il en était.
    private func startWatchdog() {
        watchdog = Task { [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(for: .seconds(2))
                self?.checkPlayback()
            }
        }
    }

    private func checkPlayback() {
        // Fin du titre déjà gérée (passage au suivant en cours) : rien à relancer.
        guard isPlaying, !isLoading, !crossfadeStarting, !endHandled, let item = player.currentItem else {
            waitingSince = nil
            return
        }
        if item.status == .failed {
            recoverPlayback(reason: "flux en échec")
            return
        }
        switch player.timeControlStatus {
        case .playing:
            waitingSince = nil
            if let since = recoveringSince, Date().timeIntervalSince(since) > 20 {
                // Lecture repartie et stable : le compteur de reprises repart de zéro.
                recoveringSince = nil
                recoveryCount = 0
            }
        case .waitingToPlayAtSpecifiedRate:
            // Mise en mémoire tampon : normal quelques secondes, anormal au-delà.
            let since = waitingSince ?? Date()
            waitingSince = since
            // Écran verrouillé : on n'attend pas trop, iOS endort les apps silencieuses.
            let background = UIApplication.shared.applicationState == .background
            if Date().timeIntervalSince(since) > (NetworkMonitor.shared.isConnected ? (background ? 6 : 10) : 30) {
                recoverPlayback(reason: "flux bloqué")
            }
        case .paused:
            // Arrêtée sans qu'on l'ait demandé (ni pause, ni interruption) : on relance.
            if waitingSince == nil {
                waitingSince = Date()
                player.play()
            } else {
                recoverPlayback(reason: "lecture arrêtée")
            }
        @unknown default:
            break
        }
    }

    /// Relance le titre en cours à la même position, avec un lien de flux neuf.
    private func recoverPlayback(reason: String) {
        guard let track = current, !isLoading, !endHandled, !recoveryPending else { return }
        waitingSince = nil
        if recoveryTrackID != track.id {
            recoveryTrackID = track.id
            recoveryCount = 0
        }
        guard recoveryCount < 3 else {
            // Trop d'échecs pour ce titre : on passe au suivant.
            recoveryCount = 0
            recoveringSince = nil
            handleFailure(NovaError.noPlayableStream, track: track)
            return
        }
        recoveryCount += 1
        recoveringSince = Date()
        let position = currentTime
        let usedLocalFile = (player.currentItem?.asset as? AVURLAsset)?.url.isFileURL == true
        let attempt = recoveryCount
        recoveryPending = true
        Task {
            defer { recoveryPending = false }
            // 1er essai : même lien (souvent une simple coupure réseau, sans nouvelle extraction coûteuse).
            // Ensuite : lien neuf, après une pause pour ne pas enchaîner les extractions.
            if attempt > 1 {
                try? await Task.sleep(for: .seconds(4))
                await StreamResolver.invalidate(track.id)
            }
            // Fichier du cache illisible : retiré, le flux en ligne prend le relais.
            if attempt > 1, usedLocalFile, downloads.localURL(for: track.id) == nil { await AudioCache.shared.remove(track.id) }
            guard current?.id == track.id else { return }
            load(resumeAt: position)
        }
    }

    // MARK: Transitions (AutoMix, fondu enchaîné)

    /// Lance le titre suivant avant la fin de celui-ci.
    private func beginTransition(_ duration: TimeInterval) {
        isTransitioning = true
        crossfadeStarting = true
        endHandled = true
        index += 1
        load(transition: duration)
    }

    /// Le nouveau lecteur devient le lecteur principal ; l'ancien s'efface en arrière-plan.
    private func runTransition(to incoming: AVPlayer, duration: TimeInterval) {
        finishTransition()
        let outgoing = player
        if let timeObserver { outgoing.removeTimeObserver(timeObserver) }
        timeObserver = nil
        player = incoming
        attachTimeObserver()
        crossfadeStarting = false
        fadingOut = outgoing
        let outgoingGain = currentGain
        let incomingGain = MixPlan.gain(for: current.flatMap { knownAnalyses[$0.id] })
        currentGain = incomingGain
        fadeTask = Task { [weak self] in
            let started = ProcessInfo.processInfo.systemUptime
            while !Task.isCancelled {
                let fraction = (ProcessInfo.processInfo.systemUptime - started) / duration
                let volumes = MixPlan.volumes(at: fraction)
                incoming.volume = Float(volumes.incoming * incomingGain)
                outgoing.volume = Float(volumes.outgoing * outgoingGain)
                if fraction >= 1 { break }
                try? await Task.sleep(for: .milliseconds(25))
            }
            guard !Task.isCancelled else { return }
            self?.finishTransition()
        }
    }

    /// Arrête le titre qui s'efface (fin de transition, pause, saut, avance…).
    private func finishTransition() {
        fadeTask?.cancel()
        fadeTask = nil
        if let fadingOut {
            fadingOut.pause()
            fadingOut.replaceCurrentItem(with: nil)
        }
        fadingOut = nil
        cancelPendingMix()
        player.volume = Float(currentGain)
        if !crossfadeStarting { isTransitioning = false }
    }

    // MARK: AutoMix calé sur le tempo

    /// Analyse des deux titres (fichiers locaux) et transition calculée à l'avance, revue toutes les 5 s au plus.
    private func refreshMixPlan() {
        guard Date().timeIntervalSince(lastPlanCheck) > 5, planTask == nil, let current, hasNext else { return }
        let next = queue[index + 1]
        if let plan = mixPlan, plan.outgoingID == current.id, plan.incomingID == next.id { return }
        lastPlanCheck = Date()
        planTask = Task { [weak self] in
            guard let self else { return }
            let outgoing = await self.analysis(for: current)
            let incoming = outgoing == nil ? nil : await self.analysis(for: next)
            self.planTask = nil
            guard let outgoing, let incoming, self.current?.id == current.id,
                  self.queue.indices.contains(self.index + 1), self.queue[self.index + 1].id == next.id else { return }
            self.mixPlan = MixPlan.plan(outgoingID: current.id, outgoing, incomingID: next.id, incoming)
        }
    }

    private func analysis(for track: Track) async -> TrackAnalysis? {
        if let known = knownAnalyses[track.id] { return known }
        var result = await AnalysisStore.shared.cached(track.id)
        if result == nil, let file = await localFile(for: track) {
            result = await AnalysisStore.shared.analysis(for: track.id, file: file)
        }
        if let result { knownAnalyses[track.id] = result }
        return result
    }

    private func localFile(for track: Track) async -> URL? {
        if let file = downloads.localURL(for: track.id) { return file }
        return await AudioCache.shared.localURL(for: track.id)
    }

    /// Prépare le titre suivant (fichier local, position, tempo) et programme son départ à l'instant exact
    /// où le titre en cours atteint le début du mélange : les temps des deux titres tombent ensemble.
    private func prepareMix(_ plan: MixPlan) {
        guard let next = queue.dropFirst(index + 1).first, next.id == plan.incomingID else {
            mixPlan = nil
            return
        }
        let outgoing = player
        let incoming = AVPlayer()
        Self.configure(incoming)
        // Départ programmé à une heure précise : pas d'attente automatique de la mémoire tampon.
        incoming.automaticallyWaitsToMinimizeStalling = false
        incoming.volume = 0
        let task = Task { [weak self] in
            guard let self, let file = await self.localFile(for: next), !Task.isCancelled else {
                self?.mixPlan = nil
                self?.cancelPendingMix()
                return
            }
            let item = AVPlayerItem(url: file)
            // Tempo ajusté sans changer la hauteur des notes.
            if plan.incomingRate != 1 { item.audioTimePitchAlgorithm = .spectral }
            incoming.replaceCurrentItem(with: item)
            var ready = false
            for _ in 0..<80 where !Task.isCancelled {
                if item.status == .readyToPlay { ready = true; break }
                if item.status == .failed { break }
                try? await Task.sleep(for: .milliseconds(50))
            }
            guard ready, !Task.isCancelled else {
                if !Task.isCancelled { self.mixPlan = nil; self.cancelPendingMix() }
                return
            }
            let positioned = await incoming.seek(to: CMTime(seconds: plan.incomingOffset, preferredTimescale: 44_100),
                                                 toleranceBefore: .zero, toleranceAfter: .zero)
            let readyForPlayback = positioned ? await incoming.preroll(atRate: Float(plan.incomingRate)) : false
            guard !Task.isCancelled, self.pendingMix?.plan == plan, self.player === outgoing else { return }
            guard readyForPlayback else {
                self.mixPlan = nil
                self.cancelPendingMix()
                return
            }
            // Instant où le titre en cours atteint le début du mélange (horloge de l'appareil).
            var delay = plan.start - outgoing.currentTime().seconds
            var offset = plan.incomingOffset
            if delay < 0.05 {
                // Un peu en retard (préparation lente) : le titre suivant démarre plus loin, toujours dans le temps.
                offset += (0.05 - delay) * plan.incomingRate
                delay = 0.05
            }
            let hostTime = CMTimeAdd(CMClockGetTime(CMClockGetHostTimeClock()), CMTime(seconds: delay, preferredTimescale: 1_000_000_000))
            incoming.setRate(Float(plan.incomingRate), time: CMTime(seconds: offset, preferredTimescale: 44_100), atHostTime: hostTime)
            try? await Task.sleep(for: .seconds(delay))
            for _ in 0..<15 {
                guard !Task.isCancelled else { return }
                if incoming.timeControlStatus == .playing, incoming.currentTime().seconds > offset { break }
                try? await Task.sleep(for: .milliseconds(40))
            }
            guard !Task.isCancelled else { return }
            guard incoming.timeControlStatus == .playing, incoming.currentTime().seconds > offset else {
                self.mixPlan = nil
                self.cancelPendingMix()
                return
            }
            self.commitMix(plan, incoming: incoming, item: item, offset: incoming.currentTime().seconds)
        }
        pendingMix = (incoming, plan, task)
    }

    /// Mélange en cours : le titre suivant devient le titre en cours, l'autre s'efface.
    private func commitMix(_ plan: MixPlan, incoming: AVPlayer, item: AVPlayerItem, offset: Double) {
        pendingMix = nil
        mixPlan = nil
        guard isPlaying, current?.id == plan.outgoingID, queue.indices.contains(index + 1),
              queue[index + 1].id == plan.incomingID else {
            incoming.pause()
            incoming.replaceCurrentItem(with: nil)
            return
        }
        let outgoing = player
        if let timeObserver { outgoing.removeTimeObserver(timeObserver) }
        timeObserver = nil
        index += 1
        let track = queue[index]
        player = incoming
        fadingOut = outgoing
        isTransitioning = true
        crossfadeStarting = false
        currentTime = offset
        duration = track.duration ?? knownDurations[track.id] ?? 0
        expectedDuration = track.duration ?? knownDurations[track.id]
        if expectedDuration == nil { fetchDuration(for: track) }
        endHandled = false
        artwork = nil
        currentIsVideoOnly = false
        if !track.hasSquareArtwork { resolveArtwork(for: track) }
        observeStatus(of: item, track: track)
        attachTimeObserver()
        isPlaying = true
        isLoading = false
        failureCount = 0
        currentGain = plan.incomingGain
        library.recordPlay(track, addToHistory: PlaybackSettings.recordHistory, playlistID: playingPlaylistID)
        saveSession(force: true)
        updateNowPlaying()
        loadArtwork(for: track)
        prefetchNext()

        fadeTask = Task { [weak self] in
            let started = ProcessInfo.processInfo.systemUptime
            while !Task.isCancelled {
                let fraction = (ProcessInfo.processInfo.systemUptime - started) / plan.duration
                let volumes = MixPlan.volumes(at: fraction)
                incoming.volume = Float(volumes.incoming * plan.incomingGain)
                outgoing.volume = Float(volumes.outgoing * plan.outgoingGain)
                if fraction >= 1 { break }
                try? await Task.sleep(for: .milliseconds(25))
            }
            guard !Task.isCancelled else { return }
            guard let self else { return }
            self.finishTransition()
            if plan.incomingRate != 1 { self.restoreTempo(of: incoming, from: plan.incomingRate) }
        }
    }

    /// Après le mélange, le titre revient doucement à son tempo d'origine (en 4 s, hauteur inchangée).
    private func restoreTempo(of target: AVPlayer, from rate: Double) {
        rateTask?.cancel()
        rateTask = Task { [weak self] in
            for step in 1...40 {
                try? await Task.sleep(for: .milliseconds(100))
                guard let self, !Task.isCancelled, self.isPlaying, self.player === target else { return }
                target.rate = Float(rate + (1 - rate) * Double(step) / 40)
            }
        }
    }

    /// Transition programmée abandonnée (pause, saut, nouveau titre…).
    private func cancelPendingMix() {
        guard let pending = pendingMix else { return }
        pendingMix = nil
        pending.task.cancel()
        pending.player.pause()
        pending.player.replaceCurrentItem(with: nil)
    }

    // MARK: Commandes

    /// Lance une liste à partir d'un index, puis complète la file avec la radio du titre.
    func play(_ tracks: [Track], startAt start: Int = 0, shuffled: Bool = false, source: PlaybackSource = .octave, playlistID: UUID? = nil) {
        guard !tracks.isEmpty else { return }
        if RemoteControl.shared.isActive {
            Task { await RemoteControl.shared.send(["action": "playTracks", "index": start, "shuffled": shuffled, "playbackSource": source.rawValue], tracks: tracks) }
            return
        }
        playingPlaylistID = playlistID
        preferredSource = source
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
        if self.source == .youtube, queue.count - index <= 1 { extendWithRadio(from: queue[index]) }
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
                play(tracks, shuffled: shuffled, source: collection.kind == .playlist ? PlaybackSettings.playlistSource : .octave)
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
        if RemoteControl.shared.isActive {
            Task { await RemoteControl.shared.send(["action": "playNext"], tracks: [track]) }
            return
        }
        guard current != nil else { play([track], startAt: 0); return }
        let previous = upNext.first
        if let existing = queue.indices.first(where: { $0 > index && queue[$0].id == track.id }) {
            queue.remove(at: existing)
        }
        queue.insert(track, at: min(index + 1, queue.count))
        queueEdited(previous)
    }

    func enqueue(_ track: Track) {
        enqueue([track])
    }

    func enqueue(_ tracks: [Track], at position: Int? = nil) {
        if RemoteControl.shared.isActive {
            var command: [String: Any] = ["action": "enqueue"]
            if let position { command["index"] = position }
            Task { await RemoteControl.shared.send(command, tracks: tracks) }
            return
        }
        guard !tracks.isEmpty else { return }
        guard current != nil else { play(tracks); return }
        let previous = upNext.first
        let at = position.map { min(queue.count, max(index + 1, $0)) } ?? queue.count
        queue.insert(contentsOf: tracks, at: at)
        queueEdited(previous)
    }

    func toggleShuffle() {
        if RemoteControl.shared.isActive { return RemoteControl.shared.command("shuffle") }
        guard let current else { return }
        let previous = upNext.first
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
        queueEdited(previous)
    }

    func cycleRepeat() {
        if RemoteControl.shared.isActive { return RemoteControl.shared.command("repeat") }
        switch repeatMode {
        case .off: repeatMode = .all
        case .all: repeatMode = .one
        case .one: repeatMode = .off
        }
    }

    func clearUpNext() {
        guard current != nil else { return }
        queue.removeSubrange((index + 1)..<queue.count)
        autoplayQueue = []
        unshuffledQueue = nil
        isShuffled = false
        queueEdited(nil, force: true)
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
        if RemoteControl.shared.isActive { return RemoteControl.shared.command("jump", value: Double(position - index - 1)) }
        guard queue.indices.contains(position) else { return }
        index = position
        load()
    }

    func removeFromQueue(at offsets: IndexSet) {
        let previous = upNext.first
        // Positions relatives à « À suivre ».
        let absolute = IndexSet(offsets.map { $0 + index + 1 })
        queue.remove(atOffsets: absolute)
        queueEdited(previous)
    }

    func moveInQueue(from source: IndexSet, to destination: Int) {
        let previous = upNext.first
        let base = index + 1
        var upcoming = upNext
        upcoming.move(fromOffsets: source, toOffset: destination)
        queue.replaceSubrange(base..., with: upcoming)
        queueEdited(previous)
    }

    /// Jam, invité qui écoute aussi : même file, même titre, même position que l'hôte.
    func followJam(queue newQueue: [Track], index newIndex: Int, position: TimeInterval, playing: Bool, hostTransitioning: Bool = false) {
        guard newQueue.indices.contains(newIndex) else { return }
        if playing, isPlaying, isTransitioning || hostTransitioning { return }
        if current?.id != newQueue[newIndex].id {
            unshuffledQueue = nil
            isShuffled = false
            queue = newQueue
            index = newIndex
            preferredSource = newQueue[newIndex].id.hasPrefix("octave:") ? .octave : .youtube
            load(resumeAt: position, paused: !playing)
            return
        }
        queue = newQueue
        index = newIndex
        guard !isLoading else { return }
        if abs(currentTime - position) > (playing ? 3 : 1.5) { seek(to: position) }
        if playing, !isPlaying { resume() }
        if !playing, isPlaying { pause() }
    }

    func togglePlay() {
        if RemoteControl.shared.isActive { return RemoteControl.shared.command(isPlaying ? "pause" : "play") }
        isPlaying ? pause() : resume()
    }

    func resume() {
        if RemoteControl.shared.isActive { return RemoteControl.shared.command("play") }
        guard current != nil, !isLoading else { return }
        if source == .octave {
            if octaveTrack == nil { load(resumeAt: currentTime) }
            else { Task { await octave.command("play") } }
            return
        }
        if player.currentItem == nil { load(resumeAt: currentTime); return }
        try? AVAudioSession.sharedInstance().setActive(true)
        player.play()
        isPlaying = true
        updateNowPlaying()
    }

    func pause() {
        if RemoteControl.shared.isActive { return RemoteControl.shared.command("pause") }
        if crossfadeStarting {
            loadTask?.cancel()
            crossfadeStarting = false
            isLoading = false
            player.replaceCurrentItem(with: nil)
        }
        if source == .octave {
            if isLoading {
                loadTask?.cancel()
                octave.invalidate()
                isLoading = false
            }
            Task { await octave.command("pause") }
        }
        finishTransition()
        player.pause()
        isPlaying = false
        updateNowPlaying()
        saveSession()
    }

    func next() {
        if RemoteControl.shared.isActive { return RemoteControl.shared.command("next") }
        if source == .octave, octaveTrack != nil {
            if hasNext, octaveNext?.original.id == queue[index + 1].id {
                Task { await octave.command("next") }
                return
            }
            if !hasNext, repeatMode != .all {
                Task { await octave.command("next") }
                return
            }
        }
        guard hasNext else {
            if repeatMode == .all, !queue.isEmpty {
                index = 0
                load()
            } else if let current {
                extendWithRadio(from: current, thenAdvance: true)
            }
            return
        }
        // AutoMix : même en passant au suivant à la main, les deux titres se fondent brièvement.
        if PlaybackSettings.transition != .off, isPlaying, !isLoading, !crossfadeStarting,
           player.currentItem != nil, JamSession.shared.role != .guest || !JamSession.shared.listenAlong {
            finishTransition()
            beginTransition(PlaybackSettings.transition == .automix ? 3 : min(PlaybackSettings.crossfadeSeconds, 3))
            return
        }
        index += 1
        load()
    }

    func previous() {
        if RemoteControl.shared.isActive { return RemoteControl.shared.command("previous") }
        if currentTime > 3 || index == 0 {
            seek(to: 0)
        } else {
            index -= 1
            load()
        }
    }

    func seek(to seconds: TimeInterval) {
        if RemoteControl.shared.isActive {
            currentTime = seconds
            return RemoteControl.shared.command("seek", value: seconds)
        }
        if source == .octave {
            octaveSeekAt = Date()
            currentTime = max(0, seconds)
            if octaveTrack != nil { Task { await octave.command("seek", value: max(0, seconds)) } }
            return
        }
        // Revenir avant la fin réarme la détection de fin de titre.
        if seconds < (expectedDuration ?? .infinity) - 1 { endHandled = false }
        guard player.currentItem != nil else {
            currentTime = max(0, seconds)
            return
        }
        finishTransition()
        let target = CMTime(seconds: max(0, seconds), preferredTimescale: 600)
        currentTime = max(0, seconds)
        player.seek(to: target, toleranceBefore: .zero, toleranceAfter: .zero) { [weak self] _ in
            Task { @MainActor in self?.updateNowPlaying() }
        }
    }

    // MARK: Chargement

    /// `transition` : le titre précédent continue pendant le chargement, puis s'efface en fondu.
    private func load(resumeAt startTime: TimeInterval = 0, transition: TimeInterval? = nil, paused: Bool = false) {
        guard let track = current else { return }
        loadTask?.cancel()
        octaveMonitor?.cancel()
        octavePreload?.cancel()
        octaveNext = nil
        let wasOctave = source == .octave && (octaveTrack != nil || isLoading)
        octaveTrack = nil
        octaveSession += 1
        let session = octaveSession
        let localDownload = !NetworkMonitor.shared.isConnected && downloads.localURL(for: track.id) != nil
        source = localDownload ? .youtube : preferredSource
        rateTask?.cancel()
        statusObservation = nil
        beginLoadingBackgroundTask()
        if transition == nil {
            crossfadeStarting = false
            finishTransition()
            player.pause()
            player.replaceCurrentItem(with: nil)
            isPlaying = false
        }
        isLoading = !paused
        currentTime = startTime
        duration = track.duration ?? knownDurations[track.id] ?? 0
        expectedDuration = track.duration ?? knownDurations[track.id]
        endHandled = false
        artwork = nil
        updateNowPlaying()
        if expectedDuration == nil, source == .youtube, !track.id.hasPrefix("octave:") { fetchDuration(for: track) }
        currentIsVideoOnly = false
        if !track.hasSquareArtwork { resolveArtwork(for: track) }
        saveSession(force: true)

        loadTask = Task { [weak self] in
            guard let self else { return }
            do {
                if wasOctave { await self.octave.stop() }
                try Task.checkCancellation()
                if paused {
                    self.endLoadingBackgroundTask()
                    return
                }
                if self.source == .octave {
                    try await self.startOctave(track, at: startTime, session: session)
                    return
                }
                let recording: Track
                if track.id.hasPrefix("octave:") {
                    guard let found = try await OctaveCatalog.shared.youtubeRecording(track) else {
                        throw OctaveWebPlayer.Failure.notFound
                    }
                    recording = found
                } else { recording = track }
                let url = try await self.playableURL(for: recording)
                try Task.checkCancellation()
                try await self.start(url: url, track: track, at: startTime, transition: transition)
            } catch is CancellationError {
            } catch {
                guard !Task.isCancelled else { return }
                if self.source == .octave || track.id.hasPrefix("octave:") {
                    self.isLoading = false
                    self.isPlaying = false
                    self.endLoadingBackgroundTask()
                    self.errorMessage = self.source == .youtube ? "Cette version est introuvable sur YouTube Music." : error.localizedDescription
                    if let failure = error as? OctaveWebPlayer.Failure, failure == .connection || failure == .interaction {
                        self.octave.showAccount(loadSettings: false)
                        self.showsOctaveAccount = true
                    }
                    return
                }
                if transition != nil {
                    // Titre suivant illisible : on arrête l'ancien et on passe à la suite normalement.
                    self.crossfadeStarting = false
                    self.player.pause()
                    self.player.replaceCurrentItem(with: nil)
                }
                self.handleFailure(error, track: track)
            }
        }
        loadArtwork(for: track)
    }

    func switchSource(_ newSource: PlaybackSource) {
        if RemoteControl.shared.isActive {
            Task { await RemoteControl.shared.send(["action": "switchSource", "playbackSource": newSource.rawValue]) }
            return
        }
        preferredSource = newSource
        guard newSource != source || errorMessage != nil, current != nil else { return }
        let stayPaused = !isPlaying && !isLoading && errorMessage == nil
        errorMessage = nil
        load(resumeAt: currentTime, paused: stayPaused)
    }

    func openOctaveAccount() {
        pause()
        octave.showAccount(loadSettings: true)
        showsOctaveAccount = true
    }

    private func startOctave(_ track: Track, at position: Double, session: Int) async throws {
        guard let recording = try await OctaveCatalog.shared.recording(track) else { throw OctaveWebPlayer.Failure.notFound }
        try Task.checkCancellation()
        try? AVAudioSession.sharedInstance().setActive(true)
        let state = try await octave.start(recording, position: position)
        try Task.checkCancellation()
        guard octaveSession == session else { throw CancellationError() }
        octaveTrack = recording
        octaveSeekAt = position > 0 ? Date() : .distantPast
        autoplayQueue = []
        isLoading = false
        isPlaying = state.playing
        if position == 0, let elapsed = state.position, elapsed < 2 { currentTime = elapsed }
        if state.duration > 0 { duration = state.duration }
        endLoadingBackgroundTask()
        updateNowPlaying()
        prepareOctaveNext()
        observeOctave(session: session, audioID: state.audioId)
    }

    private func queueEdited(_ previous: Track?, force: Bool = false) {
        if force || previous?.id != upNext.first?.id { prepareOctaveNext(reset: true) }
        saveSession(force: true)
    }

    private func prepareOctaveNext(reset: Bool = false) {
        octavePreload?.cancel()
        if reset { octaveNext = nil }
        guard source == .octave, let current = octaveTrack else { return }
        let next = repeatMode == .one ? nil : upNext.first
        guard next != nil || reset else { return }
        let session = octaveSession
        octavePreload = Task { [weak self] in
            guard let self else { return }
            if reset { await octave.clearQueue() }
            guard let next, !Task.isCancelled, octaveSession == session,
                  let selected = try? await OctaveCatalog.shared.recording(next),
                  selected.id != current.id, !Task.isCancelled, octaveSession == session,
                  await octave.enqueue(selected), !Task.isCancelled, octaveSession == session else { return }
            octaveNext = (next, selected)
        }
    }

    private func observeOctave(session: Int, audioID: Int?) {
        octaveMonitor = Task { [weak self] in
            var heard = 0.0
            var recorded = false
            var endedAt: Date?
            var handoffAt: Date?
            var previousAudioID = audioID
            while !Task.isCancelled {
                try? await Task.sleep(for: .milliseconds(250))
                guard let self, !Task.isCancelled, octaveSession == session, let selected = octaveTrack else { return }
                guard let sample = await octave.sample(track: selected, next: upNext.first),
                      !Task.isCancelled, octaveSession == session else { continue }
                if let upcoming = sample.upcoming {
                    let tracks = upcoming.map(\.track)
                    if autoplayQueue != tracks { autoplayQueue = tracks }
                }
                if let mixing = sample.mixing { isTransitioning = mixing }
                if sample.blocked == "sign-in" {
                    await octave.stop()
                    isPlaying = false
                    octaveTrack = nil
                    octave.showAccount(loadSettings: false)
                    showsOctaveAccount = true
                    updateNowPlaying()
                    return
                }
                if sample.fading == true {
                    if let position = sample.outgoingPosition, position >= currentTime, position <= duration + 1 {
                        currentTime = position
                    }
                    isPlaying = sample.playing
                    updateNowPlaying()
                    continue
                }
                guard let position = sample.position else { continue }
                let previous = currentTime
                var changed = false
                let now = Date()
                if now.timeIntervalSince(octaveSeekAt) < 1 {
                    handoffAt = nil
                } else if sample.playing && sample.switchedAudio(previousID: previousAudioID, position: previous, duration: duration) {
                    handoffAt = now
                }
                if let handoffAtValue = handoffAt, now.timeIntervalSince(handoffAtValue) > 3.5 { handoffAt = nil }
                previousAudioID = sample.audioId ?? previousAudioID
                let next = upNext.first
                let nextRecording = octaveNext.flatMap { $0.original.id == next?.id ? $0.recording : nil } ?? next
                let plannedMatches = nextRecording.map { sample.matches($0) } ?? false
                if sample.playing, handoffAt != nil, plannedMatches || (!sample.title.isEmpty && !sample.matches(selected)) {
                    handoffAt = nil
                    if repeatMode != .one, let recording = nextRecording, plannedMatches {
                        index += 1
                        octaveTrack = recording
                    } else if hasNext || repeatMode != .off {
                        if repeatMode != .one { index = hasNext ? index + 1 : 0 }
                        load()
                        return
                    } else if let related = sample.track {
                        queue.append(related)
                        index = queue.count - 1
                        octaveTrack = related
                    } else { continue }
                    artwork = nil
                    if let current { loadArtwork(for: current) }
                    octaveNext = nil
                    prepareOctaveNext()
                    heard = 0
                    recorded = false
                    changed = true
                }
                if sample.playing || sample.buffering == true { endedAt = nil }
                else if sample.ended || (isPlaying && duration > 0 && duration - previous < 1.5) { endedAt = endedAt ?? Date() }
                currentTime = position
                if sample.duration > 0 { duration = sample.duration }
                isPlaying = sample.playing
                updateNowPlaying()
                if let endedAt, Date().timeIntervalSince(endedAt) > 2.5 {
                    if repeatMode == .one { load() }
                    else if hasNext || repeatMode == .all {
                        index = hasNext ? index + 1 : 0
                        load()
                    }
                    return
                }
                if !changed, handoffAt == nil, !recorded, sample.audible, position > previous, position - previous < 2 {
                    heard += position - previous
                    if heard >= 5, let current {
                        recorded = true
                        var entry = current
                        entry.artworkURL = entry.artworkURL ?? selected.artworkURL ?? sample.artwork
                        library.recordPlay(entry, addToHistory: PlaybackSettings.recordHistory, playlistID: playingPlaylistID)
                        recordOctaveHistory(current)
                    }
                }
                if Date().timeIntervalSince(lastSessionSave) > 15 { saveSession() }
            }
        }
    }

    private func recordOctaveHistory(_ track: Track) {
        guard PlaybackSettings.recordHistory, PlaybackSettings.syncOctaveToYouTube, account.isSignedIn else { return }
        Task {
            if let found = try? await OctaveCatalog.shared.youtubeRecording(track),
               PlaybackSettings.syncOctaveToYouTube, account.isSignedIn {
                try? await client.addToWatchHistory(videoID: found.id)
            }
        }
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

    private func start(url: URL, track: Track, at startTime: TimeInterval, transition: TimeInterval? = nil) async throws {
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
        try? AVAudioSession.sharedInstance().setActive(true)
        if let transition, player.currentItem != nil {
            // Transition : le titre suivant démarre en silence sur un second lecteur, puis monte.
            let incoming = AVPlayer()
            Self.configure(incoming)
            incoming.volume = 0
            incoming.replaceCurrentItem(with: item)
            incoming.play()
            do {
                for _ in 0..<100 {
                    try Task.checkCancellation()
                    if item.status == .failed { throw item.error ?? OctaveWebPlayer.Failure.unavailable }
                    if incoming.timeControlStatus == .playing && incoming.currentTime().seconds > 0 { break }
                    try await Task.sleep(for: .milliseconds(50))
                }
                try Task.checkCancellation()
                guard incoming.timeControlStatus == .playing, incoming.currentTime().seconds > 0,
                      current?.id == track.id else { throw OctaveWebPlayer.Failure.unavailable }
            } catch {
                incoming.pause()
                incoming.replaceCurrentItem(with: nil)
                throw error
            }
            runTransition(to: incoming, duration: transition)
        } else {
            crossfadeStarting = false
            isTransitioning = false
            currentGain = MixPlan.gain(for: knownAnalyses[track.id])
            player.volume = Float(currentGain)
            player.replaceCurrentItem(with: item)
            if startTime > 1 {
                player.seek(to: CMTime(seconds: startTime, preferredTimescale: 600)) { _ in }
            }
            // Démarre dès les premières secondes reçues, sans attendre un gros tampon.
            player.playImmediately(atRate: 1)
        }
        observeStatus(of: item, track: track)
        isPlaying = true
        isLoading = false
        failureCount = 0
        endLoadingBackgroundTask()
        library.recordPlay(track, addToHistory: PlaybackSettings.recordHistory, playlistID: playingPlaylistID)
        updateNowPlaying()
        prefetchNext()
    }

    private func observeStatus(of item: AVPlayerItem, track: Track) {
        statusObservation = item.observe(\.status, options: [.new]) { @Sendable [weak self] item, _ in
            let failed = item.status == .failed
            let error = item.error
            Task { @MainActor in
                guard let self, self.source == .youtube, failed, self.current?.id == track.id else { return }
                // Échec après le début du titre : on le relance là où il en était plutôt que de le sauter.
                if self.currentTime > 2 {
                    self.recoverPlayback(reason: "flux en échec")
                } else {
                    self.handleFailure(error ?? NovaError.noPlayableStream, track: track)
                }
            }
        }
    }

    private func handleFailure(_ error: Error, track: Track) {
        guard current?.id == track.id else { return }
        defer { if !isLoading { endLoadingBackgroundTask() } }
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
    /// Seulement le titre suivant (plus le processeur ne suit pas en arrière-plan), après un délai
    /// pour ne pas concurrencer le démarrage du titre en cours, et jamais en double.
    @ObservationIgnored private var prefetchTask: Task<Void, Never>?
    @ObservationIgnored private var prefetchTarget: String?

    /// Titre suivant changé (lecture d'un autre titre, file modifiée, aléatoire…) : on le prépare.
    private func upcomingChanged() {
        guard !RemoteControl.shared.isActive else { return }
        if source == .octave { return }
        let next = queue.indices.contains(index + 1) ? queue[index + 1].id : nil
        if next != prefetchTarget { prefetchNext() }
    }

    /// Le titre suivant est prêt bien avant la fin du titre en cours : lien du flux trouvé (prioritaire sur les
    /// téléchargements), puis fichier mis en cache. Le passage au titre suivant est alors immédiat.
    private func prefetchNext() {
        guard source == .youtube else { return }
        guard let next = queue.dropFirst(index + 1).first else {
            prefetchTask?.cancel()
            prefetchTarget = nil
            return
        }
        // Déjà en préparation : on ne recommence pas.
        if prefetchTarget == next.id, prefetchTask != nil { return }
        prefetchTask?.cancel()
        prefetchTarget = next.id
        guard downloads.localURL(for: next.id) == nil else { return }
        prefetchTask = Task.detached(priority: .utility) { [weak self] in
            // Quelques secondes pour laisser démarrer le titre en cours.
            try? await Task.sleep(for: .seconds(4))
            guard !Task.isCancelled, await !AudioCache.shared.contains(next.id) else { return }
            guard let stream = try? await StreamResolver.audioStream(for: next.id, urgency: .next) else {
                // Échec (réseau…) : la préparation pourra être relancée au prochain titre.
                await self?.prefetchFailed(next.id)
                return
            }
            guard stream.isM4A, !Task.isCancelled, NetworkMonitor.shared.allowsCaching else { return }
            await AudioCache.shared.store(remote: stream.url, id: next.id)
        }
    }

    private func prefetchFailed(_ id: String) {
        if prefetchTarget == id { prefetchTask = nil }
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
        // Transition en préparation : l'ancien titre joue encore, mais l'état est déjà celui du suivant.
        guard source == .youtube, !crossfadeStarting, player.currentItem != nil else { return }
        let seconds = time.seconds
        if seconds.isFinite, player.currentItem != nil { currentTime = seconds }
        let canMix = isPlaying && !isLoading && fadingOut == nil && pendingMix == nil && repeatMode != .one && hasNext
            && (JamSession.shared.role != .guest || !JamSession.shared.listenAlong)
        // AutoMix calé sur le tempo : les deux titres sont analysés, le suivant part sur un temps du titre en cours.
        if canMix, PlaybackSettings.transition != .off { refreshMixPlan() }
        if canMix, PlaybackSettings.transition == .automix, let current {
            if let plan = mixPlan, plan.outgoingID == current.id, queue[index + 1].id == plan.incomingID,
               currentTime >= plan.start - 3, currentTime < plan.start + plan.duration * 0.5 {
                prepareMix(plan)
                return
            }
        }
        let planned = mixPlan.map { $0.outgoingID == current?.id && currentTime < $0.start + $0.duration * 0.5 } ?? false
        // Sinon (titres pas encore analysés, fondu enchaîné) : le suivant démarre avant la fin de celui-ci,
        // la fin étant celle du dernier son entendu quand le titre est analysé.
        if canMix, !planned, let fade = PlaybackSettings.transitionDuration,
           let end = current.flatMap({ knownAnalyses[$0.id]?.audibleEnd }) ?? expectedDuration, end > fade * 3,
           currentTime >= end - fade, currentTime < end - 0.5 {
            beginTransition(fade)
            return
        }
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
        center.playCommand.addTarget { @Sendable [weak self] _ in
            Task { @MainActor in self?.resume() }
            return .success
        }
        center.pauseCommand.addTarget { @Sendable [weak self] _ in
            Task { @MainActor in self?.pause() }
            return .success
        }
        center.togglePlayPauseCommand.addTarget { @Sendable [weak self] _ in
            Task { @MainActor in self?.togglePlay() }
            return .success
        }
        center.nextTrackCommand.addTarget { @Sendable [weak self] _ in
            Task { @MainActor in self?.next() }
            return .success
        }
        center.previousTrackCommand.addTarget { @Sendable [weak self] _ in
            Task { @MainActor in self?.previous() }
            return .success
        }
        center.changePlaybackPositionCommand.addTarget { @Sendable [weak self] event in
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
            guard let image = await ImageLoader.load(track.artworkURLs(pixels: 1000), maxPixels: 1000) else { return }
            guard let self, self.current?.id == track.id else { return }
            self.artwork = Self.makeArtwork(image)
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
        var source: PlaybackSource?
    }

    @ObservationIgnored private let sessionURL = FileManager.default
        .urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
        .appendingPathComponent("Nova", isDirectory: true)
        .appendingPathComponent("session.json")

    /// Enregistre la file et la position pour les retrouver au prochain lancement.
    // MARK: Télécommande (lecture sur le PC)

    /// La lecture passe sur le PC : le lecteur local s'arrête, l'interface reflète désormais le PC.
    func enterRemote() async {
        saveSession(force: true)
        finishTransition()
        loadTask?.cancel()
        player.pause()
        octaveMonitor?.cancel()
        octavePreload?.cancel()
        if source == .octave { await octave.stop() }
        octaveTrack = nil
        isLoading = false
    }

    /// État du PC affiché dans le lecteur (et sur l'écran verrouillé, dont les boutons pilotent le PC).
    func mirrorRemote(_ state: RemoteControl.State) {
        guard RemoteControl.shared.isActive else { return }
        let newQueue = (state.track.map { [$0] } ?? []) + state.queue
        let trackChanged = newQueue.first?.id != current?.id
        if newQueue.map(\.id) != queue.map(\.id) {
            queue = newQueue
            index = 0
        }
        // Pochette du titre du PC sur l'écran verrouillé et dans le centre de contrôle.
        if trackChanged, let track = newQueue.first {
            artwork = nil
            loadArtwork(for: track)
        }
        isPlaying = state.playing
        source = state.source ?? (state.track?.id.hasPrefix("octave:") == true ? .octave : .youtube)
        isLoading = state.loading ?? false
        currentTime = state.time
        duration = state.duration
        isShuffled = state.shuffled ?? false
        repeatMode = state.repeat == "one" ? .one : state.repeat == "all" ? .all : .off
        updateNowPlaying()
    }

    /// Retour sur l'iPhone ; si le PC jouait, la lecture reprend ici au même endroit.
    func leaveRemote(resumeAt state: RemoteControl.State?) {
        if let state, let track = state.track {
            queue = [track] + state.queue
            index = 0
            player.replaceCurrentItem(with: nil)
            preferredSource = state.source ?? source
            load(resumeAt: state.time, paused: !state.playing)
        } else {
            player.replaceCurrentItem(with: nil)
            isPlaying = false
            updateNowPlaying()
        }
    }

    func saveSession(force: Bool = false) {
        if RemoteControl.shared.isActive { return }
        guard force || Date().timeIntervalSince(lastSessionSave) > 1 else { return }
        lastSessionSave = Date()
        // Très longue file : seuls les titres autour du titre en cours sont gardés, et l'écriture se fait hors du
        // fil principal (des milliers de titres réécrits toutes les 15 s ralentissaient l'app, écran verrouillé).
        let start = min(max(0, index - 100), queue.count), end = max(start, min(queue.count, index + 1500))
        let session = Session(queue: Array(queue[start..<end]), index: index - start, time: currentTime,
                              repeatMode: repeatMode, unshuffledQueue: unshuffledQueue.map { Array($0.prefix(3000)) },
                              source: preferredSource)
        sessionVersion += 1
        let version = sessionVersion, url = sessionURL
        Task.detached(priority: .utility) { await SessionWriter.shared.write(session, version: version, to: url) }
    }

    @ObservationIgnored private var sessionVersion = 0

    /// Écriture de la session, une à la fois, la plus récente seulement.
    private actor SessionWriter {
        static let shared = SessionWriter()
        private var written = 0

        func write<T: Encodable>(_ session: T, version: Int, to url: URL) {
            guard version > written, let data = try? JSONEncoder().encode(session) else { return }
            written = version
            try? FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
            try? data.write(to: url, options: .atomic)
        }
    }

    private func restoreSession() {
        guard let data = try? Data(contentsOf: sessionURL),
              let session = try? JSONDecoder().decode(Session.self, from: data),
              session.queue.indices.contains(session.index) else { return }
        queue = session.queue
        index = session.index
        preferredSource = session.source ?? .octave
        source = preferredSource
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

    /// Titre sans pochette carrée : la vraie pochette HD remplace la miniature vidéo, dans la file
    /// d'attente comme dans la bibliothèque.
    private func resolveArtwork(for track: Track) {
        Task { [weak self] in
            let found = await ArtworkResolver.shared.artwork(for: track.id)
            guard let self else { return }
            guard let found else {
                if self.current?.id == track.id, await ArtworkResolver.shared.isVideoOnly(track.id) {
                    self.currentIsVideoOnly = true
                }
                return
            }
            for position in self.queue.indices where self.queue[position].id == track.id {
                self.queue[position].artworkURL = found
            }
            self.library.updateArtwork(found, for: track.id)
        }
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
