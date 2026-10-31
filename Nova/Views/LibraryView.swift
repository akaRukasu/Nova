import SwiftUI

struct LibraryView: View {
    @Environment(LibraryStore.self) private var library
    @Environment(DownloadStore.self) private var downloads
    @Environment(AccountStore.self) private var account
    @Environment(Router.self) private var router
    @State private var cacheSize: Int64 = 0
    @State private var downloadsSize: Int64 = 0
    @State private var confirmClearCache = false
    @State private var confirmClearDownloads = false

    var body: some View {
        List {
            Section {
                link(.liked, "Titres likés", "heart.fill", .pink, count: library.liked.count)
                link(.downloads, "Téléchargements", "arrow.down.circle.fill", .novaAccent,
                     count: downloads.tracks.count, busy: !downloads.pending.isEmpty)
                link(.history, "Historique", "clock.fill", .orange, count: library.recents.count)
            }

            if account.isSignedIn {
                Section("Mon compte YouTube") {
                    link(.collection(MusicCollection(id: "VLLM", kind: .playlist, title: "Titres likés sur YouTube")),
                         "Titres likés sur YouTube", "hand.thumbsup.fill", .red)
                    link(.account(title: "Mes playlists", browseID: "FEmusic_liked_playlists"),
                         "Playlists", "music.note.list", .red)
                    link(.account(title: "Mes albums", browseID: "FEmusic_liked_albums"),
                         "Albums", "square.stack.fill", .red)
                    link(.account(title: "Mes artistes", browseID: "FEmusic_library_corpus_track_artists"),
                         "Artistes", "music.mic", .red)
                    link(.account(title: "Historique YouTube", browseID: "FEmusic_history"),
                         "Historique YouTube", "clock.arrow.circlepath", .red)
                }
            }

            Section {
                Button {
                    router.newPlaylistTracks = []
                } label: {
                    Label("Nouvelle playlist", systemImage: "plus")
                }
                ForEach(library.playlists) { playlist in
                    NavigationLink(value: Route.userPlaylist(playlist.id)) {
                        HStack(spacing: 12) {
                            ArtworkThumb(track: playlist.tracks.first)
                            VStack(alignment: .leading, spacing: 2) {
                                Text(playlist.name)
                                    .font(.body.weight(.medium))
                                    .lineLimit(1)
                                Text(playlist.tracks.count == 1 ? "1 titre" : "\(playlist.tracks.count) titres")
                                    .font(.subheadline)
                                    .foregroundStyle(.secondary)
                            }
                        }
                    }
                }
                .onDelete { library.deletePlaylists(at: $0) }
            } header: {
                Text("Mes playlists")
            }

            if !library.saved.isEmpty {
                Section("Enregistrés") {
                    ForEach(library.saved) { collection in
                        NavigationLink(value: Route.collection(collection)) {
                            HStack(spacing: 12) {
                                ArtworkThumb(urls: collection.artworkURLs, circle: collection.kind == .artist)
                                VStack(alignment: .leading, spacing: 2) {
                                    Text(collection.title)
                                        .font(.body.weight(.medium))
                                        .lineLimit(1)
                                    Text(savedSubtitle(collection))
                                        .font(.subheadline)
                                        .foregroundStyle(.secondary)
                                        .lineLimit(1)
                                }
                            }
                        }
                        .contextMenu { CollectionMenu(collection: collection) }
                    }
                    .onDelete { library.removeSaved(at: $0) }
                }
            }

            Section {
                LabeledContent("Téléchargements", value: ByteCountFormatter.string(fromByteCount: downloadsSize, countStyle: .file))
                LabeledContent("Cache d'écoute", value: ByteCountFormatter.string(fromByteCount: cacheSize, countStyle: .file))
                Button("Vider le cache", role: .destructive) { confirmClearCache = true }
                if !downloads.tracks.isEmpty {
                    Button("Supprimer tous les téléchargements", role: .destructive) { confirmClearDownloads = true }
                }
            } header: {
                Text("Stockage")
            } footer: {
                Text("Les titres écoutés restent en cache (1,5 Go maximum) pour se relancer instantanément. Les titres téléchargés restent disponibles hors ligne jusqu'à ce que tu les supprimes.")
            }
        }
        .navigationTitle("Bibliothèque")
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) { AccountButton() }
        }
        .task(id: downloads.tracks.count) { await refreshSizes() }
        .confirmationDialog("Vider le cache d'écoute ?", isPresented: $confirmClearCache, titleVisibility: .visible) {
            Button("Vider", role: .destructive) {
                Task {
                    await AudioCache.shared.clear()
                    await refreshSizes()
                }
            }
        }
        .confirmationDialog("Supprimer tous les téléchargements ?", isPresented: $confirmClearDownloads, titleVisibility: .visible) {
            Button("Supprimer", role: .destructive) {
                downloads.removeAll()
            }
        }
    }

    private func link(_ route: Route, _ title: String, _ icon: String, _ color: Color,
                      count: Int? = nil, busy: Bool = false) -> some View {
        NavigationLink(value: route) {
            HStack {
                Label {
                    Text(title)
                } icon: {
                    Image(systemName: icon)
                        .foregroundStyle(color)
                }
                Spacer()
                if busy { ProgressView() }
                if let count, count > 0 {
                    Text("\(count)")
                        .foregroundStyle(.secondary)
                }
            }
        }
    }

    private func savedSubtitle(_ collection: MusicCollection) -> String {
        let label = collection.kind.label
        let subtitle = collection.subtitle
        if subtitle.isEmpty || subtitle == label { return label }
        return subtitle.hasPrefix(label) ? subtitle : "\(label) • \(subtitle)"
    }

    private func refreshSizes() async {
        cacheSize = await AudioCache.shared.sizeInBytes()
        downloadsSize = downloads.sizeInBytes()
    }
}

/// Liste de titres locale avec Lecture / Aléatoire.
struct LocalTracksList: View {
    @Environment(PlayerModel.self) private var player
    let tracks: [Track]
    var emptyTitle = "Aucun titre"
    var emptyIcon = "music.note"
    var emptyMessage = ""
    var onDelete: ((IndexSet) -> Void)?
    var onMove: ((IndexSet, Int) -> Void)?

    var body: some View {
        List {
            if !tracks.isEmpty {
                Section {
                    PlayShuffleButtons {
                        player.play(tracks)
                    } shuffle: {
                        player.play(tracks, shuffled: true)
                    }
                    .listRowSeparator(.hidden)
                    .listRowBackground(Color.clear)
                }
                Section {
                    ForEach(Array(tracks.enumerated()), id: \.offset) { position, track in
                        TrackRowButton(track: track, onRemove: onDelete == nil ? nil : { onDelete?(IndexSet(integer: position)) }) {
                            player.play(tracks, startAt: position)
                        }
                    }
                    .onDelete(perform: onDelete)
                    .onMove(perform: onMove)
                } footer: {
                    let total = tracks.compactMap(\.duration).reduce(0, +)
                    let count = tracks.count == 1 ? "1 titre" : "\(tracks.count) titres"
                    Text(total > 0 ? "\(count) • \(total.longDurationString)" : count)
                }
            }
        }
        .listStyle(.plain)
        .overlay {
            if tracks.isEmpty {
                ContentUnavailableView(emptyTitle, systemImage: emptyIcon, description: Text(emptyMessage))
            }
        }
    }
}

struct LikedTracksView: View {
    @Environment(LibraryStore.self) private var library

    var body: some View {
        LocalTracksList(tracks: library.liked,
                        emptyTitle: "Aucun titre liké",
                        emptyIcon: "heart",
                        emptyMessage: "Appuie sur le cœur dans le lecteur ou dans le menu d'un titre.",
                        onDelete: { library.removeLiked(at: $0) })
            .navigationTitle("Titres likés")
    }
}

struct HistoryView: View {
    @Environment(LibraryStore.self) private var library
    @State private var confirmClear = false

    var body: some View {
        LocalTracksList(tracks: library.recents,
                        emptyTitle: "Historique vide",
                        emptyIcon: "clock",
                        emptyMessage: "Les titres que tu écoutes apparaîtront ici.",
                        onDelete: { library.removeRecents(at: $0) })
            .navigationTitle("Historique")
            .toolbar {
                if !library.recents.isEmpty {
                    Button("Effacer") { confirmClear = true }
                }
            }
            .confirmationDialog("Effacer l'historique ?", isPresented: $confirmClear, titleVisibility: .visible) {
                Button("Effacer", role: .destructive) { library.clearRecents() }
            }
    }
}

struct DownloadsView: View {
    @Environment(DownloadStore.self) private var downloads

    var body: some View {
        LocalTracksList(tracks: downloads.tracks,
                        emptyTitle: "Aucun téléchargement",
                        emptyIcon: "arrow.down.circle",
                        emptyMessage: "Télécharge des titres, des albums ou des playlists pour les écouter sans connexion.",
                        onDelete: { offsets in
                            let ids = offsets.map { downloads.tracks[$0].id }
                            ids.forEach { downloads.remove($0) }
                        })
            .safeAreaInset(edge: .top) {
                if !downloads.pending.isEmpty {
                    HStack(spacing: 12) {
                        ProgressView()
                        Text(downloads.pending.count == 1 ? "1 titre en cours de téléchargement" : "\(downloads.pending.count) titres en cours de téléchargement")
                            .font(.subheadline)
                        Spacer()
                        Button("Annuler") { downloads.cancelAll() }
                            .font(.subheadline.weight(.semibold))
                    }
                    .padding(.horizontal, 16)
                    .padding(.vertical, 10)
                    .glassEffect(in: Capsule())
                    .padding(.horizontal, 12)
                }
            }
            .navigationTitle("Téléchargements")
    }
}

struct UserPlaylistView: View {
    @Environment(LibraryStore.self) private var library
    @Environment(DownloadStore.self) private var downloads
    @Environment(PlayerModel.self) private var player
    @Environment(\.dismiss) private var dismiss
    let id: UUID
    @State private var renaming = false
    @State private var newName = ""
    @State private var confirmDelete = false

    var body: some View {
        let playlist = library.playlist(id)
        LocalTracksList(tracks: playlist?.tracks ?? [],
                        emptyTitle: "Playlist vide",
                        emptyIcon: "music.note.list",
                        emptyMessage: "Ajoute des titres avec le menu « … » › Ajouter à une playlist.",
                        onDelete: { library.removeTracks(at: $0, from: id) },
                        onMove: { library.moveTracks(from: $0, to: $1, in: id) })
            .navigationTitle(playlist?.name ?? "Playlist")
            .toolbar {
                ToolbarItemGroup(placement: .topBarTrailing) {
                    EditButton()
                    Menu {
                        Button("Renommer", systemImage: "pencil") {
                            newName = playlist?.name ?? ""
                            renaming = true
                        }
                        if let tracks = playlist?.tracks, !tracks.isEmpty {
                            Button("Ajouter à la file", systemImage: "text.line.last.and.arrowtriangle.forward") {
                                player.enqueue(tracks)
                            }
                            Button("Tout télécharger", systemImage: "arrow.down.circle") {
                                downloads.download(tracks)
                            }
                        }
                        Button("Supprimer la playlist", systemImage: "trash", role: .destructive) {
                            confirmDelete = true
                        }
                    } label: {
                        Image(systemName: "ellipsis")
                    }
                }
            }
            .alert("Renommer la playlist", isPresented: $renaming) {
                TextField("Nom", text: $newName)
                Button("Annuler", role: .cancel) {}
                Button("Renommer") {
                    let name = newName.trimmingCharacters(in: .whitespaces)
                    if !name.isEmpty { library.renamePlaylist(id, to: name) }
                }
            }
            .confirmationDialog("Supprimer cette playlist ?", isPresented: $confirmDelete, titleVisibility: .visible) {
                Button("Supprimer", role: .destructive) {
                    library.deletePlaylist(id)
                    dismiss()
                }
            }
    }
}
