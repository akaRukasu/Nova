import Foundation
import Observation

/// Playlists collaboratives : des playlists YouTube Music partagées entre amis (chacun avec son compte).
/// Nova les crée, les liste et y ajoute des titres ; la collaboration elle-même (« Collaborer », lien
/// d'invitation) est activée une fois dans YouTube Music, seul à le permettre.
@MainActor
@Observable
final class SharedPlaylists {
    static let shared = SharedPlaylists()

    struct Entry: Codable, Identifiable, Hashable {
        /// Identifiant de la playlist YouTube (sans « VL »).
        let id: String
        var title: String
        var artworkURL: URL?
        var isOwner: Bool
        var collection: MusicCollection {
            MusicCollection(id: "VL" + id, kind: .playlist, title: title,
                            subtitle: isOwner ? "Playlist partagée · créée par toi" : "Playlist partagée", artworkURL: artworkURL)
        }
        /// Page de la playlist dans YouTube Music (bouton « Collaborer » pour inviter).
        var youtubeURL: URL { URL(string: "https://music.youtube.com/playlist?list=\(id)")! }
    }

    private(set) var entries: [Entry] = []
    private let client = InnerTubeClient()

    private init() {
        if let data = UserDefaults.standard.data(forKey: "sharedPlaylists"),
           let saved = try? JSONDecoder().decode([Entry].self, from: data) {
            entries = saved
        }
    }

    private func persist() {
        if let data = try? JSONEncoder().encode(entries) { UserDefaults.standard.set(data, forKey: "sharedPlaylists") }
    }

    /// Nouvelle playlist partagée sur le compte YouTube.
    func create(title: String, tracks: [Track] = []) async throws -> Entry {
        let id = try await client.createAccountPlaylist(title: title, videoIDs: tracks.map(\.id))
        let entry = Entry(id: id, title: title, artworkURL: tracks.first?.artworkURL, isOwner: true)
        entries.insert(entry, at: 0)
        persist()
        return entry
    }

    /// Identifiant de playlist d'un lien YouTube / YouTube Music (lien d'invitation compris).
    static func playlistID(in text: String) -> String? {
        guard let start = text.range(of: "http"),
              let url = URL(string: String(text[start.lowerBound...]).components(separatedBy: .whitespacesAndNewlines)[0]),
              let list = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems?.first(where: { $0.name == "list" })?.value,
              !list.isEmpty else { return nil }
        return list
    }

    /// Ajoute une playlist rejointe (après l'avoir acceptée dans YouTube Music).
    func add(id: String) async {
        guard !entries.contains(where: { $0.id == id }) else { return }
        var entry = Entry(id: id, title: "Playlist partagée", artworkURL: nil, isOwner: false)
        if let page = try? await client.collection("VL" + id) {
            entry.title = page.header.title.isEmpty ? entry.title : page.header.title
            entry.artworkURL = page.header.artworkURL ?? page.tracks.first?.artworkURL
        }
        entries.insert(entry, at: 0)
        persist()
    }

    func remove(_ entry: Entry) {
        entries.removeAll { $0.id == entry.id }
        persist()
    }

    /// Ajout de titres : ils apparaissent chez tous les participants.
    func add(_ tracks: [Track], to entry: Entry) async throws {
        for track in tracks { try await client.addToAccountPlaylist(entry.id, videoID: track.id) }
        if entry.artworkURL == nil, let index = entries.firstIndex(of: entry) {
            entries[index].artworkURL = tracks.first?.artworkURL
            persist()
        }
    }
}
