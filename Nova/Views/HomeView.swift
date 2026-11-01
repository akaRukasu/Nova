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
                ForEach(shelves) { shelf in
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
                .clipShape(RoundedRectangle(cornerRadius: 22, style: .continuous))
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
}
