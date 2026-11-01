import Foundation
import MediaPlayer
import Observation
import UIKit

/// Importe des playlists venues d'ailleurs : chaque titre est retrouvé sur YouTube Music,
/// puis la playlist est créée (ou remplacée) dans la bibliothèque de Nova.
@MainActor
@Observable
final class ImportManager {
    struct Job: Identifiable {
        let id = UUID()
        var name: String
        var source: String
        var total: Int
        var processed = 0
        var matched = 0
        var missing: [ImportedTrack] = []
        var isFinished = false
        var isCancelled = false
        var error: String?
        /// Playlist Nova créée, ou titres likés.
        var playlistID: UUID?
        var isLiked = false
        var startedAt = Date()

        var progress: Double { total > 0 ? Double(processed) / Double(total) : 0 }

        /// Temps restant estimé, d'après le rythme actuel.
        var remaining: TimeInterval? {
            guard processed >= 10, processed < total else { return nil }
            let rate = Date().timeIntervalSince(startedAt) / Double(processed)
            return rate * Double(total - processed)
        }
    }

    private(set) var jobs: [Job] = []
    /// Jeton de l'API web Spotify, récupéré à la connexion (valable environ une heure).
    var spotifyToken: String?

    @ObservationIgnored private let client = InnerTubeClient()
    @ObservationIgnored private var tasks: [UUID: Task<Void, Never>] = [:]
    @ObservationIgnored private var backgroundTask: UIBackgroundTaskIdentifier = .invalid
    /// Recherches en parallèle (YouTube Music tolère bien ce rythme).
    private let parallel = 6

    var isRunning: Bool { jobs.contains { !$0.isFinished } }

    func job(_ id: UUID) -> Job? { jobs.first { $0.id == id } }

    func start(_ playlists: [ImportedPlaylist], into library: LibraryStore) {
        beginBackgroundTime()
        for playlist in playlists {
            let job = Job(name: playlist.name, source: playlist.source.components(separatedBy: ":").first ?? playlist.source,
                          total: playlist.count, isLiked: playlist.isLiked)
            jobs.insert(job, at: 0)
            let id = job.id
            tasks[id] = Task { await run(playlist, jobID: id, library: library) }
        }
    }

    func cancel(_ id: UUID) {
        tasks[id]?.cancel()
        update(id) {
            $0.isCancelled = true
            $0.isFinished = true
        }
    }

    func clearFinished() {
        jobs.removeAll { $0.isFinished }
    }

    private func update(_ id: UUID, _ change: (inout Job) -> Void) {
        guard let index = jobs.firstIndex(where: { $0.id == id }) else { return }
        change(&jobs[index])
    }

    private func run(_ source: ImportedPlaylist, jobID: UUID, library: LibraryStore) async {
        var playlist = source
        do {
            if playlist.tracks.isEmpty, playlist.youTubeTracks == nil {
                playlist.tracks = try await loadTracks(of: playlist)
            }
        } catch {
            update(jobID) {
                $0.error = error.localizedDescription
                $0.isFinished = true
            }
            finishIfIdle()
            return
        }

        var found: [Track] = []
        if let tracks = playlist.youTubeTracks {
            found = tracks
            update(jobID) {
                $0.total = tracks.count
                $0.processed = tracks.count
                $0.matched = tracks.count
            }
        } else {
            let tracks = playlist.tracks
            update(jobID) {
                $0.total = tracks.count
                $0.startedAt = Date()
            }
            found = await match(tracks, jobID: jobID)
        }
        guard job(jobID)?.isCancelled != true else { finishIfIdle(); return }

        if playlist.isLiked {
            library.addLiked(found)
        } else if !found.isEmpty {
            let playlistID = library.upsertPlaylist(name: playlist.name, tracks: found)
            update(jobID) { $0.playlistID = playlistID }
        }
        update(jobID) { $0.isFinished = true }
        await MatchCache.shared.flush()
        finishIfIdle()
    }

    /// Recherche les titres (dans l'ordre), `parallel` à la fois, en mettant à jour l'avancement.
    private func match(_ tracks: [ImportedTrack], jobID: UUID) async -> [Track] {
        var results = [Track?](repeating: nil, count: tracks.count)
        let client = self.client
        let width = parallel
        await withTaskGroup(of: (Int, Track?).self) { group in
            let first = min(width, tracks.count)
            for index in 0..<first {
                group.addTask { (index, await TrackMatcher.match(tracks[index], client: client)) }
            }
            var nextIndex = first
            for await (index, match) in group {
                results[index] = match
                update(jobID) { job in
                    job.processed += 1
                    if match != nil { job.matched += 1 } else { job.missing.append(tracks[index]) }
                }
                if job(jobID)?.isCancelled == true {
                    group.cancelAll()
                    break
                }
                if nextIndex < tracks.count {
                    let next = nextIndex
                    group.addTask { (next, await TrackMatcher.match(tracks[next], client: client)) }
                    nextIndex += 1
                }
            }
        }
        return results.compactMap { $0 }
    }

    /// Relance la recherche des titres introuvables (le réseau ou YouTube ont pu échouer).
    func retryMissing(_ id: UUID, library: LibraryStore) {
        guard let current = job(id), !current.missing.isEmpty else { return }
        let missing = current.missing
        update(id) {
            $0.missing = []
            $0.isFinished = false
            $0.total = $0.matched + missing.count
            $0.processed = $0.matched
            $0.startedAt = Date()
        }
        beginBackgroundTime()
        tasks[id] = Task {
            let found = await match(missing, jobID: id)
            add(found, toJob: id, library: library)
            update(id) { $0.isFinished = true }
            await MatchCache.shared.flush()
            finishIfIdle()
        }
    }

    /// Correction à la main : le titre choisi remplace l'introuvable.
    func resolve(_ missing: ImportedTrack, with track: Track, inJob id: UUID, library: LibraryStore) {
        add([track], toJob: id, library: library)
        update(id) { job in
            if let index = job.missing.firstIndex(of: missing) { job.missing.remove(at: index) }
            job.matched += 1
        }
        Task { await MatchCache.shared.store(track, for: missing); await MatchCache.shared.flush() }
    }

    private func add(_ tracks: [Track], toJob id: UUID, library: LibraryStore) {
        guard !tracks.isEmpty, let job = job(id) else { return }
        if job.isLiked {
            library.addLiked(tracks)
        } else if let playlistID = job.playlistID {
            library.add(tracks, to: playlistID)
        } else {
            let playlistID = library.upsertPlaylist(name: job.name, tracks: tracks)
            update(id) { $0.playlistID = playlistID }
        }
    }

    // MARK: Arrière-plan

    /// Demande à iOS quelques instants de plus quand l'app passe en arrière-plan pendant un import.
    private func beginBackgroundTime() {
        guard backgroundTask == .invalid else { return }
        backgroundTask = UIApplication.shared.beginBackgroundTask(withName: "Import Nova") { [weak self] in
            Task { @MainActor in self?.endBackgroundTime() }
        }
    }

    private func finishIfIdle() {
        if !isRunning { endBackgroundTime() }
    }

    private func endBackgroundTime() {
        guard backgroundTask != .invalid else { return }
        UIApplication.shared.endBackgroundTask(backgroundTask)
        backgroundTask = .invalid
    }

    /// Titres d'une playlist annoncée par un compte (chargés au moment de l'import).
    private func loadTracks(of playlist: ImportedPlaylist) async throws -> [ImportedTrack] {
        let parts = playlist.source.split(separator: ":", maxSplits: 1).map(String.init)
        guard parts.count == 2 else { throw ImportError.nothingFound }
        switch parts[0] {
        case "Spotify":
            guard let token = spotifyToken else { throw ImportError.http(401, "Spotify") }
            return try await ImportSources.spotifyPlaylistTracks(id: parts[1], token: token)
        case "Deezer":
            return try await ImportSources.deezerPlaylistTracks(id: parts[1])
        default:
            throw ImportError.nothingFound
        }
    }

    // MARK: - Apple Music (bibliothèque de l'iPhone)

    static func appleMusicLibrary() async throws -> [ImportedPlaylist] {
        let status = await withCheckedContinuation { continuation in
            MPMediaLibrary.requestAuthorization { continuation.resume(returning: $0) }
        }
        guard status == .authorized else { throw AppleMusicError.denied }

        func imported(_ items: [MPMediaItem]) -> [ImportedTrack] {
            items.compactMap { item in
                guard let title = item.title, !title.isEmpty else { return nil }
                return ImportedTrack(title: title, artist: item.artist ?? "", album: item.albumTitle,
                                     duration: item.playbackDuration > 0 ? item.playbackDuration : nil)
            }
        }

        var playlists: [ImportedPlaylist] = []
        for collection in MPMediaQuery.playlists().collections ?? [] {
            guard let playlist = collection as? MPMediaPlaylist else { continue }
            let tracks = imported(playlist.items)
            guard !tracks.isEmpty else { continue }
            playlists.append(ImportedPlaylist(name: playlist.name ?? "Playlist Apple Music", source: "Apple Music", tracks: tracks))
        }
        let songs = imported(MPMediaQuery.songs().items ?? [])
        if !songs.isEmpty {
            playlists.insert(ImportedPlaylist(name: "Bibliothèque Apple Music", source: "Apple Music", tracks: songs), at: 0)
        }
        guard !playlists.isEmpty else { throw AppleMusicError.empty }
        return playlists
    }

    enum AppleMusicError: LocalizedError {
        case denied, empty

        var errorDescription: String? {
            switch self {
            case .denied: return "Autorise Nova à accéder à ta bibliothèque dans Réglages › Nova › Musique et vidéo."
            case .empty: return "Aucune playlist ni aucun titre dans la bibliothèque Apple Music de cet iPhone."
            }
        }
    }
}
