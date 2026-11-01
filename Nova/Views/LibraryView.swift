import SwiftUI

/// Rubriques de la bibliothèque, masquables et réordonnables (bouton « Modifier »).
enum LibrarySection: String, CaseIterable, Identifiable {
    case playlists, artists, albums, songs, liked, downloads, history, releases, concerts, youtube, importer

    var id: String { rawValue }

    var title: String {
        switch self {
        case .playlists: return "Playlists"
        case .artists: return "Artistes"
        case .albums: return "Albums"
        case .songs: return "Morceaux"
        case .liked: return "Titres likés"
        case .downloads: return "Téléchargés"
        case .history: return "Historique"
        case .releases: return "Sorties"
        case .concerts: return "Concerts"
        case .youtube: return "Mon compte YouTube"
        case .importer: return "Importer"
        }
    }

    var icon: String {
        switch self {
        case .playlists: return "music.note.list"
        case .artists: return "music.mic"
        case .albums: return "square.stack"
        case .songs: return "music.note"
        case .liked: return "heart"
        case .downloads: return "arrow.down.circle"
        case .history: return "clock"
        case .releases: return "sparkles.rectangle.stack"
        case .concerts: return "ticket"
        case .youtube: return "person.crop.circle"
        case .importer: return "square.and.arrow.down.on.square"
        }
    }

    static let defaultOrder: [LibrarySection] = [.playlists, .artists, .albums, .songs, .liked, .downloads, .releases, .concerts]
}

struct LibraryView: View {
    @Environment(LibraryStore.self) private var library
    @Environment(DownloadStore.self) private var downloads
    @Environment(AccountStore.self) private var account
    @Environment(ImportManager.self) private var importer
    @Environment(PlayerModel.self) private var player
    @AppStorage("librarySections") private var sectionsRaw = LibrarySection.defaultOrder.map(\.rawValue).joined(separator: ",")
    @State private var editing = false
    @State private var showImport = false
    @AppStorage("librarySectionsVersion") private var sectionsVersion = 1

    private var enabled: [LibrarySection] {
        sectionsRaw.split(separator: ",").compactMap { LibrarySection(rawValue: String($0)) }
    }

    /// Toutes les rubriques : celles affichées d'abord, dans leur ordre, puis les masquées.
    private var allSections: [LibrarySection] {
        enabled + LibrarySection.allCases.filter { !enabled.contains($0) }
    }

    var body: some View {
        Group {
            if editing {
                editor
            } else {
                content
            }
        }
        .navigationTitle("Bibliothèque")
        .toolbar {
            ToolbarItem(placement: .topBarLeading) {
                Button(editing ? "OK" : "Modifier") {
                    withAnimation { editing.toggle() }
                }
                .fontWeight(editing ? .semibold : .regular)
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
        .onAppear {
            // Nouvelles rubriques (Sorties, Concerts) ajoutées une fois aux réglages existants.
            if sectionsVersion < 2 {
                save(enabled + [.releases, .concerts].filter { !enabled.contains($0) })
                sectionsVersion = 2
            }
        }
    }

    // MARK: Affichage

    private var content: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 0) {
                if importer.isRunning {
                    Button { showImport = true } label: {
                        HStack(spacing: 12) {
                            ProgressView()
                            Text("Import en cours…")
                            Spacer()
                            Image(systemName: "chevron.right").foregroundStyle(.tertiary)
                        }
                        .padding(16)
                    }
                    .buttonStyle(.plain)
                }

                ForEach(enabled) { section in
                    row(section)
                    Divider().padding(.leading, 58)
                }

                recentGrid
                    .padding(.top, 28)
            }
            .padding(.bottom, 24)
        }
    }

    @ViewBuilder private func row(_ section: LibrarySection) -> some View {
        let label = HStack(spacing: 16) {
            Image(systemName: section.icon)
                .font(.title3)
                .foregroundStyle(Color.novaAccent)
                .frame(width: 28)
            Text(section.title)
                .font(.title3)
                .foregroundStyle(Color.primary)
            Spacer()
            if let count = count(for: section), count > 0 {
                Text("\(count)")
                    .foregroundStyle(.secondary)
            }
            Image(systemName: "chevron.right")
                .font(.footnote.weight(.semibold))
                .foregroundStyle(.tertiary)
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 13)
        .contentShape(Rectangle())

        if section == .importer {
            Button { showImport = true } label: { label }
                .buttonStyle(.plain)
        } else if let route = route(for: section) {
            NavigationLink(value: route) { label }
                .buttonStyle(.plain)
        }
    }

    private func route(for section: LibrarySection) -> Route? {
        switch section {
        case .playlists: return .libraryPlaylists
        case .artists: return .libraryArtists
        case .albums: return .libraryAlbums
        case .songs: return .songs
        case .liked: return .liked
        case .downloads: return .downloads
        case .history: return .history
        case .releases: return .releases
        case .concerts: return .concerts(artist: nil)
        case .youtube:
            return account.isSignedIn
                ? .account(title: "Mon compte YouTube", browseID: "FEmusic_liked_playlists")
                : .settings
        case .importer: return nil
        }
    }

    private func count(for section: LibrarySection) -> Int? {
        switch section {
        case .playlists: return library.playlists.count + library.smartPlaylists.count + library.saved.filter { $0.kind == .playlist }.count
        case .artists: return library.saved.filter { $0.kind == .artist }.count
        case .albums: return library.saved.filter { $0.kind == .album }.count
        case .songs: return library.songs.count
        case .liked: return library.liked.count
        case .downloads: return downloads.tracks.count
        case .history: return library.recents.count
        case .youtube, .importer, .releases, .concerts: return nil
        }
    }

    // MARK: Ajouts récents

    @ViewBuilder private var recentGrid: some View {
        let additions = library.recentAdditions()
        VStack(alignment: .leading, spacing: 14) {
            Text("Ajouts récents")
                .font(.title2.weight(.bold))
                .padding(.horizontal, 16)
            if additions.isEmpty {
                Text("Ajoute des titres, des albums ou des playlists avec le bouton + dans la recherche : ils apparaîtront ici.")
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
                    .padding(.horizontal, 16)
            } else {
                LazyVGrid(columns: [GridItem(.flexible(), spacing: 16), GridItem(.flexible(), spacing: 16)],
                          alignment: .leading, spacing: 22) {
                    ForEach(additions) { addition in
                        tile(addition)
                    }
                }
                .padding(.horizontal, 16)
            }
        }
    }

    @ViewBuilder private func tile(_ addition: LibraryStore.RecentAddition) -> some View {
        switch addition {
        case .track(let track):
            Button { player.startRadio(from: track) } label: {
                tileLabel(urls: track.squareArtworkURLs, title: track.title, subtitle: track.artist, round: false)
            }
            .buttonStyle(.plain)
            .contextMenu { TrackMenu(track: track) }
        case .collection(let collection):
            NavigationLink(value: Route.collection(collection)) {
                tileLabel(urls: collection.artworkURLs, title: collection.title,
                          subtitle: collection.subtitle.isEmpty ? collection.kind.label : collection.subtitle,
                          round: collection.kind == .artist)
            }
            .buttonStyle(.plain)
            .contextMenu { CollectionMenu(collection: collection) }
        case .playlist(let playlist):
            NavigationLink(value: Route.userPlaylist(playlist.id)) {
                tileLabel(urls: playlist.tracks.first?.squareArtworkURLs ?? [], title: playlist.name,
                          subtitle: playlist.tracks.count == 1 ? "1 titre" : "\(playlist.tracks.count) titres",
                          round: false)
            }
            .buttonStyle(.plain)
        }
    }

    private func tileLabel(urls: [URL], title: String, subtitle: String, round: Bool) -> some View {
        VStack(alignment: round ? .center : .leading, spacing: 6) {
            RemoteImage(urls: urls)
                .aspectRatio(1, contentMode: .fit)
                .clipShape(round ? AnyShape(Circle()) : AnyShape(RoundedRectangle(cornerRadius: 10, style: .continuous)))
                .shadow(color: .black.opacity(0.15), radius: 6, y: 3)
            Text(title)
                .font(.subheadline.weight(.medium))
                .foregroundStyle(Color.primary)
                .lineLimit(1)
            Text(subtitle)
                .font(.caption)
                .foregroundStyle(.secondary)
                .lineLimit(1)
        }
        .frame(maxWidth: .infinity, alignment: round ? .center : .leading)
        .contentShape(Rectangle())
    }

    // MARK: Modification

    private var editor: some View {
        List {
            Section {
                ForEach(allSections) { section in
                    let shown = enabled.contains(section)
                    Button {
                        toggle(section)
                    } label: {
                        HStack(spacing: 14) {
                            Image(systemName: shown ? "checkmark.circle.fill" : "circle")
                                .font(.title3)
                                .foregroundStyle(shown ? Color.novaAccent : .secondary)
                            Image(systemName: section.icon)
                                .foregroundStyle(Color.novaAccent)
                                .frame(width: 26)
                            Text(section.title)
                                .foregroundStyle(Color.primary)
                        }
                    }
                    .buttonStyle(.plain)
                }
                .onMove(perform: move)
            } footer: {
                Text("Coche les rubriques à afficher et fais-les glisser pour les réordonner.")
            }
        }
        .environment(\.editMode, .constant(.active))
    }

    private func save(_ sections: [LibrarySection]) {
        sectionsRaw = sections.map(\.rawValue).joined(separator: ",")
    }

    private func toggle(_ section: LibrarySection) {
        if enabled.contains(section) {
            save(enabled.filter { $0 != section })
        } else {
            // On l'insère à sa place dans l'ordre complet.
            let order = allSections
            save(order.filter { enabled.contains($0) || $0 == section })
        }
    }

    private func move(from source: IndexSet, to destination: Int) {
        var order = allSections
        order.move(fromOffsets: source, toOffset: destination)
        let shown = Set(enabled)
        save(order.filter { shown.contains($0) })
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
