import SwiftUI

/// Page d'un artiste : bannière, titres populaires, albums, singles, artistes similaires.
struct ArtistView: View {
    @Environment(PlayerModel.self) private var player
    @Environment(LibraryStore.self) private var library
    let artist: MusicCollection

    @State private var page: BrowsePage?
    @State private var errorText: String?
    @State private var showFullDescription = false
    private let client = InnerTubeClient()

    private var name: String {
        let title = page?.header.title ?? ""
        return title.isEmpty ? artist.title : title
    }

    private var topSongs: [Track] {
        page?.shelves.first { $0.layout == .list && !$0.tracks.isEmpty }?.tracks ?? []
    }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 28) {
                banner
                if let page {
                    actions
                        .padding(.horizontal, 16)
                    if let description = page.header.description {
                        Text(description)
                            .font(.footnote)
                            .foregroundStyle(.secondary)
                            .lineLimit(showFullDescription ? nil : 3)
                            .padding(.horizontal, 16)
                            .onTapGesture { withAnimation { showFullDescription.toggle() } }
                    }
                    ForEach(page.shelves) { shelf in
                        ShelfView(shelf: shelf, listLimit: 5)
                    }
                }
            }
            .padding(.bottom, 24)
        }
        .ignoresSafeArea(edges: .top)
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
            }
        }
        .navigationTitle(name)
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                ShareLink(item: artist.shareURL)
            }
        }
        .task { if page == nil { await load() } }
    }

    private var banner: some View {
        ZStack(alignment: .bottomLeading) {
            RemoteImage(urls: page?.header.artworkURL.map { [$0] } ?? artist.artworkURLs)
                .frame(height: 360)
                .frame(maxWidth: .infinity)
                .clipped()
            LinearGradient(colors: [.clear, .black.opacity(0.8)], startPoint: .center, endPoint: .bottom)
            Text(name)
                .font(.system(size: 38, weight: .heavy))
                .foregroundStyle(.white)
                .lineLimit(2)
                .minimumScaleFactor(0.6)
                .padding(16)
        }
        .frame(height: 360)
    }

    private var actions: some View {
        HStack(spacing: 12) {
            Button {
                player.play(artist, shuffled: true)
            } label: {
                Label("Aléatoire", systemImage: "shuffle")
                    .frame(maxWidth: .infinity)
            }
            .buttonStyle(.glassProminent)
            Button {
                if let first = topSongs.first { player.startRadio(from: first) }
            } label: {
                Label("Radio", systemImage: "dot.radiowaves.left.and.right")
                    .frame(maxWidth: .infinity)
            }
            .buttonStyle(.glass)
            .disabled(topSongs.isEmpty)
            Button {
                library.toggleSaved(MusicCollection(id: artist.id, kind: .artist, title: name,
                                                    subtitle: "Artiste",
                                                    artworkURL: topSongs.first?.artworkURL ?? artist.artworkURL))
            } label: {
                Image(systemName: library.isSaved(artist.id) ? "checkmark" : "plus")
                    .frame(width: 24)
            }
            .buttonStyle(.glass)
            .accessibilityLabel(library.isSaved(artist.id) ? "Ne plus suivre" : "Suivre")
        }
        .controlSize(.large)
        .font(.headline)
    }

    private func load() async {
        errorText = nil
        do {
            page = try await client.browse(BrowseLink(browseID: artist.id))
        } catch {
            if (error as? URLError)?.code == .cancelled || error is CancellationError { return }
            errorText = error.localizedDescription
        }
    }
}
