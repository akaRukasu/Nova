import SwiftUI

/// Rubriques de la bibliothèque, masquables et réordonnables (bouton « Modifier »).
enum LibrarySection: String, CaseIterable, Identifiable {
    case playlists, artists, albums, songs, liked, downloads, history, wrapped, releases, concerts, youtube, importer

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
        case .wrapped: return "Récap annuel"
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
        case .wrapped: return "sparkles"
        case .releases: return "sparkles.rectangle.stack"
        case .concerts: return "ticket"
        case .youtube: return "person.crop.circle"
        case .importer: return "square.and.arrow.down.on.square"
        }
    }

    static let defaultOrder: [LibrarySection] = [.playlists, .artists, .albums, .songs, .liked, .downloads, .history, .wrapped, .releases, .concerts]
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
            if sectionsVersion < 3 {
                save(enabled + [.history, .wrapped].filter { !enabled.contains($0) })
                sectionsVersion = 3
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
        case .wrapped: return .wrapped
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
        case .youtube, .importer, .releases, .concerts, .wrapped: return nil
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
        case .group(let group):
            NavigationLink(value: Route.libraryGroup(.album, group.id)) {
                tileLabel(urls: group.artwork.squareArtworkURLs, title: group.title,
                          subtitle: group.artist + " · " + group.releaseType, round: false)
            }
            .buttonStyle(.plain)
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
    let tracks: [Track]
    var emptyTitle = "Aucun titre"
    var emptyIcon = "music.note"
    var emptyMessage = ""
    var onDelete: ((IndexSet) -> Void)?
    var onMove: ((IndexSet, Int) -> Void)?
    /// Liste triable (bouton « Trier »), tri mémorisé sous cette clé.
    var sortKey: String?
    var manualSortLabel = "Ordre de la playlist"
    var source: PlaybackSource = .octave
    var playlistID: UUID?

    var body: some View {
        if let sortKey {
            SortedTracksList(list: self, state: SortState(key: sortKey))
        } else {
            TracksListBody(list: self, order: Array(tracks.indices), sorted: false)
        }
    }
}

private struct SortedTracksList: View {
    @Environment(LibraryStore.self) private var library
    let list: LocalTracksList
    let state: SortState

    var body: some View {
        TracksListBody(list: list, order: state.sort.order(list.tracks, stats: library.stats, reversed: state.reversed), sorted: !state.isManual)
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    SortMenu(state: state, manualLabel: list.manualSortLabel)
                }
            }
    }
}

/// Liste des titres dans l'ordre affiché (`order` : positions dans la liste d'origine).
private struct TracksListBody: View {
    @Environment(PlayerModel.self) private var player
    let list: LocalTracksList
    let order: [Int]
    /// Trié autrement que dans l'ordre de la liste : on ne peut pas déplacer les titres à la main.
    let sorted: Bool

    var body: some View {
        let shown = order.map { list.tracks[$0] }
        List {
            if !shown.isEmpty {
                Section {
                    PlayShuffleButtons {
                        player.play(shown, source: list.source, playlistID: list.playlistID)
                    } shuffle: {
                        player.play(shown, shuffled: true, source: list.source, playlistID: list.playlistID)
                    }
                    .listRowSeparator(.hidden)
                    .listRowBackground(Color.clear)
                }
                Section {
                    ForEach(Array(shown.enumerated()), id: \.offset) { position, track in
                        TrackRowButton(track: track, onRemove: list.onDelete == nil ? nil : { list.onDelete?(IndexSet(integer: order[position])) }) {
                            player.play(shown, startAt: position, source: list.source, playlistID: list.playlistID)
                        }
                    }
                    .onDelete(perform: list.onDelete.map { delete in { (positions: IndexSet) in delete(IndexSet(positions.map { order[$0] })) } })
                    .onMove(perform: sorted ? nil : list.onMove)
                } footer: {
                    let total = shown.compactMap(\.duration).reduce(0, +)
                    let count = shown.count == 1 ? "1 titre" : "\(shown.count) titres"
                    Text(total > 0 ? "\(count) • \(total.longDurationString)" : count)
                }
            }
        }
        .listStyle(.plain)
        .overlay {
            if shown.isEmpty {
                ContentUnavailableView(list.emptyTitle, systemImage: list.emptyIcon, description: Text(list.emptyMessage))
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
                        onDelete: { library.removeLiked(at: $0) },
                        sortKey: "liked",
                        manualSortLabel: "Derniers likés")
            .navigationTitle("Titres likés")
    }
}

/// Historique complet, groupé par jour (Aujourd'hui, Hier, lundi…), avec recherche.
struct HistoryView: View {
    @Environment(LibraryStore.self) private var library
    @Environment(PlayerModel.self) private var player
    @State private var confirmClear = false
    @State private var filter = ""

    private struct Entry: Identifiable {
        /// Position dans `library.recents`.
        let position: Int
        let track: Track
        var id: Int { position }
    }

    private struct Day: Identifiable {
        let id: String
        let title: String
        let entries: [Entry]
    }

    private var visible: [Entry] {
        let all = library.recents.enumerated().map { Entry(position: $0.offset, track: $0.element) }
        let query = filter.trimmingCharacters(in: .whitespaces)
        guard !query.isEmpty else { return all }
        return all.filter {
            $0.track.title.localizedCaseInsensitiveContains(query) || $0.track.artist.localizedCaseInsensitiveContains(query)
        }
    }

    private var days: [Day] {
        let calendar = Calendar.current
        var result: [Day] = []
        for entry in visible {
            let date = library.stats[entry.track.id]?.lastPlayed
            let title = Self.dayTitle(date, calendar: calendar)
            if let last = result.last, last.title == title {
                result[result.count - 1] = Day(id: last.id, title: title, entries: last.entries + [entry])
            } else {
                result.append(Day(id: "\(result.count)-\(title)", title: title, entries: [entry]))
            }
        }
        return result
    }

    private static func dayTitle(_ date: Date?, calendar: Calendar) -> String {
        guard let date else { return "Plus ancien" }
        if calendar.isDateInToday(date) { return "Aujourd'hui" }
        if calendar.isDateInYesterday(date) { return "Hier" }
        let days = calendar.dateComponents([.day], from: calendar.startOfDay(for: date), to: calendar.startOfDay(for: Date())).day ?? 99
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "fr_FR")
        formatter.dateFormat = days < 7 ? "EEEE" : (calendar.isDate(date, equalTo: Date(), toGranularity: .year) ? "EEEE d MMMM" : "d MMMM yyyy")
        return formatter.string(from: date).capitalized(with: Locale(identifier: "fr_FR"))
    }

    var body: some View {
        let tracks = visible.map(\.track)
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
                } footer: {
                    Text(tracks.count == 1 ? "1 titre écouté" : "\(tracks.count) titres écoutés")
                }
            }
            ForEach(days) { day in
                Section(day.title) {
                    ForEach(day.entries) { entry in
                        TrackRowButton(track: entry.track,
                                       onRemove: { library.removeRecents(at: IndexSet(integer: entry.position)) }) {
                            player.play(tracks, startAt: tracks.firstIndex(of: entry.track) ?? 0)
                        }
                        .overlay(alignment: .trailing) {
                            if let count = library.stats[entry.track.id]?.playCount, count > 1 {
                                Text("×\(count)")
                                    .font(.caption2.weight(.semibold))
                                    .foregroundStyle(.secondary)
                                    .padding(.trailing, 44)
                                    .allowsHitTesting(false)
                            }
                        }
                    }
                    .onDelete { offsets in
                        library.removeRecents(at: IndexSet(offsets.map { day.entries[$0].position }))
                    }
                }
            }
        }
        .listStyle(.plain)
        .searchable(text: $filter, prompt: "Rechercher dans l'historique")
        .overlay {
            if library.recents.isEmpty {
                ContentUnavailableView("Historique vide", systemImage: "clock",
                                       description: Text("Les titres que tu écoutes apparaîtront ici."))
            } else if tracks.isEmpty {
                ContentUnavailableView.search(text: filter)
            }
        }
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
                        },
                        sortKey: "downloads",
                        manualSortLabel: "Ordre de téléchargement",
                        source: .youtube)
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
    @State private var octaveVerification: String?
    @State private var verificationResult: String?

    var body: some View {
        let playlist = library.playlist(id)
        LocalTracksList(tracks: playlist?.tracks ?? [],
                        emptyTitle: "Playlist vide",
                        emptyIcon: "music.note.list",
                        emptyMessage: "Ajoute des titres avec le menu « … » › Ajouter à une playlist.",
                        onDelete: { library.removeTracks(at: $0, from: id) },
                        onMove: { library.moveTracks(from: $0, to: $1, in: id) },
                        sortKey: "playlist.\(id.uuidString)",
                        source: PlaybackSettings.playlistSource,
                        playlistID: id)
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
                            Button(octaveVerification ?? "Vérifier sur Octave", systemImage: "checkmark.circle") {
                                Task { await verify(tracks) }
                            }
                            .disabled(octaveVerification != nil)
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
            .alert("Correspondances Octave", isPresented: Binding(get: { verificationResult != nil },
                                                                  set: { if !$0 { verificationResult = nil } })) {
                Button("OK") { verificationResult = nil }
            } message: { Text(verificationResult ?? "") }
    }

    private func verify(_ tracks: [Track]) async {
        guard octaveVerification == nil else { return }
        let candidates = tracks.filter { !$0.id.hasPrefix("octave:") || $0.albumID == nil }
        var replacements: [String: Track] = [:]
        for (position, track) in candidates.enumerated() {
            octaveVerification = "\(position + 1) / \(candidates.count)"
            if let recording = await ImportManager.resolveOctave(track), recording.id != track.id { replacements[track.id] = recording }
        }
        library.applyVerifiedRecordings(replacements, in: id)
        octaveVerification = nil
        verificationResult = replacements.isEmpty ? "Aucune nouvelle correspondance." : "\(replacements.count) correspondances corrigées."
    }
}

/// Bibliothèque › Playlists : playlists Nova et playlists enregistrées.
struct LibraryPlaylistsView: View {
    @Environment(LibraryStore.self) private var library
    @Environment(AccountStore.self) private var account
    @Environment(Router.self) private var router
    @State private var showSmartEditor = false
    @AppStorage("novaPlaylistSort") private var playlistSort = PlaylistSort.manual

    private enum PlaylistSort: String, CaseIterable, Identifiable {
        case manual = "Ordre manuel"
        case az = "Nom A à Z"
        case za = "Nom Z à A"
        case played = "Écoutées récemment"
        case added = "Ajoutées récemment"

        var id: String { rawValue }
    }

    private var sortMenu: some View {
        Menu {
            ForEach(PlaylistSort.allCases) { sort in
                Button {
                    playlistSort = sort
                } label: {
                    if sort == playlistSort {
                        Label(sort.rawValue, systemImage: "checkmark")
                    } else {
                        Text(sort.rawValue)
                    }
                }
            }
        } label: {
            Label("Trier · " + playlistSort.rawValue, systemImage: "arrow.up.arrow.down")
        }
    }

    private var orderedPlaylists: [UserPlaylist] {
        switch playlistSort {
        case .manual: return library.playlists
        case .az: return library.playlists.sorted { $0.name.localizedStandardCompare($1.name) == .orderedAscending }
        case .za: return library.playlists.sorted { $0.name.localizedStandardCompare($1.name) == .orderedDescending }
        case .added: return library.playlists.sorted { $0.createdAt > $1.createdAt }
        case .played:
            return library.playlists.sorted {
                let first = $0.lastPlayedAt ?? .distantPast
                let second = $1.lastPlayedAt ?? .distantPast
                return first == second ? $0.createdAt > $1.createdAt : first > second
            }
        }
    }

    var body: some View {
        let playlists = orderedPlaylists
        List {
            if playlists.count > 1 { sortMenu }
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
            SharedPlaylistsSection()
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
            ForEach(playlists) { playlist in
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
                .moveDisabled(playlistSort != .manual)
            }
            .onDelete { offsets in
                for index in offsets { library.deletePlaylist(playlists[index].id) }
            }
            .onMove { from, to in
                if playlistSort == .manual { library.movePlaylists(from: from, to: to) }
            }
            ForEach(library.saved.filter { $0.kind == .playlist }) { collection in
                NavigationLink(value: Route.collection(collection)) {
                    CollectionRow(collection: collection)
                }
                .contextMenu { CollectionMenu(collection: collection) }
            }
        }
        .listStyle(.plain)
        .navigationTitle("Playlists")
        .toolbar { if library.playlists.count > 1 { EditButton() } }
        .sheet(isPresented: $showSmartEditor) {
            SmartPlaylistEditor(playlist: SmartPlaylist(name: "Playlist intelligente"))
        }
    }
}

/// Playlists collaboratives (YouTube Music) : créer, rejoindre, inviter.
struct SharedPlaylistsSection: View {
    @Environment(AccountStore.self) private var account
    @Environment(\.openURL) private var openURL
    private let shared = SharedPlaylists.shared
    @State private var askName = false
    @State private var askLink = false
    @State private var name = ""
    @State private var link = ""
    @State private var guide: SharedPlaylists.Entry?
    @State private var message: String?

    var body: some View {
        Section {
            if account.isSignedIn {
                Button { name = ""; askName = true } label: {
                    Label("Nouvelle playlist partagée…", systemImage: "person.2.badge.plus")
                }
                Button { link = ""; askLink = true } label: {
                    Label("Rejoindre avec un lien d'invitation…", systemImage: "link")
                }
                ForEach(shared.entries) { entry in
                    NavigationLink(value: Route.collection(entry.collection)) {
                        CollectionRow(collection: entry.collection)
                    }
                    .contextMenu {
                        Button("Inviter des amis", systemImage: "person.badge.plus") { guide = entry }
                        Button("Ouvrir dans YouTube Music", systemImage: "arrow.up.forward.app") { openURL(entry.youtubeURL) }
                        Button("Retirer de Nova", systemImage: "minus.circle", role: .destructive) { shared.remove(entry) }
                    }
                }
            } else {
                Text("Connecte ton compte YouTube (Réglages) pour créer des playlists partagées avec tes amis.")
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
            }
        } header: {
            Text("Playlists partagées")
        }
        .alert("Nouvelle playlist partagée", isPresented: $askName) {
            TextField("Nom", text: $name)
            Button("Créer") {
                let title = name.trimmingCharacters(in: .whitespaces)
                guard !title.isEmpty else { return }
                Task {
                    do { guide = try await shared.create(title: title) } catch { message = "Création impossible : \(error.localizedDescription)" }
                }
            }
            Button("Annuler", role: .cancel) {}
        } message: {
            Text("Elle est créée sur ton compte YouTube ; tu invites ensuite tes amis depuis YouTube Music.")
        }
        .alert("Rejoindre une playlist partagée", isPresented: $askLink) {
            TextField("Lien d'invitation", text: $link)
            Button("Rejoindre") {
                guard let id = SharedPlaylists.playlistID(in: link), let url = URL(string: link.trimmingCharacters(in: .whitespacesAndNewlines)) else {
                    message = "Ce lien ne contient pas de playlist YouTube."
                    return
                }
                // L'invitation s'accepte dans YouTube Music ; Nova ajoute ensuite la playlist à la liste.
                openURL(url)
                Task { await shared.add(id: id) }
            }
            Button("Annuler", role: .cancel) {}
        } message: {
            Text("Colle le lien reçu de ton ami : YouTube Music s'ouvre, accepte l'invitation, puis reviens dans Nova.")
        }
        .alert("Playlists partagées", isPresented: Binding(get: { message != nil }, set: { if !$0 { message = nil } })) {
            Button("OK", role: .cancel) {}
        } message: {
            Text(message ?? "")
        }
        .sheet(item: $guide) { entry in
            SharedPlaylistGuide(entry: entry)
                .presentationDetents([.medium, .large])
        }
    }
}

/// Inviter des amis : la collaboration s'active une fois dans YouTube Music.
struct SharedPlaylistGuide: View {
    let entry: SharedPlaylists.Entry
    @Environment(\.openURL) private var openURL
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            List {
                Section {
                    Label("Ouvre la playlist dans YouTube Music.", systemImage: "1.circle.fill")
                    Label("Touche « ⋯ » puis « Collaborer », et active la collaboration.", systemImage: "2.circle.fill")
                    Label("Copie le lien d'invitation et envoie-le à tes amis.", systemImage: "3.circle.fill")
                    Label("Eux : Nova → Bibliothèque → Playlists → « Rejoindre avec un lien d'invitation ».", systemImage: "4.circle.fill")
                } footer: {
                    Text("Ensuite, chacun ajoute des titres depuis Nova (menu « … » d'un titre → Ajouter à une playlist) ; la playlist se met à jour chez tout le monde.")
                }
                Section {
                    Button {
                        openURL(entry.youtubeURL)
                    } label: {
                        Label("Ouvrir dans YouTube Music", systemImage: "arrow.up.forward.app")
                    }
                }
            }
            .navigationTitle(entry.title)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) { Button("OK") { dismiss() } }
            }
        }
    }
}

/// Bibliothèque › Artistes ou Albums enregistrés.
struct LibraryCollectionsView: View {
    @Environment(LibraryStore.self) private var library
    @Environment(AccountStore.self) private var account
    let kind: CollectionKind
    @State private var query = ""

    var body: some View {
        let groups = library.musicGroups(kind: kind)
        let visible = groups.filter { query.isEmpty || $0.title.localizedCaseInsensitiveContains(query) }
        let known = Set(groups.flatMap { $0.tracks.compactMap { kind == .artist ? $0.artistID : $0.albumID } })
        let items = library.saved.filter { $0.kind == kind && !known.contains($0.id) && (query.isEmpty || $0.title.localizedCaseInsensitiveContains(query)) }
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
            LazyVGrid(columns: [GridItem(.adaptive(minimum: 145), spacing: 16)], spacing: 20) {
                ForEach(visible) { group in
                    NavigationLink(value: Route.libraryGroup(kind, group.id)) {
                        VStack(alignment: .leading, spacing: 6) {
                            RemoteImage(urls: group.artwork.squareArtworkURLs)
                                .aspectRatio(1, contentMode: .fit)
                                .clipShape(kind == .artist ? AnyShape(Circle()) : AnyShape(RoundedRectangle(cornerRadius: 12)))
                            Text(group.title).font(.subheadline.weight(.semibold)).lineLimit(2)
                            Text(kind == .artist ? "\(group.tracks.count) titres" : group.artist + " · " + group.releaseType)
                                .font(.caption).foregroundStyle(.secondary).lineLimit(1)
                        }
                    }
                    .buttonStyle(.plain)
                }
            }
            .padding(16)
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
            if items.isEmpty && visible.isEmpty && !account.isSignedIn {
                ContentUnavailableView(kind == .artist ? "Aucun artiste" : "Aucun album",
                                       systemImage: kind == .artist ? "music.mic" : "square.stack",
                                       description: Text(kind == .artist
                                                         ? "Suis un artiste depuis sa page pour le retrouver ici."
                                                         : "Ajoute un album à ta bibliothèque avec le bouton signet."))
            }
        }
        .navigationTitle(kind == .artist ? "Artistes" : "Albums")
        .searchable(text: $query, prompt: "Filtrer la bibliothèque")
    }
}

struct LibraryGroupView: View {
    @Environment(LibraryStore.self) private var library
    @Environment(PlayerModel.self) private var player
    let kind: CollectionKind
    let id: String

    var body: some View {
        if let group = library.musicGroups(kind: kind, singles: true).first(where: { $0.id == id }) {
            List {
                Section {
                    VStack(alignment: .leading, spacing: 12) {
                        RemoteImage(urls: group.artwork.squareArtworkURLs)
                            .frame(width: 160, height: 160)
                            .clipShape(RoundedRectangle(cornerRadius: 16))
                        if kind == .album { Text(group.artist + " · " + group.releaseType).foregroundStyle(.secondary) }
                        Button { player.play(group.tracks) } label: { Label("Lecture", systemImage: "play.fill") }
                            .buttonStyle(.borderedProminent)
                    }
                    .padding(.vertical, 8)
                }
                ForEach(Array(group.tracks.enumerated()), id: \.element.id) { index, track in
                    TrackRowButton(track: track) { player.play(group.tracks, startAt: index) }
                }
            }
            .navigationTitle(group.title)
        } else {
            ContentUnavailableView("Sortie introuvable", systemImage: "square.stack")
        }
    }
}
