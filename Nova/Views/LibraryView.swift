import SwiftUI

struct LibraryView: View {
    @Environment(LibraryStore.self) private var library
    @Environment(DownloadStore.self) private var downloads
    @Environment(AccountStore.self) private var account
    @Environment(Router.self) private var router
    @Environment(ImportManager.self) private var importer
    @State private var showImport = false
    @State private var cacheSize: Int64 = 0
    @State private var downloadsSize: Int64 = 0
    @State private var confirmClearCache = false
    @State private var confirmClearDownloads = false

    var body: some View {
        List {
            if !importer.jobs.isEmpty {
                ImportJobsSection()
            }
            Section {
                link(.libraryPlaylists, "Playlists", "music.note.list", count: library.playlists.count + savedCount(.playlist))
                link(.libraryArtists, "Artistes", "music.mic", count: savedCount(.artist))
                link(.libraryAlbums, "Albums", "square.stack", count: savedCount(.album))
                link(.songs, "Morceaux", "music.note", count: library.songs.count)
                link(.liked, "Titres likés", "heart", count: library.liked.count)
                link(.downloads, "Téléchargés", "arrow.down.circle",
                     count: downloads.tracks.count, busy: !downloads.pending.isEmpty)
                link(.history, "Historique", "clock", count: library.recents.count)
                Button {
                    showImport = true
                } label: {
                    Label {
                        Text("Importer depuis une autre plateforme")
                            .foregroundStyle(Color.primary)
                    } icon: {
                        Image(systemName: "square.and.arrow.down.on.square")
                            .foregroundStyle(Color.novaAccent)
                    }
                }
            }
            .font(.title3)

            if !recentlyAdded.isEmpty {
                Section {
                    LazyVGrid(columns: [GridItem(.flexible(), spacing: 16), GridItem(.flexible(), spacing: 16)],
                              alignment: .leading, spacing: 18) {
                        ForEach(recentlyAdded, id: \.self) { entry in
                            NavigationLink(value: entry.route) {
                                VStack(alignment: .leading, spacing: 6) {
                                    RemoteImage(urls: entry.artwork)
                                        .aspectRatio(1, contentMode: .fit)
                                        .clipShape(entry.round ? AnyShape(Circle()) : AnyShape(RoundedRectangle(cornerRadius: 10, style: .continuous)))
                                    Text(entry.title)
                                        .font(.subheadline.weight(.medium))
                                        .foregroundStyle(Color.primary)
                                        .lineLimit(1)
                                    Text(entry.subtitle)
                                        .font(.caption)
                                        .foregroundStyle(.secondary)
                                        .lineLimit(1)
                                }
                            }
                            .buttonStyle(.plain)
                        }
                    }
                    .padding(.vertical, 6)
                    .listRowSeparator(.hidden)
                } header: {
                    Text("Ajouts récents")
                        .font(.title2.weight(.bold))
                        .foregroundStyle(Color.primary)
                        .textCase(nil)
                }
            }

            if account.isSignedIn {
                Section("Mon compte YouTube") {
                    link(.collection(MusicCollection(id: "VLLM", kind: .playlist, title: "Titres likés sur YouTube")),
                         "Titres likés sur YouTube", "hand.thumbsup")
                    link(.account(title: "Mes playlists YouTube", browseID: "FEmusic_liked_playlists"),
                         "Playlists", "music.note.list")
                    link(.account(title: "Mes albums YouTube", browseID: "FEmusic_liked_albums"),
                         "Albums", "square.stack")
                    link(.account(title: "Mes artistes YouTube", browseID: "FEmusic_library_corpus_track_artists"),
                         "Artistes", "music.mic")
                    link(.account(title: "Historique YouTube", browseID: "FEmusic_history"),
                         "Historique", "clock.arrow.circlepath")
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
            ToolbarItem(placement: .topBarLeading) {
                Button {
                    showImport = true
                } label: {
                    Image(systemName: "square.and.arrow.down")
                }
                .accessibilityLabel("Importer")
            }
            ToolbarItem(placement: .topBarTrailing) {
                NavigationLink(value: Route.settings) {
                    Image(systemName: "gearshape")
                }
                .accessibilityLabel("Réglages")
            }
            ToolbarItem(placement: .topBarTrailing) { AccountButton() }
        }
        .sheet(isPresented: $showImport) {
            ImportView()
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

    private func link(_ route: Route, _ title: String, _ icon: String, _ color: Color = .novaAccent,
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

    private func savedCount(_ kind: CollectionKind) -> Int {
        library.saved.filter { $0.kind == kind }.count
    }

    /// Entrée de la grille « Ajouts récents ».
    struct RecentEntry: Hashable {
        let route: Route
        let title: String
        let subtitle: String
        let artwork: [URL]
        let round: Bool
    }

    private var recentlyAdded: [RecentEntry] {
        let playlists = library.playlists.prefix(4).map { playlist in
            RecentEntry(route: .userPlaylist(playlist.id), title: playlist.name,
                        subtitle: playlist.tracks.count == 1 ? "1 titre" : "\(playlist.tracks.count) titres",
                        artwork: playlist.tracks.first?.squareArtworkURLs ?? [], round: false)
        }
        let saved = library.saved.prefix(6).map { collection in
            RecentEntry(route: .collection(collection), title: collection.title,
                        subtitle: savedSubtitle(collection), artwork: collection.artworkURLs,
                        round: collection.kind == .artist)
        }
        return Array((playlists + saved).prefix(6))
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

/// Bibliothèque › Playlists : playlists Nova et playlists enregistrées.
struct LibraryPlaylistsView: View {
    @Environment(LibraryStore.self) private var library
    @Environment(AccountStore.self) private var account
    @Environment(Router.self) private var router
    @State private var showSmartEditor = false

    var body: some View {
        List {
            Button {
                router.newPlaylistTracks = []
            } label: {
                HStack(spacing: 12) {
                    Image(systemName: "plus")
                        .font(.title2)
                        .foregroundStyle(Color.novaAccent)
                        .frame(width: 52, height: 52)
                        .background(.quaternary, in: RoundedRectangle(cornerRadius: 8, style: .continuous))
                    Text("Nouvelle playlist…")
                        .foregroundStyle(Color.novaAccent)
                }
            }
            Button {
                showSmartEditor = true
            } label: {
                HStack(spacing: 12) {
                    Image(systemName: "gearshape")
                        .font(.title2)
                        .foregroundStyle(Color.novaAccent)
                        .frame(width: 52, height: 52)
                        .background(.quaternary, in: RoundedRectangle(cornerRadius: 8, style: .continuous))
                    Text("Nouvelle playlist intelligente…")
                        .foregroundStyle(Color.novaAccent)
                }
            }
            if account.isSignedIn {
                NavigationLink(value: Route.account(title: "Mes playlists YouTube", browseID: "FEmusic_liked_playlists")) {
                    Label("Playlists de mon compte YouTube", systemImage: "person.crop.circle")
                }
            }
            ForEach(library.smartPlaylists) { smart in
                NavigationLink(value: Route.smartPlaylist(smart.id)) {
                    HStack(spacing: 12) {
                        Image(systemName: "gearshape.fill")
                            .font(.title3)
                            .foregroundStyle(.white)
                            .frame(width: 52, height: 52)
                            .background(Color.novaAccent.gradient, in: RoundedRectangle(cornerRadius: 8, style: .continuous))
                        VStack(alignment: .leading, spacing: 2) {
                            Text(smart.name)
                                .lineLimit(1)
                            Text("Playlist intelligente")
                                .font(.subheadline)
                                .foregroundStyle(.secondary)
                        }
                    }
                }
            }
            ForEach(library.playlists) { playlist in
                NavigationLink(value: Route.userPlaylist(playlist.id)) {
                    HStack(spacing: 12) {
                        ArtworkThumb(track: playlist.tracks.first)
                        VStack(alignment: .leading, spacing: 2) {
                            Text(playlist.name)
                                .lineLimit(1)
                            Text(playlist.tracks.count == 1 ? "1 titre" : "\(playlist.tracks.count) titres")
                                .font(.subheadline)
                                .foregroundStyle(.secondary)
                        }
                    }
                }
            }
            .onDelete { library.deletePlaylists(at: $0) }
            ForEach(library.saved.filter { $0.kind == .playlist }) { collection in
                NavigationLink(value: Route.collection(collection)) {
                    CollectionRow(collection: collection)
                }
                .contextMenu { CollectionMenu(collection: collection) }
            }
        }
        .listStyle(.plain)
        .navigationTitle("Playlists")
        .sheet(isPresented: $showSmartEditor) {
            SmartPlaylistEditor(playlist: SmartPlaylist(name: "Playlist intelligente"))
        }
    }
}

/// Bibliothèque › Artistes ou Albums enregistrés.
struct LibraryCollectionsView: View {
    @Environment(LibraryStore.self) private var library
    @Environment(AccountStore.self) private var account
    let kind: CollectionKind

    private var items: [MusicCollection] { library.saved.filter { $0.kind == kind } }

    var body: some View {
        ScrollView {
            if account.isSignedIn {
                NavigationLink(value: Route.account(
                    title: kind == .artist ? "Mes artistes YouTube" : "Mes albums YouTube",
                    browseID: kind == .artist ? "FEmusic_library_corpus_track_artists" : "FEmusic_liked_albums")) {
                    Label(kind == .artist ? "Artistes de mon compte YouTube" : "Albums de mon compte YouTube",
                          systemImage: "person.crop.circle")
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .padding(16)
                }
            }
            if kind == .artist {
                LazyVStack(spacing: 10) {
                    ForEach(items) { collection in
                        ItemRow(item: .collection(collection)) { _ in }
                    }
                }
                .padding(.horizontal, 16)
            } else {
                LazyVGrid(columns: [GridItem(.flexible(), spacing: 16), GridItem(.flexible(), spacing: 16)], spacing: 20) {
                    ForEach(items) { collection in
                        NavigationLink(value: Route.collection(collection)) {
                            VStack(alignment: .leading, spacing: 6) {
                                RemoteImage(urls: collection.artworkURLs)
                                    .aspectRatio(1, contentMode: .fit)
                                    .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
                                Text(collection.title)
                                    .font(.subheadline.weight(.medium))
                                    .foregroundStyle(Color.primary)
                                    .lineLimit(1)
                                Text(collection.subtitle)
                                    .font(.caption)
                                    .foregroundStyle(.secondary)
                                    .lineLimit(1)
                            }
                        }
                        .buttonStyle(.plain)
                        .contextMenu { CollectionMenu(collection: collection) }
                    }
                }
                .padding(16)
            }
        }
        .overlay {
            if items.isEmpty && !account.isSignedIn {
                ContentUnavailableView(kind == .artist ? "Aucun artiste" : "Aucun album",
                                       systemImage: kind == .artist ? "music.mic" : "square.stack",
                                       description: Text(kind == .artist
                                                         ? "Suis un artiste depuis sa page pour le retrouver ici."
                                                         : "Ajoute un album à ta bibliothèque avec le bouton signet."))
            }
        }
        .navigationTitle(kind == .artist ? "Artistes" : "Albums")
    }
}
