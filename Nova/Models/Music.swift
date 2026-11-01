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

/// Catégorie de « Parcourir » (ambiance, genre, classement…), avec sa couleur.
struct BrowseCategory: Hashable, Codable {
    var title: String
    /// Couleur ARGB fournie par YouTube Music.
    var color: UInt32
    var link: BrowseLink
}

/// Élément affiché dans une étagère : un titre, une page à ouvrir ou une catégorie.
enum MusicItem: Identifiable, Hashable, Codable {
    case track(Track)
    case collection(MusicCollection)
    case category(BrowseCategory)

    var id: String {
        switch self {
        case .track(let track): return "t:" + track.id
        case .collection(let collection): return "c:" + collection.id
        case .category(let category): return "g:" + category.link.browseID + (category.link.params ?? "") + category.title
        }
    }

    var track: Track? {
        if case .track(let track) = self { return track }
        return nil
    }

    var collection: MusicCollection? {
        if case .collection(let collection) = self { return collection }
        return nil
    }
}

/// Lien « Tout afficher » d'une étagère.
struct BrowseLink: Hashable, Codable {
    let browseID: String
    var params: String?
}

/// Une rangée de contenu (« Titres », « Albums », « Sélection rapide »…).
struct Shelf: Identifiable, Hashable, Codable {
    enum Layout: Hashable, Codable {
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

    /// Étagère de tuiles « Parcourir ».
    var isCategories: Bool {
        !items.isEmpty && items.allSatisfy { if case .category = $0 { return true } else { return false } }
    }
}

/// En-tête d'une page artiste, album ou playlist.
struct PageHeader: Hashable, Codable {
    var title = ""
    var subtitle = ""
    var artist: String?
    var artistID: String?
    var secondSubtitle = ""
    var description: String?
    var artworkURL: URL?
}

/// Page YouTube Music générique (accueil, artiste, « Tout afficher »).
struct BrowsePage: Codable {
    var header = PageHeader()
    var shelves: [Shelf] = []
    var continuation: String?
}

/// Contenu d'un album ou d'une playlist.
struct CollectionContent: Codable {
    var header: PageHeader
    var tracks: [Track]
    var continuation: String?
    var related: [Shelf]
}

struct Lyrics: Hashable, Codable {
    var text: String
    var source: String?
    /// Paroles synchronisées (une ligne par horodatage), quand elles existent.
    var lines: [LyricLine]?

    var isSynced: Bool { !(lines ?? []).isEmpty }
}

/// Ligne de paroles synchronisée : `time` en secondes depuis le début du titre.
struct LyricLine: Hashable, Codable, Identifiable {
    var time: TimeInterval
    var text: String
    var id: String { "\(time)-\(text)" }
}

/// Playlist créée dans Nova, stockée sur l'iPhone.
struct UserPlaylist: Identifiable, Codable, Hashable {
    var id = UUID()
    var name: String
    var tracks: [Track] = []
    var createdAt = Date()

    var totalDuration: TimeInterval { tracks.compactMap(\.duration).reduce(0, +) }
}
