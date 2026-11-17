import SwiftUI

struct ArtistHeader<Actions: View>: View {
    let name: String
    let artwork: [URL]
    var details: String? = nil
    @ViewBuilder let actions: () -> Actions

    var body: some View {
        VStack(alignment: .leading, spacing: 18) {
            Spacer(minLength: 130)
            VStack(alignment: .leading, spacing: 5) {
                Label("ARTISTE", systemImage: "music.mic")
                    .font(.caption2.weight(.bold)).tracking(2)
                    .padding(.bottom, 7)
                Text(name)
                    .font(.largeTitle.weight(.heavy)).tracking(-1)
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
        .padding(24)
        .frame(minHeight: 360)
        .background {
            GeometryReader { geometry in
                RemoteImage(urls: artwork, maxPixels: 1200)
                    .frame(width: geometry.size.width, height: geometry.size.height)
                    .overlay {
                        LinearGradient(colors: [.black.opacity(0.08), .black.opacity(0.35), .black.opacity(0.96)],
                                       startPoint: .top, endPoint: .bottom)
                    }
            }
        }
        .clipShape(RoundedRectangle(cornerRadius: 28, style: .continuous))
        .overlay { RoundedRectangle(cornerRadius: 28).strokeBorder(.white.opacity(0.12)) }
        .shadow(color: .black.opacity(0.16), radius: 18, y: 9)
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
    @State private var showAllSongs = false
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
            LazyVStack(alignment: .leading, spacing: 28) {
                ArtistHeader(name: name, artwork: page?.header.artworkURL.map { [$0] } ?? artist.artworkURLs) {
                    if page != nil { actions }
                }
                .padding(.horizontal, 16)
                .padding(.top, 12)
                if let page {
                    ForEach(page.shelves) { shelf in
                        VStack(alignment: .leading, spacing: 8) {
                            ShelfView(shelf: shelf, listLimit: showAllSongs ? .max : 8, ranked: shelf.layout == .list)
                            if shelf.layout == .list && shelf.items.count > 8 {
                                Button(showAllSongs ? "Réduire" : "Tous les titres populaires") {
                                    withAnimation { showAllSongs.toggle() }
                                }
                                .font(.subheadline.weight(.semibold))
                                .frame(minHeight: 44).padding(.horizontal, 16)
                            }
                        }
                    }
                    if let description = page.header.description, !description.isEmpty {
                        DisclosureGroup("À propos de " + name, isExpanded: $showFullDescription) {
                            Text(description).font(.subheadline).foregroundStyle(.secondary)
                                .lineSpacing(5).frame(maxWidth: .infinity, alignment: .leading).padding(.top, 12)
                        }
                        .font(.headline).padding(20)
                        .background(.quaternary.opacity(0.4), in: RoundedRectangle(cornerRadius: 20))
                        .padding(.horizontal, 16)
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
        VStack(alignment: .leading, spacing: 10) {
          HStack(spacing: 10) {
            Button {
                if !topSongs.isEmpty { player.play(topSongs) }
                else { player.play(artist) }
            } label: {
                Label("Lecture", systemImage: "play.fill")
                    .foregroundStyle(.white)
                    .frame(maxWidth: .infinity)
            }
            .buttonStyle(.glassProminent)
            .tint(Color.novaAccent)
            Button { player.play(topSongs, shuffled: true) } label: {
                Image(systemName: "shuffle").frame(width: 24, height: 24)
            }
            .buttonStyle(.glass).disabled(topSongs.isEmpty).accessibilityLabel("Lecture aléatoire")
          }
          HStack(spacing: 10) {
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
                Label(library.isSaved(artist.id) ? "Suivi" : "Suivre", systemImage: library.isSaved(artist.id) ? "checkmark" : "plus")
                    .frame(maxWidth: .infinity)
            }
            .buttonStyle(.glass)
            .accessibilityLabel(library.isSaved(artist.id) ? "Ne plus suivre" : "Suivre")
          }
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
