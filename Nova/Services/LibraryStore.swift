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
    /// Titres ajoutés à la bibliothèque (bouton « + »), du plus récent au plus ancien.
    private(set) var addedTracks: [Track] = []
    /// Date d'ajout des albums, playlists et artistes enregistrés.
    private(set) var savedDates: [String: Date] = [:]
    private var addedIDs: Set<String> = []
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
        var addedTracks: [Track]?
        var savedDates: [String: Date]?
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
            addedTracks = snapshot.addedTracks ?? []
            savedDates = snapshot.savedDates ?? [:]
        } else if let data = try? Data(contentsOf: directory.appendingPathComponent("recents.json")),
                  let old = try? JSONDecoder().decode([Track].self, from: data) {
            // Historique de l'étape 1.
            recents = old
        }
        likedIDs = Set(liked.map(\.id))
        savedIDs = Set(saved.map(\.id))
        addedIDs = Set(addedTracks.map(\.id))
        if removeDuplicatePlaylists() { save() } else { rebuildSongs() }
    }

    /// Imports précédents : une seule playlist par nom (la plus récente, en tête de liste),
    /// et aucun titre en double dans une playlist. Renvoie `true` si quelque chose a changé.
    private func removeDuplicatePlaylists() -> Bool {
        var seenNames = Set<String>()
        let before = playlists
        playlists = playlists.filter {
            seenNames.insert($0.name.trimmingCharacters(in: .whitespaces).lowercased()).inserted
        }
        for index in playlists.indices {
            var seenIDs = Set<String>()
            var seenKeys = Set<String>()
            playlists[index].tracks = playlists[index].tracks.filter {
                seenIDs.insert($0.id).inserted && seenKeys.insert(LibraryStore.dedupeKey($0)).inserted
            }
        }
        return playlists != before
    }

    // MARK: Ajouter à la bibliothèque

    /// Le titre est dans la bibliothèque (ajouté, liké ou dans une playlist).
    func isInLibrary(_ id: String) -> Bool {
        addedIDs.contains(id) || likedIDs.contains(id)
    }

    func addToLibrary(_ track: Track) {
        guard addedIDs.insert(track.id).inserted else { return }
        addedTracks.insert(track, at: 0)
        markAdded([track], force: true)
        save()
    }

    func removeFromLibrary(_ track: Track) {
        guard addedIDs.remove(track.id) != nil else { return }
        addedTracks.removeAll { $0.id == track.id }
        save()
    }

    /// Élément de la grille « Ajouts récents ».
    enum RecentAddition: Hashable, Identifiable {
        case track(Track)
        case collection(MusicCollection)
        case playlist(UserPlaylist)

        var id: String {
            switch self {
            case .track(let track): return "t:" + track.id
            case .collection(let collection): return "c:" + collection.id
            case .playlist(let playlist): return "p:" + playlist.id.uuidString
            }
        }
    }

    /// Titres, albums, artistes et playlists ajoutés, du plus récent au plus ancien.
    func recentAdditions(limit: Int = 60) -> [RecentAddition] {
        var entries: [(Date, RecentAddition)] = []
        // Titres ajoutés ou likés : on affiche leur album ou leur single, comme Apple Music
        // (une seule fois par album), et le titre seul quand l'album est inconnu.
        var seenAlbums = Set<String>()
        var seenTracks = Set<String>()
        let tracks = (addedTracks + liked)
            .filter { seenTracks.insert($0.id).inserted }
            .sorted { (stats[$0.id]?.added ?? .distantPast) > (stats[$1.id]?.added ?? .distantPast) }
        for track in tracks.prefix(limit * 3) {
            let date = stats[track.id]?.added ?? .distantPast
            if let albumID = track.albumID {
                guard !savedIDs.contains(albumID), seenAlbums.insert(albumID).inserted else { continue }
                let album = MusicCollection(id: albumID, kind: .album, title: track.album ?? track.title,
                                            subtitle: track.artist, artworkURL: track.artworkURL)
                entries.append((date, .collection(album)))
            } else {
                entries.append((date, .track(track)))
            }
        }
        for (position, collection) in saved.prefix(limit).enumerated() {
            // Ajouts antérieurs à la date d'ajout : on garde l'ordre de la liste.
            let date = savedDates[collection.id] ?? Date.distantPast.addingTimeInterval(Double(limit - position))
            entries.append((date, .collection(collection)))
        }
        for playlist in playlists.prefix(limit) {
            entries.append((playlist.createdAt, .playlist(playlist)))
        }
        return entries.sorted { $0.0 > $1.0 }.prefix(limit).map(\.1)
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
        addedTracks.forEach(include)
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

    private func markAdded(_ tracks: [Track], force: Bool = false) {
        let now = Date()
        for track in tracks where force || stats[track.id]?.added == nil {
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

    /// Import : remplace la playlist du même nom si elle existe (sans doublons), sinon la crée.
    @discardableResult
    func upsertPlaylist(name: String, tracks: [Track]) -> UUID {
        var seenIDs = Set<String>()
        var seenKeys = Set<String>()
        let unique = tracks.filter {
            seenIDs.insert($0.id).inserted && seenKeys.insert(LibraryStore.dedupeKey($0)).inserted
        }
        let key = name.trimmingCharacters(in: .whitespaces)
        if let index = playlists.firstIndex(where: { $0.name.trimmingCharacters(in: .whitespaces).caseInsensitiveCompare(key) == .orderedSame }) {
            markAdded(unique)
            playlists[index].tracks = unique
            save()
            return playlists[index].id
        }
        return createPlaylist(name: name, tracks: unique)
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
            savedDates[collection.id] = Date()
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

    // MARK: Pochettes

    /// Remplace la miniature vidéo d'un titre par sa vraie pochette, partout dans la bibliothèque.
    func updateArtwork(_ url: URL, for id: String) {
        var changed = false
        func patch(_ tracks: inout [Track]) {
            for position in tracks.indices where tracks[position].id == id && tracks[position].artworkURL != url {
                tracks[position].artworkURL = url
                changed = true
            }
        }
        patch(&recents)
        patch(&liked)
        patch(&addedTracks)
        for position in playlists.indices { patch(&playlists[position].tracks) }
        if changed { save() }
    }

    // MARK: Disque

    private func save() {
        rebuildSongs()
        let snapshot = Snapshot(recents: recents, liked: liked, playlists: playlists, saved: saved, searches: searches,
                                smartPlaylists: smartPlaylists, stats: stats,
                                addedTracks: addedTracks, savedDates: savedDates)
        do {
            try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
            try JSONEncoder().encode(snapshot).write(to: fileURL, options: .atomic)
        } catch {
            // Pas bloquant : la bibliothèque sera réécrite au prochain changement.
        }
    }
}
