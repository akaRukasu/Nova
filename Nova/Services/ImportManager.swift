import Foundation
import MediaPlayer
import Observation

/// Importe des playlists venues d'ailleurs : chaque titre est retrouvé sur YouTube Music,
/// puis la playlist est créée dans la bibliothèque de Nova.
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
        var error: String?

        var progress: Double { total > 0 ? Double(processed) / Double(total) : 0 }
    }

    private(set) var jobs: [Job] = []
    /// Jeton de l'API web Spotify, récupéré à la connexion (valable environ une heure).
    var spotifyToken: String?

    @ObservationIgnored private let client = InnerTubeClient()

    var isRunning: Bool { jobs.contains { !$0.isFinished } }

    func start(_ playlists: [ImportedPlaylist], into library: LibraryStore) {
        for playlist in playlists {
            let job = Job(name: playlist.name, source: playlist.source.components(separatedBy: ":").first ?? playlist.source,
                          total: playlist.count)
            jobs.insert(job, at: 0)
            let id = job.id
            Task { await run(playlist, jobID: id, library: library) }
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
            update(jobID) { $0.total = tracks.count }
            var results = [Track?](repeating: nil, count: tracks.count)
            let client = self.client
            await withTaskGroup(of: (Int, Track?).self) { group in
                let parallel = min(4, tracks.count)
                for index in 0..<parallel {
                    group.addTask { (index, await TrackMatcher.match(tracks[index], client: client)) }
                }
                var nextIndex = parallel
                for await (index, match) in group {
                    results[index] = match
                    update(jobID) { job in
                        job.processed += 1
                        if match != nil { job.matched += 1 } else { job.missing.append(tracks[index]) }
                    }
                    if nextIndex < tracks.count {
                        let next = nextIndex
                        group.addTask { (next, await TrackMatcher.match(tracks[next], client: client)) }
                        nextIndex += 1
                    }
                }
            }
            found = results.compactMap { $0 }
        }

        if playlist.isLiked {
            library.addLiked(found)
        } else if !found.isEmpty {
            library.upsertPlaylist(name: playlist.name, tracks: found)
        }
        update(jobID) { $0.isFinished = true }
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
