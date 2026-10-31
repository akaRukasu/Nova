import AVFoundation
import MediaPlayer
import Observation
import UIKit

/// Lecture, file d'attente, écran verrouillé et centre de contrôle.
@MainActor
@Observable
final class PlayerModel {
    // MARK: État visible

    private(set) var queue: [Track] = []
    private(set) var index: Int = 0
    private(set) var isPlaying = false
    private(set) var isLoading = false
    private(set) var currentTime: TimeInterval = 0
    private(set) var duration: TimeInterval = 0
    var errorMessage: String?

    let library = LibraryStore()

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

    init() {
        configureAudioSession()
        configureRemoteCommands()
        player.automaticallyWaitsToMinimizeStalling = true

        timeObserver = player.addPeriodicTimeObserver(forInterval: CMTime(seconds: 0.5, preferredTimescale: 600), queue: .main) { [weak self] time in
            Task { @MainActor in self?.tick(time) }
        }
        NotificationCenter.default.addObserver(forName: AVPlayerItem.didPlayToEndTimeNotification, object: nil, queue: .main) { [weak self] note in
            let item = note.object as AnyObject?
            Task { @MainActor in
                guard let self, item === self.player.currentItem else { return }
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
    func play(_ tracks: [Track], startAt start: Int) {
        guard tracks.indices.contains(start) else { return }
        queue = tracks
        index = start
        load()
        if tracks.count - start <= 1 { extendWithRadio(from: tracks[start]) }
    }

    func startRadio(from track: Track) {
        play([track], startAt: 0)
    }

    func playNext(_ track: Track) {
        guard current != nil else { play([track], startAt: 0); return }
        queue.removeAll { $0.id == track.id && $0.id != current?.id }
        queue.insert(track, at: min(index + 1, queue.count))
    }

    func enqueue(_ track: Track) {
        guard current != nil else { play([track], startAt: 0); return }
        queue.append(track)
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
    }

    func moveInQueue(from source: IndexSet, to destination: Int) {
        let base = index + 1
        var upcoming = upNext
        upcoming.move(fromOffsets: source, toOffset: destination)
        queue.replaceSubrange(base..., with: upcoming)
    }

    func togglePlay() {
        isPlaying ? pause() : resume()
    }

    func resume() {
        guard current != nil else { return }
        if player.currentItem == nil { load(); return }
        try? AVAudioSession.sharedInstance().setActive(true)
        player.play()
        isPlaying = true
        updateNowPlaying()
    }

    func pause() {
        player.pause()
        isPlaying = false
        updateNowPlaying()
    }

    func next() {
        guard hasNext else {
            if let current { extendWithRadio(from: current, thenAdvance: true) }
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
        let target = CMTime(seconds: max(0, seconds), preferredTimescale: 600)
        currentTime = max(0, seconds)
        player.seek(to: target, toleranceBefore: .zero, toleranceAfter: .zero) { [weak self] _ in
            Task { @MainActor in self?.updateNowPlaying() }
        }
    }

    // MARK: Chargement

    private func load() {
        guard let track = current else { return }
        loadTask?.cancel()
        statusObservation = nil
        player.pause()
        player.replaceCurrentItem(with: nil)
        isLoading = true
        isPlaying = false
        currentTime = 0
        duration = track.duration ?? 0
        artwork = nil
        updateNowPlaying()

        loadTask = Task { [weak self] in
            guard let self else { return }
            do {
                let url = try await self.playableURL(for: track)
                try Task.checkCancellation()
                self.start(url: url, track: track)
            } catch is CancellationError {
            } catch {
                guard !Task.isCancelled else { return }
                self.handleFailure(error, track: track)
            }
        }
        loadArtwork(for: track)
    }

    private func playableURL(for track: Track) async throws -> URL {
        if let local = await AudioCache.shared.localURL(for: track.id) { return local }
        let stream = try await StreamResolver.audioStream(for: track.id)
        if stream.isM4A {
            Task.detached(priority: .utility) { await AudioCache.shared.store(remote: stream.url, id: track.id) }
        }
        return stream.url
    }

    private func start(url: URL, track: Track) {
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
        try? AVAudioSession.sharedInstance().setActive(true)
        player.play()
        isPlaying = true
        isLoading = false
        failureCount = 0
        library.addRecent(track)
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
        if hasNext {
            index += 1
            load()
        } else if let current {
            extendWithRadio(from: current, thenAdvance: true)
        }
    }

    /// Prépare le titre suivant dans le cache pour un enchaînement instantané.
    private func prefetchNext() {
        guard hasNext else { return }
        let next = queue[index + 1]
        Task.detached(priority: .background) {
            guard await !AudioCache.shared.contains(next.id),
                  let stream = try? await StreamResolver.audioStream(for: next.id),
                  stream.isM4A else { return }
            await AudioCache.shared.store(remote: stream.url, id: next.id)
        }
    }

    private func extendWithRadio(from seed: Track, thenAdvance: Bool = false) {
        Task { [weak self] in
            guard let self, let radio = try? await self.client.radio(for: seed.id) else { return }
            let known = Set(self.queue.map(\.id))
            let fresh = radio.filter { !known.contains($0.id) }
            guard !fresh.isEmpty else { return }
            self.queue.append(contentsOf: fresh)
            if thenAdvance, self.current?.id == seed.id { self.next() } else { self.prefetchNext() }
        }
    }

    // MARK: Temps

    private func tick(_ time: CMTime) {
        let seconds = time.seconds
        if seconds.isFinite { currentTime = seconds }
        if let itemDuration = player.currentItem?.duration.seconds, itemDuration.isFinite, itemDuration > 0 {
            if abs(itemDuration - duration) > 0.5 {
                duration = itemDuration
                updateNowPlaying()
            }
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
            guard let image = await ImageLoader.load(track.videoThumbnailURLs) else { return }
            guard let self, self.current?.id == track.id else { return }
            self.artwork = MPMediaItemArtwork(boundsSize: image.size) { _ in image }
            self.updateNowPlaying()
        }
    }
}
