import Foundation

/// Type d'une page YouTube Music qu'on peut ouvrir.
enum CollectionKind: String, Codable, Hashable {
    case artist, album, playlist

    var label: String {
        switch self {
        case .artist: return "Artiste"
        case .album: return "Album"
        case .playlist: return "Playlist"
        }
    }
}

/// Artiste, album ou playlist YouTube Music. `id` est le browseId (UC…, MPREb…, VL…).
struct MusicCollection: Identifiable, Codable, Hashable {
    let id: String
    var kind: CollectionKind
    var title: String
    var subtitle: String = ""
    var artworkURL: URL? = nil

    var artworkURLs: [URL] { artworkURL.map { [$0] } ?? [] }

    var shareURL: URL {
        switch kind {
        case .artist: return URL(string: "https://music.youtube.com/channel/\(id)")!
        case .album: return URL(string: "https://music.youtube.com/browse/\(id)")!
        case .playlist:
            let list = id.hasPrefix("VL") ? String(id.dropFirst(2)) : id
            return URL(string: "https://music.youtube.com/playlist?list=\(list)")!
        }
    }
}

/// Élément affiché dans une étagère : un titre ou une page à ouvrir.
enum MusicItem: Identifiable, Hashable {
    case track(Track)
    case collection(MusicCollection)

    var id: String {
        switch self {
        case .track(let track): return "t:" + track.id
        case .collection(let collection): return "c:" + collection.id
        }
    }

    var track: Track? {
        if case .track(let track) = self { return track }
        return nil
    }
}

/// Lien « Tout afficher » d'une étagère.
struct BrowseLink: Hashable {
    let browseID: String
    var params: String?
}

/// Une rangée de contenu (« Titres », « Albums », « Sélection rapide »…).
struct Shelf: Identifiable, Hashable {
    enum Layout: Hashable {
        /// Liste verticale de titres.
        case list
        /// Grille horizontale de lignes (sélection rapide).
        case grid
        /// Cartes carrées défilant horizontalement.
        case cards
    }

    var id: String
    var title: String
    var items: [MusicItem]
    var layout: Layout
    var more: BrowseLink? = nil
    var continuation: String? = nil

    var tracks: [Track] { items.compactMap(\.track) }
}

/// En-tête d'une page artiste, album ou playlist.
struct PageHeader: Hashable {
    var title = ""
    var subtitle = ""
    var artist: String?
    var artistID: String?
    var secondSubtitle = ""
    var description: String?
    var artworkURL: URL?
}

/// Page YouTube Music générique (accueil, artiste, « Tout afficher »).
struct BrowsePage {
    var header = PageHeader()
    var shelves: [Shelf] = []
    var continuation: String?
}

/// Contenu d'un album ou d'une playlist.
struct CollectionContent {
    var header: PageHeader
    var tracks: [Track]
    var continuation: String?
    var related: [Shelf]
}

struct Lyrics: Hashable {
    var text: String
    var source: String?
}

/// Playlist créée dans Nova, stockée sur l'iPhone.
struct UserPlaylist: Identifiable, Codable, Hashable {
    var id = UUID()
    var name: String
    var tracks: [Track] = []
    var createdAt = Date()

    var totalDuration: TimeInterval { tracks.compactMap(\.duration).reduce(0, +) }
}
