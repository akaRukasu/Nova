import SwiftUI

/// Album ou playlist YouTube Music.
struct CollectionView: View {
    @Environment(PlayerModel.self) private var player
    @Environment(LibraryStore.self) private var library
    @Environment(DownloadStore.self) private var downloads
    @Environment(Router.self) private var router
    let collection: MusicCollection

    @State private var content: CollectionContent?
    @State private var tracks: [Track] = []
    @State private var isLoadingMore = false
    @State private var errorText: String?
    @State private var showFullDescription = false
    private let client = InnerTubeClient()

    private var isAlbum: Bool { collection.kind == .album }
    private var header: PageHeader { content?.header ?? PageHeader(title: collection.title, subtitle: collection.subtitle) }

    /// Version à jour pour l'enregistrement dans la bibliothèque.
    private var savable: MusicCollection {
        MusicCollection(id: collection.id, kind: collection.kind,
                        title: header.title.isEmpty ? collection.title : header.title,
                        subtitle: header.artist ?? collection.subtitle,
                        artworkURL: header.artworkURL ?? collection.artworkURL)
    }

    var body: some View {
        List {
            Section {
                headerView
                    .listRowSeparator(.hidden)
                    .listRowBackground(Color.clear)
            }
            if content != nil {
                Section {
                    ForEach(Array(tracks.enumerated()), id: \.offset) { position, track in
                        TrackRowButton(track: track, number: isAlbum ? position + 1 : nil) {
                            player.play(tracks, startAt: position)
                        }
                    }
                    if isLoadingMore {
                        HStack {
                            Spacer()
                            ProgressView()
                            Spacer()
                        }
                        .listRowSeparator(.hidden)
                    }
                } footer: {
                    if !tracks.isEmpty, !isLoadingMore {
                        Text(summary)
                    }
                }
                ForEach(content?.related ?? []) { shelf in
                    Section {
                        ShelfView(shelf: shelf)
                            .listRowInsets(EdgeInsets(top: 12, leading: 0, bottom: 12, trailing: 0))
                            .listRowSeparator(.hidden)
                            .listRowBackground(Color.clear)
                    }
                }
            }
        }
        .listStyle(.plain)
        .overlay {
            if content == nil {
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
        .navigationTitle(header.title)
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItemGroup(placement: .topBarTrailing) {
                Button {
                    library.toggleSaved(savable)
                } label: {
                    Image(systemName: library.isSaved(collection.id) ? "bookmark.fill" : "bookmark")
                }
                Menu {
                    Button("Ajouter à la file", systemImage: "text.line.last.and.arrowtriangle.forward") {
                        player.enqueue(tracks)
                    }
                    .disabled(tracks.isEmpty)
                    AddToPlaylistMenu(tracks: tracks)
                    if downloads.isDownloaded(tracks) {
                        Button("Supprimer les téléchargements", systemImage: "trash", role: .destructive) {
                            downloads.remove(tracks)
                        }
                    } else {
                        Button("Tout télécharger", systemImage: "arrow.down.circle") {
                            downloads.download(tracks)
                        }
                        .disabled(tracks.isEmpty)
                    }
                    ShareLink(item: collection.shareURL) {
                        Label("Partager", systemImage: "square.and.arrow.up")
                    }
                } label: {
                    Image(systemName: "ellipsis")
                }
            }
        }
        .task { if content == nil { await load() } }
    }

    private var headerView: some View {
        VStack(spacing: 10) {
            ArtworkThumb(urls: header.artworkURL.map { [$0] } ?? collection.artworkURLs, size: 230, corner: 18)
                .shadow(color: .black.opacity(0.25), radius: 18, y: 10)
                .padding(.bottom, 6)
            Text(header.title)
                .font(.title2.weight(.bold))
                .multilineTextAlignment(.center)
            if let artist = header.artist, !artist.isEmpty {
                Button(artist) {
                    if let id = header.artistID {
                        router.open(.collection(MusicCollection(id: id, kind: .artist, title: artist)))
                    }
                }
                .font(.headline)
                .foregroundStyle(Color.novaAccent)
                .disabled(header.artistID == nil)
            }
            let details = [header.subtitle, header.secondSubtitle].filter { !$0.isEmpty }.joined(separator: " • ")
            if !details.isEmpty {
                Text(details)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .multilineTextAlignment(.center)
            }
            if let description = header.description {
                Text(description)
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                    .lineLimit(showFullDescription ? nil : 3)
                    .multilineTextAlignment(.center)
                    .onTapGesture { withAnimation { showFullDescription.toggle() } }
            }
            PlayShuffleButtons {
                player.play(tracks)
            } shuffle: {
                player.play(tracks, shuffled: true)
            }
            .disabled(tracks.isEmpty)
            .padding(.top, 6)
        }
        .frame(maxWidth: .infinity)
        .padding(.vertical, 8)
    }

    private var summary: String {
        let total = tracks.compactMap(\.duration).reduce(0, +)
        let count = tracks.count == 1 ? "1 titre" : "\(tracks.count) titres"
        return total > 0 ? "\(count) • \(total.longDurationString)" : count
    }

    private func load() async {
        errorText = nil
        do {
            let client = self.client
            let id = collection.id
            try await loadCached("collection-\(id)", freshFor: 1800,
                                 fetch: { try await client.collection(id) }) { loaded in
                content = loaded
                tracks = loaded.tracks
            }
            guard let loaded = content, let token = loaded.continuation else { return }
            await loadRemaining(from: token, header: loaded.header)
            // Playlist complète en cache : la prochaine ouverture est instantanée.
            var complete = loaded
            complete.tracks = tracks
            complete.continuation = nil
            await PageCache.shared.store(complete, for: "collection-\(id)")
        } catch {
            if (error as? URLError)?.code == .cancelled || error is CancellationError { return }
            errorText = error.localizedDescription
        }
    }

    /// Charge toute la playlist, page par page.
    private func loadRemaining(from token: String?, header: PageHeader) async {
        var token = token
        var pages = 0
        isLoadingMore = token != nil
        defer { isLoadingMore = false }
        while let current = token, pages < 40, !Task.isCancelled {
            guard let more = try? await client.moreTracks(current, header: header, collectionID: collection.id) else { break }
            tracks += more.tracks
            token = more.next
            pages += 1
        }
    }
}
