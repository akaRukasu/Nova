import Observation
import SwiftUI

enum AppTab: Hashable {
    case home, explore, library, search
}

/// Pages qu'on peut ouvrir dans un onglet.
enum Route: Hashable {
    case collection(MusicCollection)
    case more(title: String, link: BrowseLink)
    case userPlaylist(UUID)
    case liked
    case downloads
    case history
    case account(title: String, browseID: String)
    case libraryPlaylists
    case libraryArtists
    case libraryAlbums
}

/// Navigation de l'app : onglet actif, pile de pages par onglet, lecteur plein écran.
@MainActor
@Observable
final class Router {
    var tab: AppTab = .home
    var homePath: [Route] = []
    var explorePath: [Route] = []
    var libraryPath: [Route] = []
    var searchPath: [Route] = []
    var showPlayer = false
    /// Titres à mettre dans une nouvelle playlist (affiche la fenêtre de création).
    var newPlaylistTracks: [Track]?

    /// Ouvre une page dans l'onglet courant, en fermant le lecteur plein écran.
    func open(_ route: Route) {
        showPlayer = false
        switch tab {
        case .home: homePath.append(route)
        case .explore: explorePath.append(route)
        case .library: libraryPath.append(route)
        case .search: searchPath.append(route)
        }
    }

    /// Lien « Tout afficher » d'une étagère.
    static func route(for link: BrowseLink, title: String) -> Route {
        if link.browseID.hasPrefix("VL") {
            return .collection(MusicCollection(id: link.browseID, kind: .playlist, title: title))
        }
        if link.params == nil, let kind = InnerTubeParser.kind(pageType: nil, browseID: link.browseID) {
            return .collection(MusicCollection(id: link.browseID, kind: kind, title: title))
        }
        return .more(title: title, link: link)
    }
}

/// Destination de chaque page.
struct RouteView: View {
    let route: Route

    var body: some View {
        switch route {
        case .collection(let collection):
            if collection.kind == .artist {
                ArtistView(artist: collection)
            } else {
                CollectionView(collection: collection)
            }
        case .more(let title, let link):
            BrowseView(title: title, link: link)
        case .userPlaylist(let id):
            UserPlaylistView(id: id)
        case .liked:
            LikedTracksView()
        case .downloads:
            DownloadsView()
        case .history:
            HistoryView()
        case .account(let title, let browseID):
            BrowseView(title: title, link: BrowseLink(browseID: browseID))
        case .libraryPlaylists:
            LibraryPlaylistsView()
        case .libraryArtists:
            LibraryCollectionsView(kind: .artist)
        case .libraryAlbums:
            LibraryCollectionsView(kind: .album)
        }
    }
}

extension View {
    func withRoutes() -> some View {
        navigationDestination(for: Route.self) { RouteView(route: $0) }
    }
}
