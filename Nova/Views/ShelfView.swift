import SwiftUI

/// Une étagère : titre, puis liste, grille ou carrousel de cartes.
struct ShelfView: View {
    @Environment(PlayerModel.self) private var player
    @Environment(Router.self) private var router
    let shelf: Shelf
    /// Nombre maximal de lignes affichées pour une liste.
    var listLimit = 6
    /// Lecture d'un titre ; par défaut, lit l'étagère à partir de ce titre.
    var onPlay: ((Track, [Track]) -> Void)?

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            if !shelf.title.isEmpty {
                HStack(alignment: .firstTextBaseline) {
                    Text(shelf.title)
                        .font(.title2.weight(.bold))
                        .lineLimit(2)
                    Spacer()
                    if let more = shelf.more {
                        Button("Tout afficher") {
                            router.open(Router.route(for: more, title: shelf.title))
                        }
                        .font(.subheadline.weight(.semibold))
                    }
                }
                .padding(.horizontal, 16)
            }

            switch shelf.layout {
            case .list:
                VStack(spacing: 6) {
                    ForEach(shelf.items.prefix(listLimit)) { item in
                        ItemRow(item: item, onPlay: play)
                    }
                }
                .padding(.horizontal, 16)
            case .grid:
                ScrollView(.horizontal, showsIndicators: false) {
                    LazyHGrid(rows: Array(repeating: GridItem(.fixed(58), spacing: 6), count: min(4, max(shelf.items.count, 1))), spacing: 16) {
                        ForEach(shelf.items) { item in
                            ItemRow(item: item, onPlay: play)
                                .frame(width: 310)
                        }
                    }
                    .scrollTargetLayout()
                    .padding(.horizontal, 16)
                }
                .scrollTargetBehavior(.viewAligned)
            case .cards:
                ScrollView(.horizontal, showsIndicators: false) {
                    LazyHStack(alignment: .top, spacing: 14) {
                        ForEach(shelf.items) { item in
                            ItemCard(item: item, onPlay: play)
                        }
                    }
                    .scrollTargetLayout()
                    .padding(.horizontal, 16)
                }
                .scrollTargetBehavior(.viewAligned)
            }
        }
    }

    private func play(_ track: Track) {
        let tracks = shelf.tracks
        if let onPlay {
            onPlay(track, tracks)
        } else {
            player.play(tracks, startAt: tracks.firstIndex(of: track) ?? 0)
        }
    }
}

/// Liste d'étagères avec chargement, erreur et page suivante.
struct ShelvesContent: View {
    let shelves: [Shelf]
    var onPlay: ((Track, [Track]) -> Void)?

    var body: some View {
        ForEach(shelves) { shelf in
            ShelfView(shelf: shelf, onPlay: onPlay)
        }
    }
}

/// Page « Tout afficher » ou page du compte : étagères ou grille de cartes.
struct BrowseView: View {
    @Environment(AccountStore.self) private var account
    let title: String
    let link: BrowseLink
    @State private var page: BrowsePage?
    @State private var errorText: String?
    private let client = InnerTubeClient()

    var body: some View {
        ScrollView {
            if let page {
                LazyVStack(alignment: .leading, spacing: 28) {
                    ForEach(page.shelves) { shelf in
                        if shelf.layout == .cards {
                            CardGrid(shelf: shelf, showTitle: page.shelves.count > 1)
                        } else {
                            ShelfView(shelf: shelf, listLimit: .max)
                        }
                    }
                }
                .padding(.vertical, 12)
            }
        }
        .overlay {
            if page == nil {
                if let errorText {
                    ContentUnavailableView {
                        Label("Chargement impossible", systemImage: "wifi.exclamationmark")
                    } description: {
                        Text(errorText)
                    } actions: {
                        Button("Réessayer") { Task { await load() } }
                    }
                } else {
                    ProgressView()
                }
            } else if page?.shelves.isEmpty == true {
                ContentUnavailableView("Rien ici pour l'instant", systemImage: "music.note.list")
            }
        }
        .navigationTitle(title)
        .navigationBarTitleDisplayMode(.inline)
        .task(id: account.revision) { await load() }
        .refreshable { await load() }
    }

    private func load() async {
        do {
            page = try await client.browse(link)
            errorText = nil
        } catch {
            if page == nil { errorText = error.localizedDescription }
        }
    }
}

/// Grille de cartes sur toute la largeur.
struct CardGrid: View {
    @Environment(PlayerModel.self) private var player
    let shelf: Shelf
    var showTitle = true

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            if showTitle, !shelf.title.isEmpty {
                Text(shelf.title)
                    .font(.title2.weight(.bold))
                    .padding(.horizontal, 16)
            }
            LazyVGrid(columns: [GridItem(.adaptive(minimum: 150), spacing: 14, alignment: .top)], spacing: 20) {
                ForEach(shelf.items) { item in
                    ItemCard(item: item, width: 160) { track in
                        let tracks = shelf.tracks
                        player.play(tracks, startAt: tracks.firstIndex(of: track) ?? 0)
                    }
                }
            }
            .padding(.horizontal, 16)
        }
    }
}
