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
    private(set) var smartPlaylists: [SmartPlaylist] = []
    private(set) var stats: [String: TrackStats] = [:]
    /// Tous les morceaux de la bibliothèque (likés, playlists, historique), sans doublons.
    private(set) var songs: [Track] = []
    private var likedIDs: Set<String> = []
    private var savedIDs: Set<String> = []

    private struct Snapshot: Codable {
        var recents: [Track]?
        var liked: [Track]?
        var playlists: [UserPlaylist]?
        var saved: [MusicCollection]?
        var searches: [String]?
        var smartPlaylists: [SmartPlaylist]?
        var stats: [String: TrackStats]?
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
            smartPlaylists = snapshot.smartPlaylists ?? []
            stats = snapshot.stats ?? [:]
        } else if let data = try? Data(contentsOf: directory.appendingPathComponent("recents.json")),
                  let old = try? JSONDecoder().decode([Track].self, from: data) {
            // Historique de l'étape 1.
            recents = old
        }
        likedIDs = Set(liked.map(\.id))
        savedIDs = Set(saved.map(\.id))
        rebuildSongs()
    }

    // MARK: Morceaux

    /// Regroupe les titres likés et ceux des playlists, sans doublons
    /// (même identifiant, ou même titre et même artiste).
    private func rebuildSongs() {
        var seenIDs = Set<String>()
        var seenKeys = Set<String>()
        var result: [Track] = []
        func include(_ track: Track) {
            let key = LibraryStore.dedupeKey(track)
            guard seenIDs.insert(track.id).inserted, seenKeys.insert(key).inserted else { return }
            result.append(track)
        }
        liked.forEach(include)
        playlists.forEach { $0.tracks.forEach(include) }
        songs = result.sorted { $0.title.localizedCaseInsensitiveCompare($1.title) == .orderedAscending }
    }

    static func dedupeKey(_ track: Track) -> String {
        func clean(_ value: String) -> String {
            value.folding(options: [.caseInsensitive, .diacriticInsensitive], locale: nil)
                .replacingOccurrences(of: #"\s*[\(\[].*?[\)\]]"#, with: "", options: .regularExpression)
                .filter { $0.isLetter || $0.isNumber }
        }
        let artist = track.artist.components(separatedBy: CharacterSet(charactersIn: ",&")).first ?? track.artist
        return clean(track.title) + "|" + clean(artist.replacingOccurrences(of: " et ", with: ","))
    }

    /// Enregistre une écoute (statistiques et, si activé, historique).
    func recordPlay(_ track: Track, addToHistory: Bool) {
        var info = stats[track.id] ?? TrackStats()
        info.playCount += 1
        info.lastPlayed = Date()
        stats[track.id] = info
        if addToHistory {
            addRecent(track)
        } else {
            save()
        }
    }

    private func markAdded(_ tracks: [Track]) {
        let now = Date()
        for track in tracks where stats[track.id]?.added == nil {
            var info = stats[track.id] ?? TrackStats()
            info.added = now
            stats[track.id] = info
        }
    }

    // MARK: Playlists intelligentes

    func smartPlaylist(_ id: UUID) -> SmartPlaylist? {
        smartPlaylists.first { $0.id == id }
    }

    func saveSmartPlaylist(_ playlist: SmartPlaylist) {
        if let index = smartPlaylists.firstIndex(where: { $0.id == playlist.id }) {
            smartPlaylists[index] = playlist
        } else {
            smartPlaylists.insert(playlist, at: 0)
        }
        save()
    }

    func deleteSmartPlaylist(_ id: UUID) {
        smartPlaylists.removeAll { $0.id == id }
        save()
    }

    /// Titres d'une playlist intelligente : bibliothèque + historique + téléchargements.
    func tracks(for playlist: SmartPlaylist, downloads: [Track]) -> [Track] {
        var seen = Set<String>()
        let pool = (songs + recents + downloads).filter { seen.insert($0.id).inserted }
        return playlist.evaluate(pool: pool, stats: stats, liked: likedIDs, downloaded: Set(downloads.map(\.id)))
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
        markAdded([track])
        save()
        return true
    }

    /// Ajoute des titres importés aux titres likés.
    func addLiked(_ tracks: [Track]) {
        let fresh = tracks.filter { likedIDs.insert($0.id).inserted }
        liked.insert(contentsOf: fresh, at: 0)
        markAdded(fresh)
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
        markAdded(tracks)
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
        markAdded(tracks)
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
        rebuildSongs()
        let snapshot = Snapshot(recents: recents, liked: liked, playlists: playlists, saved: saved, searches: searches,
                                smartPlaylists: smartPlaylists, stats: stats)
        do {
            try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
            try JSONEncoder().encode(snapshot).write(to: fileURL, options: .atomic)
        } catch {
            // Pas bloquant : la bibliothèque sera réécrite au prochain changement.
        }
    }
}
