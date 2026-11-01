import SwiftUI

struct HomeView: View {
    @Environment(PlayerModel.self) private var player
    @Environment(LibraryStore.self) private var library
    @Environment(AccountStore.self) private var account
    @Environment(Router.self) private var router
    @State private var shelves: [Shelf] = []
    @State private var continuation: String?
    @State private var isLoading = false
    @State private var errorText: String?
    @State private var loadedRevision: Int?
    @State private var personalShelves: [Shelf] = []
    private let client = InnerTubeClient()

    var body: some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 30) {
                resumeCard
                MixesRow()
                if !library.recents.isEmpty {
                    ShelfView(shelf: Shelf(id: "recents", title: "Écoutés récemment",
                                           items: library.recents.prefix(20).map(MusicItem.track),
                                           layout: .cards, more: nil))
                }
                // Tes artistes et tes playlists.
                ForEach(personalShelves) { shelf in
                    ShelfView(shelf: shelf)
                }
                // Les premières sélections de YouTube Music, puis les propositions d'après tes écoutes.
                ForEach(shelves.prefix(3)) { shelf in
                    ShelfView(shelf: shelf)
                }
                DiscoverView(embedded: true)
                ForEach(shelves.dropFirst(3)) { shelf in
                    ShelfView(shelf: shelf)
                }
                if continuation != nil {
                    ProgressView()
                        .frame(maxWidth: .infinity)
                        .task { await loadMore() }
                }
                if let errorText, shelves.isEmpty {
                    ContentUnavailableView {
                        Label("Accueil indisponible", systemImage: "wifi.exclamationmark")
                    } description: {
                        Text(errorText)
                    } actions: {
                        Button("Réessayer") { Task { await reload() } }
                    }
                } else if shelves.isEmpty, isLoading {
                    ProgressView()
                        .frame(maxWidth: .infinity)
                        .padding(.top, 40)
                }
            }
            .padding(.vertical, 12)
        }
        .navigationTitle("Accueil")
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                AccountButton()
            }
        }
        .refreshable { await reload(force: true) }
        .task(id: account.revision) {
            if loadedRevision != account.revision { await reload() }
        }
        .task(id: library.songs.count &+ library.playlists.count &* 31) {
            personalShelves = buildPersonalShelves()
        }
    }

    /// Grande carte 16:9 pour reprendre l'écoute.
    @ViewBuilder private var resumeCard: some View {
        if let last = player.current ?? library.recents.first {
            Button {
                if player.current?.id == last.id {
                    if !player.isPlaying { player.resume() }
                    router.showPlayer = true
                } else {
                    player.startRadio(from: last)
                }
            } label: {
                ZStack(alignment: .bottomLeading) {
                    RemoteImage(urls: last.videoThumbnailURLs)
                        .aspectRatio(16 / 9, contentMode: .fit)
                    LinearGradient(colors: [.clear, .black.opacity(0.75)], startPoint: .center, endPoint: .bottom)
                    HStack(alignment: .bottom) {
                        VStack(alignment: .leading, spacing: 4) {
                            Text(player.current?.id == last.id ? "Reprendre l'écoute" : "Reprendre avec la radio")
                                .font(.caption.weight(.semibold))
                                .textCase(.uppercase)
                                .foregroundStyle(.white.opacity(0.8))
                            Text(last.title)
                                .font(.title3.weight(.bold))
                                .foregroundStyle(.white)
                                .lineLimit(1)
                            Text(last.artist)
                                .font(.subheadline)
                                .foregroundStyle(.white.opacity(0.8))
                                .lineLimit(1)
                        }
                        Spacer()
                        Image(systemName: "play.fill")
                            .font(.title2)
                            .foregroundStyle(.white)
                            .frame(width: 52, height: 52)
                            .glassEffect(in: Circle())
                    }
                    .padding(16)
                }
                .clipShape(RoundedRectangle(cornerRadius: 28, style: .continuous))
            }
            .buttonStyle(.plain)
            .padding(.horizontal, 16)
        }
    }

    private func reload(force: Bool = false) async {
        isLoading = true
        defer { isLoading = false }
        do {
            // L'accueil précédent s'affiche tout de suite, puis il est rafraîchi.
            let client = self.client
            try await loadCached("home-\(account.isSignedIn)", freshFor: force ? 0 : 300,
                                 fetch: { try await client.home() }) { page in
                shelves = page.shelves
                continuation = page.continuation
            }
            errorText = nil
            loadedRevision = account.revision
        } catch {
            if (error as? URLError)?.code == .cancelled || error is CancellationError { return }
            errorText = error.localizedDescription
        }
    }

    private func loadMore() async {
        guard let token = continuation else { return }
        do {
            let page = try await client.browseContinuation(token)
            let known = Set(shelves.map(\.title))
            let offset = shelves.count
            shelves += page.shelves.enumerated().compactMap { position, shelf in
                guard !known.contains(shelf.title) || shelf.title.isEmpty else { return nil }
                var copy = shelf
                copy.id = "more-\(offset + position)"
                return copy
            }
            continuation = page.continuation
        } catch {
            continuation = nil
        }
    }

    /// « Tes artistes » (les plus écoutés) et « Tes playlists ».
    private func buildPersonalShelves() -> [Shelf] {
        var result: [Shelf] = []
        let pool = library.recents + library.songs
        var artistItems: [MusicItem] = []
        for name in MixBuilder.topArtists(library).prefix(15) {
            guard let track = pool.first(where: { MixBuilder.mainArtist($0) == name && $0.artistID != nil }),
                  let id = track.artistID else { continue }
            artistItems.append(.collection(MusicCollection(id: id, kind: .artist, title: name,
                                                           subtitle: "Artiste", artworkURL: track.artworkURL)))
        }
        if artistItems.count >= 3 {
            result.append(Shelf(id: "my-artists", title: "Tes artistes", items: artistItems, layout: .cards))
        }
        let playlists = library.playlists.prefix(15).map { playlist in
            MusicItem.collection(MusicCollection(id: "local:" + playlist.id.uuidString, kind: .playlist,
                                                 title: playlist.name,
                                                 subtitle: "\(playlist.tracks.count) titres",
                                                 artworkURL: playlist.tracks.first?.artworkURL))
        }
        if !playlists.isEmpty {
            result.append(Shelf(id: "my-playlists", title: "Tes playlists", items: Array(playlists), layout: .cards))
        }
        return result
    }
}
