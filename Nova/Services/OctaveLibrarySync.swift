import Foundation
import Observation

@MainActor @Observable
final class OctaveLibrarySync {
    struct Status: Decodable {
        var connected: Bool
        var pending: Bool
        var tracks: Int
        var albums: Int
        var artists: Int
        var updatedAt: Double
        var playlists: Int?
        var libraryAlbums: Int?
        var libraryArtists: Int?
    }
    private struct Addition: Codable {
        var key: String
        var track: Track?
        var album: MusicCollection?
        var octaveDone: Bool?
        var youtubeDone: Bool?
    }
    private struct Entry: Decodable {
        var id: String
        var title: String
        var artist: String
        var album: String?
        var albumId: String?
        var artistId: String?
        var duration: Double?
        var artwork: URL?
        var track: Track { Track(id: id, title: title, artist: artist, album: album, duration: duration,
            artworkURL: artwork, artistID: artistId, albumID: albumId) }
    }
    private(set) var busy = false
    private(set) var pending = 0
    private(set) var youtubePending = 0
    private(set) var status: Status?
    private(set) var error: String?
    @ObservationIgnored private weak var player: OctaveWebPlayer?
    @ObservationIgnored private var timer: Task<Void, Never>?
    @ObservationIgnored private var syncingYouTube = false
    @ObservationIgnored private var outbox: [Addition] = []
    private let file = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
        .appendingPathComponent("Nova/octave-library-outbox.json")

    init() {
        if let data = try? Data(contentsOf: file), let entries = try? JSONDecoder().decode([Addition].self, from: data) {
            outbox = entries
            pending = entries.filter { $0.octaveDone != true }.count
            youtubePending = entries.filter { $0.youtubeDone != true }.count
        }
    }

    func start(using player: OctaveWebPlayer) {
        self.player = player
        guard timer == nil else { return }
        timer = Task { [weak self] in
            await self?.refresh()
            while !Task.isCancelled {
                try? await Task.sleep(for: .seconds(30))
                guard let self, !Task.isCancelled else { return }
                await refresh()
            }
        }
    }

    func enqueue(track: Track?, album: MusicCollection?) {
        guard track?.id.hasPrefix("local:") != true, track != nil || album?.kind == .album else { return }
        let key = track.map { "track:" + $0.id } ?? "album:" + (album?.id ?? "")
        if !outbox.contains(where: { $0.key == key }) {
            outbox.append(Addition(key: key, track: track, album: album))
            persist()
        }
        Task { await refresh() }
    }

    func cancel(track: Track?, album: MusicCollection?) {
        let key = track.map { "track:" + $0.id } ?? "album:" + (album?.id ?? "")
        guard outbox.contains(where: { $0.key == key }) else { return }
        outbox.removeAll { $0.key == key }
        persist()
    }

    private func persist() {
        outbox.removeAll { $0.octaveDone == true && $0.youtubeDone == true }
        pending = outbox.filter { $0.octaveDone != true }.count
        youtubePending = outbox.filter { $0.youtubeDone != true }.count
        do {
            try FileManager.default.createDirectory(at: file.deletingLastPathComponent(), withIntermediateDirectories: true)
            try JSONEncoder().encode(outbox).write(to: file, options: .atomic)
        } catch { self.error = "La synchronisation Octave ne peut pas être enregistrée sur cet appareil." }
    }

    private func run(_ operation: String, _ args: [String: Any] = [:]) async throws -> Status {
        guard let player else { throw URLError(.notConnectedToInternet) }
        var start: [String: Any]?
        for _ in 0..<30 {
            start = await player.libraryCall(args.merging(["operation": operation]) { _, new in new }) as? [String: Any]
            if start?["job"] != nil { break }
            try await Task.sleep(for: .milliseconds(300))
        }
        guard let job = start?["job"] else { throw failure("Ouvre Compte Octave pour connecter la bibliothèque.") }
        for _ in 0..<180 {
            try await Task.sleep(for: .milliseconds(200))
            guard let result = await player.libraryCall(["operation": "result", "job": job]) as? [String: Any],
                  result["running"] as? Bool != true else { continue }
            if let message = result["error"] as? String { throw failure(message) }
            guard let raw = result["value"], JSONSerialization.isValidJSONObject(raw) else { throw failure("Bibliothèque Octave indisponible.") }
            return try JSONDecoder().decode(Status.self, from: JSONSerialization.data(withJSONObject: raw))
        }
        throw failure("Octave n’a pas encore confirmé la synchronisation. Les ajouts sont conservés.")
    }

    private func failure(_ message: String) -> NSError {
        NSError(domain: "OctaveLibrary", code: 1, userInfo: [NSLocalizedDescriptionKey: message])
    }

    func syncYouTube() async {
        guard !syncingYouTube, AuthSession.shared.isSignedIn else { return }
        syncingYouTube = true
        defer { syncingYouTube = false }
        let client = InnerTubeClient()
        for item in outbox.filter({ $0.youtubeDone != true }).prefix(20) {
            do {
                if let track = item.track {
                    guard let recording = try await OctaveCatalog.shared.youtubeRecording(track),
                          recording.id.range(of: #"^[\w-]{11}$"#, options: .regularExpression) != nil,
                          outbox.contains(where: { $0.key == item.key }), AuthSession.shared.isSignedIn else { continue }
                    try await client.setLiked(true, videoID: recording.id)
                } else if let album = item.album {
                    var id = album.id.hasPrefix("MPREb") ? album.id : nil
                    if id == nil {
                        let tracks = try await OctaveCatalog.shared.collection(album).tracks
                        for var track in tracks.prefix(3) {
                            track.youtubeID = nil // Rechercher aussi l'identifiant de l'album côté YouTube.
                            if let recording = try await OctaveCatalog.shared.youtubeRecording(track),
                               let albumID = recording.albumID, albumID.hasPrefix("MPREb"),
                               OctaveCatalog.normalize(recording.album ?? "") == OctaveCatalog.normalize(album.title) {
                                id = albumID
                                break
                            }
                        }
                    }
                    guard let id, outbox.contains(where: { $0.key == item.key }), AuthSession.shared.isSignedIn else { continue }
                    try await client.saveAlbum(id)
                }
                if let position = outbox.firstIndex(where: { $0.key == item.key }) { outbox[position].youtubeDone = true; persist() }
            } catch { /* Le compte ou sa correspondance peut redevenir disponible au prochain essai. */ }
        }
    }

    func refresh() async {
        Task { await syncYouTube() }
        guard !busy, let player else { return }
        busy = true
        error = nil
        defer { busy = false }
        do {
            var state = try await run("refresh")
            var tracks: [Track] = []
            let changed = status?.updatedAt != state.updatedAt
            for offset in stride(from: 0, to: changed ? state.tracks : 0, by: 300) {
                if let page = await player.libraryCall(["operation": "page", "offset": offset]) as? [String: Any],
                   let raw = page["tracks"], JSONSerialization.isValidJSONObject(raw),
                   let entries = try? JSONDecoder().decode([Entry].self, from: JSONSerialization.data(withJSONObject: raw)) {
                    tracks.append(contentsOf: entries.map(\.track))
                }
            }
            if changed { await OctaveCatalog.shared.setLibraryRecordings(state.connected ? tracks : []) }
            status = state
            for item in outbox.filter({ $0.octaveDone != true }).prefix(20) {
                guard state.connected, outbox.contains(where: { $0.key == item.key }) else { break }
                if let track = item.track {
                    guard let recording = try await OctaveCatalog.shared.recording(track), let albumID = recording.albumID else {
                        throw failure("Ajout conservé : « \(track.title) » doit encore être identifié dans Octave.")
                    }
                    state = try await run("add", ["tracks": [["id": recording.id, "albumId": albumID]]])
                } else if let album = item.album {
                    var id = OctaveCatalog.id(album.id) != nil ? album.id : nil
                    if id == nil {
                        let page = try await InnerTubeClient().collection(album.id)
                        if let first = page.tracks.first, let recording = try await OctaveCatalog.shared.recording(first),
                           OctaveCatalog.normalize(recording.album ?? "") == OctaveCatalog.normalize(album.title) {
                            id = recording.albumID
                        }
                    }
                    guard let id else { throw failure("Ajout conservé : cet album doit encore être identifié dans Octave.") }
                    state = try await run("add", ["albums": [id]])
                }
                status = state
                if state.pending { break }
                if let position = outbox.firstIndex(where: { $0.key == item.key }) { outbox[position].octaveDone = true; persist() }
            }
        } catch { self.error = error.localizedDescription }
    }
}
