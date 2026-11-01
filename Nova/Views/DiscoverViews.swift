import SwiftUI

// MARK: - Découvrir

/// Propositions à partir de ce que tu écoutes : titres et artistes similaires, playlists recommandées.
struct DiscoverView: View {
    @Environment(LibraryStore.self) private var library
    @Environment(PlayerModel.self) private var player
    @State private var sections: [DiscoverSection] = []
    @State private var isLoading = false
    private let client = InnerTubeClient()

    struct DiscoverSection: Identifiable {
        let id: String
        let seed: Track
        let shelves: [Shelf]
    }

    /// Titres de départ : les plus écoutés récemment, puis les titres likés.
    private var seeds: [Track] {
        let stats = library.stats
        let recent = library.recents.prefix(40).sorted {
            (stats[$0.id]?.playCount ?? 0) > (stats[$1.id]?.playCount ?? 0)
        }
        var seenArtists = Set<String>()
        var picks: [Track] = []
        for track in Array(recent) + library.liked.prefix(20) where seenArtists.insert(track.artist).inserted {
            picks.append(track)
            if picks.count == 4 { break }
        }
        return picks
    }

    var body: some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 30) {
                MixesRow()
                shortcuts
                ForEach(sections) { section in
                    VStack(alignment: .leading, spacing: 20) {
                        Text("Parce que tu as écouté « \(section.seed.title) »")
                            .font(.footnote.weight(.semibold))
                            .foregroundStyle(.secondary)
                            .textCase(.uppercase)
                            .padding(.horizontal, 16)
                        ForEach(section.shelves) { shelf in
                            ShelfView(shelf: shelf)
                        }
                    }
                }
                if seeds.isEmpty {
                    ContentUnavailableView("Écoute quelques titres", systemImage: "sparkles",
                                           description: Text("Découvrir te propose des titres, des artistes et des playlists à partir de ce que tu écoutes."))
                }
                if isLoading && sections.isEmpty {
                    ProgressView().frame(maxWidth: .infinity).padding(.top, 40)
                }
            }
            .padding(.vertical, 12)
        }
        .navigationTitle("Découvrir")
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) { AccountButton() }
        }
        .task(id: seeds.map(\.id)) { await load() }
        .refreshable { await load() }
    }

    private var shortcuts: some View {
        HStack(spacing: 12) {
            NavigationLink(value: Route.releases) {
                shortcut("Sorties", "Les nouveautés de tes genres et artistes", "sparkles.rectangle.stack.fill")
            }
            NavigationLink(value: Route.concerts(artist: nil)) {
                shortcut("Concerts", "Tes artistes en live, près de chez toi", "ticket.fill")
            }
        }
        .buttonStyle(.plain)
        .padding(.horizontal, 16)
    }

    private func shortcut(_ title: String, _ detail: String, _ icon: String) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            Image(systemName: icon)
                .font(.title2)
                .foregroundStyle(.white)
            Spacer(minLength: 0)
            Text(title)
                .font(.headline)
                .foregroundStyle(.white)
            Text(detail)
                .font(.caption)
                .foregroundStyle(.white.opacity(0.85))
                .lineLimit(2)
        }
        .padding(14)
        .frame(maxWidth: .infinity, minHeight: 130, alignment: .leading)
        .background(Color.novaAccent.gradient, in: RoundedRectangle(cornerRadius: 18, style: .continuous))
    }

    /// Mix personnalisé : la radio du titre que tu écoutes le plus.
    private func mixCard(seed: Track) -> some View {
        Button {
            player.startRadio(from: seed)
        } label: {
            HStack(spacing: 14) {
                RemoteImage(urls: seed.squareArtworkURLs)
                    .frame(width: 84, height: 84)
                    .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
                VStack(alignment: .leading, spacing: 4) {
                    Text("Ton mix découverte")
                        .font(.headline)
                    Text("Inspiré de \(seed.artist)")
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                }
                Spacer()
                Image(systemName: "play.circle.fill")
                    .font(.system(size: 40))
                    .foregroundStyle(Color.novaAccent)
            }
            .padding(14)
            .background(.quaternary.opacity(0.5), in: RoundedRectangle(cornerRadius: 18, style: .continuous))
        }
        .buttonStyle(.plain)
        .padding(.horizontal, 16)
    }

    private func load() async {
        let seeds = self.seeds
        guard !seeds.isEmpty else { return }
        isLoading = true
        defer { isLoading = false }
        var loaded: [DiscoverSection] = []
        for seed in seeds {
            let client = self.client
            var shelves: [Shelf] = []
            try? await loadCached("related-\(seed.id)", freshFor: 86_400,
                                  fetch: { try await client.related(for: seed.id) }) { shelves = $0 }
            // On garde les propositions (pas les autres versions du même titre).
            let useful = shelves.filter { shelf in
                !shelf.items.isEmpty && !shelf.title.localizedCaseInsensitiveContains("performance")
                    && shelf.title != seed.artist
            }
            if !useful.isEmpty {
                loaded.append(DiscoverSection(id: seed.id, seed: seed, shelves: Array(useful.prefix(3))))
                sections = loaded
            }
        }
    }
}

// MARK: - Sorties

/// Toutes les sorties récentes des genres choisis et des artistes suivis ou écoutés.
struct ReleasesView: View {
    @Environment(LibraryStore.self) private var library
    @Environment(Router.self) private var router
    @AppStorage("releaseGenres") private var genresData = Data()
    @AppStorage("releaseWindowDays") private var windowDays = 30
    @AppStorage("releasesLastSeen") private var lastSeen = Date.distantPast.timeIntervalSince1970
    @State private var releases: [Release] = []
    @State private var isLoading = false
    @State private var errorText: String?
    @State private var showGenres = false
    @State private var filter: Filter = .all
    @State private var opening: Int?
    @State private var previousSeen = Date.distantPast

    enum Filter: String, CaseIterable, Identifiable {
        case all = "Tout"
        case albums = "Albums"
        case singles = "Singles et EP"
        var id: String { rawValue }
    }

    private var genres: [ReleaseGenre] {
        (try? JSONDecoder().decode([ReleaseGenre].self, from: genresData)) ?? []
    }

    /// Artistes suivis et les plus écoutés.
    private var artistNames: [String] {
        let followed = library.saved.filter { $0.kind == .artist }.map(\.title)
        var plays: [String: Int] = [:]
        for track in library.songs + library.recents {
            let main = track.artist.components(separatedBy: CharacterSet(charactersIn: ",&")).first?
                .replacingOccurrences(of: " et ", with: ",").components(separatedBy: ",").first?
                .trimmingCharacters(in: .whitespaces) ?? track.artist
            guard !main.isEmpty else { continue }
            plays[main, default: 0] += max(1, library.stats[track.id]?.playCount ?? 0)
        }
        let top = plays.sorted { $0.value > $1.value }.prefix(25).map(\.key)
        var seen = Set<String>()
        return (followed + top).filter { seen.insert($0.lowercased()).inserted }
    }

    private var visible: [Release] {
        releases.filter { release in
            switch filter {
            case .all: return true
            case .albums: return release.typeLabel == "Album" || release.typeLabel == "Compilation"
            case .singles: return release.typeLabel == "Single" || release.typeLabel == "EP"
            }
        }
    }

    var body: some View {
        List {
            Section {
                Picker("Type", selection: $filter) {
                    ForEach(Filter.allCases) { Text($0.rawValue).tag($0) }
                }
                .pickerStyle(.segmented)
                .listRowSeparator(.hidden)
                Button {
                    showGenres = true
                } label: {
                    Label(genres.isEmpty ? "Choisir mes genres" : genres.map(\.name).joined(separator: ", "),
                          systemImage: "slider.horizontal.3")
                        .lineLimit(2)
                }
            } footer: {
                Text("Sorties des \(windowDays) derniers jours : artistes phares de tes genres, artistes que tu suis et ceux que tu écoutes le plus.")
            }

            ForEach(groupedByDay, id: \.0) { day, items in
                Section(day) {
                    ForEach(items) { release in
                        Button { open(release) } label: { row(release) }
                            .buttonStyle(.plain)
                    }
                }
            }
        }
        .listStyle(.insetGrouped)
        .overlay {
            if isLoading && releases.isEmpty {
                ProgressView("Recherche des sorties…")
            } else if let errorText, releases.isEmpty {
                ContentUnavailableView("Sorties indisponibles", systemImage: "wifi.exclamationmark", description: Text(errorText))
            } else if !isLoading && releases.isEmpty {
                ContentUnavailableView("Aucune sortie", systemImage: "sparkles",
                                       description: Text("Choisis des genres ou suis des artistes pour voir leurs nouveautés ici."))
            }
        }
        .navigationTitle("Sorties")
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                Menu {
                    Picker("Période", selection: $windowDays) {
                        Text("7 jours").tag(7)
                        Text("30 jours").tag(30)
                        Text("90 jours").tag(90)
                    }
                } label: {
                    Image(systemName: "calendar")
                }
            }
        }
        .sheet(isPresented: $showGenres) {
            GenrePicker(selection: Binding(
                get: { genres },
                set: { genresData = (try? JSONEncoder().encode($0)) ?? Data() }
            ))
        }
        .task(id: "\(genresData.hashValue)-\(windowDays)") { await load() }
        .refreshable { await load(force: true) }
        .onAppear { previousSeen = Date(timeIntervalSince1970: lastSeen) }
        .onDisappear { lastSeen = Date().timeIntervalSince1970 }
    }

    private var groupedByDay: [(String, [Release])] {
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "fr_FR")
        formatter.dateFormat = "EEEE d MMMM"
        var order: [String] = []
        var groups: [String: [Release]] = [:]
        for release in visible {
            let key = release.releaseDate.map { formatter.string(from: $0).capitalized } ?? "Date inconnue"
            if groups[key] == nil { order.append(key) }
            groups[key, default: []].append(release)
        }
        return order.map { ($0, groups[$0] ?? []) }
    }

    private func row(_ release: Release) -> some View {
        HStack(spacing: 12) {
            RemoteImage(urls: release.coverURL.map { [$0] } ?? [])
                .frame(width: 60, height: 60)
                .clipShape(RoundedRectangle(cornerRadius: 8, style: .continuous))
            VStack(alignment: .leading, spacing: 2) {
                HStack(spacing: 6) {
                    if let date = release.releaseDate, date > previousSeen {
                        Circle().fill(Color.novaAccent).frame(width: 8, height: 8)
                    }
                    Text(release.title)
                        .font(.body.weight(.medium))
                        .lineLimit(1)
                }
                Text(release.artist)
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
                Text([release.typeLabel, release.genre].compactMap { $0 }.joined(separator: " · "))
                    .font(.caption)
                    .foregroundStyle(.tertiary)
            }
            Spacer()
            if opening == release.id {
                ProgressView()
            }
        }
        .contentShape(Rectangle())
    }

    /// Retrouve la sortie sur YouTube Music et l'ouvre.
    private func open(_ release: Release) {
        opening = release.id
        Task {
            defer { opening = nil }
            let client = InnerTubeClient()
            let shelves = (try? await client.search("\(release.title) \(release.artist)", scope: .albums)) ?? []
            let wanted = TrackMatcher.normalize(release.title)
            let albums = shelves.flatMap(\.items).compactMap(\.collection)
            if let album = albums.first(where: { TrackMatcher.normalize($0.title).contains(wanted) || wanted.contains(TrackMatcher.normalize($0.title)) }) ?? albums.first {
                router.open(.collection(album))
            }
        }
    }

    private func load(force: Bool = false) async {
        isLoading = true
        defer { isLoading = false }
        let since = Date().addingTimeInterval(-Double(windowDays) * 86_400)
        let genres = self.genres
        let names = artistNames
        let key = "releases-\(genres.map(\.id))-\(names.joined(separator: ",").hashValue)-\(windowDays)"
        do {
            try await loadCached(key, freshFor: force ? 0 : 6 * 3600, fetch: {
                var all: [Release] = []
                for genre in genres {
                    all += (try? await ReleasesService.releases(genre: genre, since: since)) ?? []
                }
                all += (try? await ReleasesService.releases(artistNames: names, since: since)) ?? []
                var seen = Set<Int>()
                return all.filter { seen.insert($0.id).inserted }
                    .sorted { ($0.releaseDate ?? .distantPast) > ($1.releaseDate ?? .distantPast) }
            }) { releases = $0 }
            errorText = nil
        } catch {
            errorText = error.localizedDescription
        }
    }
}

/// Choix des genres suivis pour les sorties.
struct GenrePicker: View {
    @Environment(\.dismiss) private var dismiss
    @Binding var selection: [ReleaseGenre]
    @State private var genres: [ReleaseGenre] = []
    @State private var chosen: Set<Int> = []

    var body: some View {
        NavigationStack {
            List(genres) { genre in
                Button {
                    if chosen.contains(genre.id) { chosen.remove(genre.id) } else { chosen.insert(genre.id) }
                } label: {
                    HStack {
                        Text(genre.name).foregroundStyle(Color.primary)
                        Spacer()
                        if chosen.contains(genre.id) {
                            Image(systemName: "checkmark").foregroundStyle(Color.novaAccent)
                        }
                    }
                }
            }
            .overlay { if genres.isEmpty { ProgressView() } }
            .navigationTitle("Mes genres")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button("OK") {
                        selection = genres.filter { chosen.contains($0.id) }
                        dismiss()
                    }
                }
            }
            .task {
                chosen = Set(selection.map(\.id))
                genres = (try? await ReleasesService.genres()) ?? []
            }
        }
    }
}
