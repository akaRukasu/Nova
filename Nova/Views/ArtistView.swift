import SwiftUI

struct ArtistHeader<Actions: View>: View {
    let name: String
    let artwork: [URL]
    var details: String? = nil
    @ViewBuilder let actions: () -> Actions

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            RemoteImage(urls: artwork, maxPixels: 420)
                .frame(width: 118, height: 118)
                .clipShape(Circle())
                .overlay { Circle().strokeBorder(.white.opacity(0.22)) }
                .shadow(color: .black.opacity(0.35), radius: 18, y: 8)
            VStack(alignment: .leading, spacing: 5) {
                Text(name)
                    .font(.largeTitle.weight(.heavy))
                    .accessibilityAddTraits(.isHeader)
                    .fixedSize(horizontal: false, vertical: true)
                if let details {
                    Text(details).font(.subheadline).foregroundStyle(.white.opacity(0.83))
                }
            }
            actions()
        }
        .foregroundStyle(.white)
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(20)
        .background {
            RoundedRectangle(cornerRadius: 22).fill(RadialGradient(
                colors: [Color(red: 0.38, green: 0.25, blue: 0.43), Color(red: 0.13, green: 0.11, blue: 0.18)],
                center: .topLeading, startRadius: 0, endRadius: 350
            ))
        }
    }
}

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
                ArtistHeader(name: name, artwork: page?.header.artworkURL.map { [$0] } ?? artist.artworkURLs) {
                    if page != nil { actions }
                }
                .padding(.horizontal, 16)
                .padding(.top, 12)
                if let page {
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
                NavigationLink(value: Route.concerts(artist: name)) {
                    Image(systemName: "ticket")
                }
                .accessibilityLabel("Concerts")
            }
            ToolbarItem(placement: .topBarTrailing) {
                ShareLink(item: artist.shareURL)
            }
        }
        .task { if page == nil { await load() } }
    }

    private var actions: some View {
        HStack(spacing: 12) {
            Button {
                player.play(artist, shuffled: true)
            } label: {
                Label("Aléatoire", systemImage: "shuffle")
                    .foregroundStyle(.white)
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
            let client = self.client
            let id = artist.id
            try await loadCached("artist-\(id)", freshFor: 1800,
                                 fetch: {
                if OctaveCatalog.id(id) != nil { return try await OctaveCatalog.shared.artist(id) }
                return try await client.browse(BrowseLink(browseID: id))
            }) { page = $0 }
        } catch {
            if (error as? URLError)?.code == .cancelled || error is CancellationError { return }
            errorText = error.localizedDescription
        }
    }
}
