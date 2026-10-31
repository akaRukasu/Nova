import Foundation
import Observation

/// Bibliothèque locale : historique, titres likés, playlists, pages enregistrées, recherches.
@MainActor
@Observable
final class LibraryStore {
    private(set) var recents: [Track] = []
    private(set) var liked: [Track] = []
    private(set) var playlists: [UserPlaylist] = []
    private(set) var saved: [MusicCollection] = []
    private(set) var searches: [String] = []
    private var likedIDs: Set<String> = []
    private var savedIDs: Set<String> = []

    private struct Snapshot: Codable {
        var recents: [Track]?
        var liked: [Track]?
        var playlists: [UserPlaylist]?
        var saved: [MusicCollection]?
        var searches: [String]?
    }

    @ObservationIgnored private let directory: URL = FileManager.default
        .urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
        .appendingPathComponent("Nova", isDirectory: true)
    private var fileURL: URL { directory.appendingPathComponent("library.json") }

    init() {
        if let data = try? Data(contentsOf: fileURL),
           let snapshot = try? JSONDecoder().decode(Snapshot.self, from: data) {
            recents = snapshot.recents ?? []
            liked = snapshot.liked ?? []
            playlists = snapshot.playlists ?? []
            saved = snapshot.saved ?? []
            searches = snapshot.searches ?? []
        } else if let data = try? Data(contentsOf: directory.appendingPathComponent("recents.json")),
                  let old = try? JSONDecoder().decode([Track].self, from: data) {
            // Historique de l'étape 1.
            recents = old
        }
        likedIDs = Set(liked.map(\.id))
        savedIDs = Set(saved.map(\.id))
    }

    // MARK: Historique

    func addRecent(_ track: Track) {
        recents.removeAll { $0.id == track.id }
        recents.insert(track, at: 0)
        if recents.count > 200 { recents.removeLast(recents.count - 200) }
        save()
    }

    func removeRecents(at offsets: IndexSet) {
        recents.remove(atOffsets: offsets)
        save()
    }

    func clearRecents() {
        recents = []
        save()
    }

    // MARK: Titres likés

    func isLiked(_ id: String) -> Bool { likedIDs.contains(id) }

    /// Renvoie le nouvel état.
    @discardableResult
    func toggleLike(_ track: Track) -> Bool {
        if likedIDs.contains(track.id) {
            liked.removeAll { $0.id == track.id }
            likedIDs.remove(track.id)
            save()
            return false
        }
        liked.insert(track, at: 0)
        likedIDs.insert(track.id)
        save()
        return true
    }

    /// Ajoute des titres importés aux titres likés.
    func addLiked(_ tracks: [Track]) {
        let fresh = tracks.filter { likedIDs.insert($0.id).inserted }
        liked.insert(contentsOf: fresh, at: 0)
        save()
    }

    func removeLiked(at offsets: IndexSet) {
        liked.remove(atOffsets: offsets)
        likedIDs = Set(liked.map(\.id))
        save()
    }

    // MARK: Playlists

    func playlist(_ id: UUID) -> UserPlaylist? {
        playlists.first { $0.id == id }
    }

    @discardableResult
    func createPlaylist(name: String, tracks: [Track] = []) -> UUID {
        let playlist = UserPlaylist(name: name, tracks: tracks)
        playlists.insert(playlist, at: 0)
        save()
        return playlist.id
    }

    func renamePlaylist(_ id: UUID, to name: String) {
        edit(id) { $0.name = name }
    }

    func deletePlaylist(_ id: UUID) {
        playlists.removeAll { $0.id == id }
        save()
    }

    func deletePlaylists(at offsets: IndexSet) {
        playlists.remove(atOffsets: offsets)
        save()
    }

    func add(_ tracks: [Track], to id: UUID) {
        edit(id) { playlist in
            let known = Set(playlist.tracks.map(\.id))
            playlist.tracks += tracks.filter { !known.contains($0.id) }
        }
    }

    func removeTracks(at offsets: IndexSet, from id: UUID) {
        edit(id) { $0.tracks.remove(atOffsets: offsets) }
    }

    func moveTracks(from source: IndexSet, to destination: Int, in id: UUID) {
        edit(id) { $0.tracks.move(fromOffsets: source, toOffset: destination) }
    }

    private func edit(_ id: UUID, _ change: (inout UserPlaylist) -> Void) {
        guard let index = playlists.firstIndex(where: { $0.id == id }) else { return }
        change(&playlists[index])
        save()
    }

    // MARK: Pages enregistrées

    func isSaved(_ id: String) -> Bool { savedIDs.contains(id) }

    func toggleSaved(_ collection: MusicCollection) {
        if savedIDs.contains(collection.id) {
            saved.removeAll { $0.id == collection.id }
            savedIDs.remove(collection.id)
        } else {
            saved.insert(collection, at: 0)
            savedIDs.insert(collection.id)
        }
        save()
    }

    func removeSaved(at offsets: IndexSet) {
        saved.remove(atOffsets: offsets)
        savedIDs = Set(saved.map(\.id))
        save()
    }

    // MARK: Recherches

    func addSearch(_ query: String) {
        let text = query.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { return }
        searches.removeAll { $0.caseInsensitiveCompare(text) == .orderedSame }
        searches.insert(text, at: 0)
        if searches.count > 30 { searches.removeLast(searches.count - 30) }
        save()
    }

    func clearSearches() {
        searches = []
        save()
    }

    // MARK: Disque

    private func save() {
        let snapshot = Snapshot(recents: recents, liked: liked, playlists: playlists, saved: saved, searches: searches)
        do {
            try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
            try JSONEncoder().encode(snapshot).write(to: fileURL, options: .atomic)
        } catch {
            // Pas bloquant : la bibliothèque sera réécrite au prochain changement.
        }
    }
}
