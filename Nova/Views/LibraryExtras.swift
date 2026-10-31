import SwiftUI

// MARK: - Morceaux

/// Tous les morceaux de la bibliothèque, comme dans Apple Music : un seul exemplaire de chaque titre,
/// qu'il vienne des titres likés, d'une playlist ou des téléchargements.
struct SongsView: View {
    @Environment(LibraryStore.self) private var library
    @Environment(DownloadStore.self) private var downloads
    @Environment(PlayerModel.self) private var player
    @State private var query = ""
    @AppStorage("songsSort") private var sort: SongSort = .title

    enum SongSort: String, CaseIterable, Identifiable {
        case title = "Titre"
        case artist = "Artiste"
        case album = "Album"
        case recentlyAdded = "Ajout récent"
        case mostPlayed = "Les plus écoutés"

        var id: String { rawValue }
    }

    private var allSongs: [Track] {
        var seenIDs = Set<String>()
        var seenKeys = Set<String>()
        return (library.songs + downloads.tracks).filter { track in
            seenIDs.insert(track.id).inserted && seenKeys.insert(LibraryStore.dedupeKey(track)).inserted
        }
    }

    private var visible: [Track] {
        let text = query.trimmingCharacters(in: .whitespaces)
        var songs = allSongs
        if !text.isEmpty {
            songs = songs.filter {
                $0.title.localizedCaseInsensitiveContains(text)
                    || $0.artist.localizedCaseInsensitiveContains(text)
                    || ($0.album ?? "").localizedCaseInsensitiveContains(text)
            }
        }
        let stats = library.stats
        switch sort {
        case .title:
            songs.sort { $0.title.localizedCaseInsensitiveCompare($1.title) == .orderedAscending }
        case .artist:
            songs.sort { $0.artist.localizedCaseInsensitiveCompare($1.artist) == .orderedAscending }
        case .album:
            songs.sort { ($0.album ?? "").localizedCaseInsensitiveCompare($1.album ?? "") == .orderedAscending }
        case .recentlyAdded:
            songs.sort { (stats[$0.id]?.added ?? .distantPast) > (stats[$1.id]?.added ?? .distantPast) }
        case .mostPlayed:
            songs.sort { (stats[$0.id]?.playCount ?? 0) > (stats[$1.id]?.playCount ?? 0) }
        }
        return songs
    }

    var body: some View {
        let songs = visible
        List {
            if !songs.isEmpty {
                Section {
                    PlayShuffleButtons {
                        player.play(songs)
                    } shuffle: {
                        player.play(songs, shuffled: true)
                    }
                    .listRowSeparator(.hidden)
                    .listRowBackground(Color.clear)
                }
                Section {
                    ForEach(Array(songs.enumerated()), id: \.element.id) { position, track in
                        TrackRowButton(track: track) {
                            player.play(songs, startAt: position)
                        }
                    }
                } footer: {
                    Text(songs.count == 1 ? "1 morceau" : "\(songs.count) morceaux")
                }
            }
        }
        .listStyle(.plain)
        .overlay {
            if allSongs.isEmpty {
                ContentUnavailableView("Aucun morceau", systemImage: "music.note",
                                       description: Text("Les titres que tu likes, que tu ajoutes à tes playlists ou que tu télécharges apparaissent ici, sans doublons."))
            } else if songs.isEmpty {
                ContentUnavailableView.search(text: query)
            }
        }
        .searchable(text: $query, prompt: "Rechercher dans les morceaux")
        .navigationTitle("Morceaux")
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                Menu {
                    Picker("Trier par", selection: $sort) {
                        ForEach(SongSort.allCases) { Text($0.rawValue).tag($0) }
                    }
                } label: {
                    Image(systemName: "arrow.up.arrow.down")
                }
            }
        }
    }
}

// MARK: - Playlists intelligentes

struct SmartPlaylistView: View {
    @Environment(LibraryStore.self) private var library
    @Environment(DownloadStore.self) private var downloads
    @Environment(PlayerModel.self) private var player
    @Environment(\.dismiss) private var dismiss
    let id: UUID
    @State private var editing = false
    @State private var confirmDelete = false

    var body: some View {
        let playlist = library.smartPlaylist(id)
        let tracks = playlist.map { library.tracks(for: $0, downloads: downloads.tracks) } ?? []
        LocalTracksList(tracks: tracks,
                        emptyTitle: "Aucun titre ne correspond",
                        emptyIcon: "gearshape",
                        emptyMessage: "Modifie les règles pour élargir la sélection. La liste se met à jour toute seule.")
            .navigationTitle(playlist?.name ?? "Playlist intelligente")
            .toolbar {
                ToolbarItemGroup(placement: .topBarTrailing) {
                    Button("Modifier") { editing = true }
                    Menu {
                        Button("Copier dans une playlist", systemImage: "doc.on.doc") {
                            library.createPlaylist(name: playlist?.name ?? "Playlist", tracks: tracks)
                        }
                        Button("Supprimer", systemImage: "trash", role: .destructive) { confirmDelete = true }
                    } label: {
                        Image(systemName: "ellipsis")
                    }
                }
            }
            .sheet(isPresented: $editing) {
                if let playlist {
                    SmartPlaylistEditor(playlist: playlist)
                }
            }
            .confirmationDialog("Supprimer cette playlist intelligente ?", isPresented: $confirmDelete, titleVisibility: .visible) {
                Button("Supprimer", role: .destructive) {
                    library.deleteSmartPlaylist(id)
                    dismiss()
                }
            }
    }
}

/// Éditeur de règles, comme les listes de lecture intelligentes d'iTunes.
struct SmartPlaylistEditor: View {
    @Environment(LibraryStore.self) private var library
    @Environment(DownloadStore.self) private var downloads
    @Environment(\.dismiss) private var dismiss
    @State private var playlist: SmartPlaylist
    @State private var limited = false

    init(playlist: SmartPlaylist) {
        _playlist = State(initialValue: playlist)
    }

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    TextField("Nom", text: $playlist.name)
                }
                Section {
                    Picker("Correspondance", selection: $playlist.matchAll) {
                        Text("Tous les critères").tag(true)
                        Text("Au moins un critère").tag(false)
                    }
                    ForEach($playlist.rules) { $rule in
                        RuleEditor(rule: $rule)
                    }
                    .onDelete { playlist.rules.remove(atOffsets: $0) }
                    Button("Ajouter une règle", systemImage: "plus.circle") {
                        playlist.rules.append(SmartRule())
                    }
                } header: {
                    Text("Règles")
                }
                Section {
                    Toggle("Limiter à", isOn: $limited)
                    if limited {
                        Stepper("\(playlist.limit ?? 25) titres", value: Binding(
                            get: { playlist.limit ?? 25 },
                            set: { playlist.limit = $0 }
                        ), in: 5...1000, step: 5)
                    }
                    Picker("Classer par", selection: $playlist.sort) {
                        ForEach(SmartSort.allCases) { Text($0.label).tag($0) }
                    }
                } footer: {
                    let count = library.tracks(for: currentPlaylist, downloads: downloads.tracks).count
                    Text("\(count) titre\(count > 1 ? "s" : "") correspondent actuellement. La playlist se met à jour automatiquement.")
                }
            }
            .navigationTitle("Playlist intelligente")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    Button("Annuler") { dismiss() }
                }
                ToolbarItem(placement: .topBarTrailing) {
                    Button("OK") {
                        library.saveSmartPlaylist(currentPlaylist)
                        dismiss()
                    }
                    .disabled(playlist.name.trimmingCharacters(in: .whitespaces).isEmpty)
                }
            }
            .onAppear { limited = playlist.limit != nil }
        }
    }

    private var currentPlaylist: SmartPlaylist {
        var copy = playlist
        copy.limit = limited ? (playlist.limit ?? 25) : nil
        return copy
    }
}

private struct RuleEditor: View {
    @Binding var rule: SmartRule

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack {
                Picker("Champ", selection: $rule.field) {
                    ForEach(SmartField.allCases) { Text($0.label).tag($0) }
                }
                .labelsHidden()
                Picker("Condition", selection: $rule.op) {
                    ForEach(rule.field.operators) { Text($0.label).tag($0) }
                }
                .labelsHidden()
            }
            switch rule.field.kind {
            case .text:
                TextField("Valeur", text: $rule.text)
                    .textInputAutocapitalization(.never)
            case .number, .date:
                HStack {
                    TextField("0", value: $rule.number, format: .number)
                        .keyboardType(.decimalPad)
                    Text(rule.field.kind == .date ? "jours" : (rule.field == .duration ? "minutes" : "écoutes"))
                        .foregroundStyle(.secondary)
                }
            case .flag:
                EmptyView()
            }
        }
        .onChange(of: rule.field) { _, field in
            if !field.operators.contains(rule.op) { rule.op = field.operators[0] }
            if field.kind == .date && rule.number == 0 { rule.number = 30 }
        }
    }
}
