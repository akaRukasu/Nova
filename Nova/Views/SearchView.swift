import SwiftUI

struct SearchView: View {
    @Environment(PlayerModel.self) private var player
    @Environment(LibraryStore.self) private var library
    @State private var query = ""
    @State private var submitted = ""
    @State private var scope: SearchScope = .all
    @State private var suggestions: [String] = []
    @State private var shelves: [Shelf] = []
    @State private var isSearching = false
    @State private var errorText: String?
    @State private var categories: [Shelf] = []
    @FocusState private var fieldFocused: Bool
    private let client = InnerTubeClient()

    private struct SearchKey: Hashable {
        let text: String
        let scope: SearchScope
    }

    var body: some View {
        ScrollView {
            if submitted.isEmpty {
                history
            } else if scope == .all {
                LazyVStack(alignment: .leading, spacing: 28) {
                    ShelvesContent(shelves: shelves, showsAddButton: true) { track, _ in
                        player.startRadio(from: track)
                    }
                }
                .padding(.vertical, 12)
            } else {
                LazyVStack(spacing: 6) {
                    ForEach(shelves.flatMap(\.items)) { item in
                        ItemRow(item: item, showsAddButton: true) { track in player.startRadio(from: track) }
                    }
                }
                .padding(.horizontal, 16)
                .padding(.vertical, 12)
            }
        }
        .scrollDismissesKeyboard(.immediately)
        .overlay { overlay }
        .navigationTitle("Recherche")
        .searchable(text: $query, prompt: "Titres, artistes, albums, playlists")
        .searchFocused($fieldFocused)
        .searchScopes($scope, activation: .onSearchPresentation) {
            ForEach(SearchScope.allCases, id: \.self) { scope in
                Text(scope.rawValue).tag(scope)
            }
        }
        .searchSuggestions {
            if query != submitted {
                ForEach(suggestions, id: \.self) { suggestion in
                    Button {
                        submit(suggestion)
                    } label: {
                        Label(suggestion, systemImage: "magnifyingglass")
                            .foregroundStyle(Color.primary)
                    }
                }
            }
        }
        .onSubmit(of: .search) { submit(query) }
        .task(id: query) { await loadSuggestions() }
        .task(id: SearchKey(text: submitted, scope: scope)) { await runSearch() }
    }

    @ViewBuilder private var history: some View {
        VStack(alignment: .leading, spacing: 24) {
            recentSearches
            // « Parcourir » : ambiances et genres de YouTube Music.
            ForEach(categories) { shelf in
                CardGrid(shelf: shelf)
            }
        }
        .padding(.bottom, 24)
        .task {
            guard categories.isEmpty else { return }
            let client = self.client
            try? await loadCached("moods", freshFor: 86_400,
                                  fetch: { try await client.browse(BrowseLink(browseID: "FEmusic_moods_and_genres")) }) { page in
                categories = page.shelves.filter(\.isCategories)
            }
        }
    }

    @ViewBuilder private var recentSearches: some View {
        if library.searches.isEmpty {
            EmptyView()
        } else {
            VStack(alignment: .leading, spacing: 0) {
                HStack {
                    Text("Recherches récentes")
                        .font(.title3.weight(.bold))
                    Spacer()
                    Button("Effacer") { library.clearSearches() }
                        .font(.subheadline)
                }
                .padding(.bottom, 8)
                ForEach(library.searches.prefix(6), id: \.self) { search in
                    Button {
                        submit(search)
                    } label: {
                        HStack(spacing: 12) {
                            Image(systemName: "clock.arrow.circlepath")
                                .foregroundStyle(.secondary)
                            Text(search)
                                .foregroundStyle(Color.primary)
                            Spacer()
                            Image(systemName: "arrow.up.left")
                                .font(.footnote)
                                .foregroundStyle(.tertiary)
                        }
                        .padding(.vertical, 11)
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    Divider()
                }
            }
            .padding(16)
        }
    }

    @ViewBuilder private var overlay: some View {
        if submitted.isEmpty {
            if library.searches.isEmpty && categories.isEmpty {
                ContentUnavailableView("Que veux-tu écouter ?", systemImage: "magnifyingglass",
                                       description: Text("Cherche un titre, un artiste, un album ou une playlist."))
            }
        } else if isSearching && shelves.isEmpty {
            ProgressView()
        } else if let errorText, shelves.isEmpty {
            ContentUnavailableView {
                Label("Recherche impossible", systemImage: "wifi.exclamationmark")
            } description: {
                Text(errorText)
            } actions: {
                Button("Réessayer") { Task { await runSearch() } }
            }
        } else if shelves.isEmpty && !isSearching {
            ContentUnavailableView.search(text: submitted)
        }
    }

    private func submit(_ text: String) {
        let value = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !value.isEmpty else { return }
        query = value
        submitted = value
        suggestions = []
        fieldFocused = false
        library.addSearch(value)
    }

    private func loadSuggestions() async {
        let text = query.trimmingCharacters(in: .whitespacesAndNewlines)
        if query.isEmpty {
            submitted = ""
            shelves = []
            errorText = nil
        }
        guard !text.isEmpty, text != submitted else {
            suggestions = []
            return
        }
        try? await Task.sleep(for: .milliseconds(220))
        guard !Task.isCancelled, let found = try? await client.suggestions(text) else { return }
        guard text == query.trimmingCharacters(in: .whitespacesAndNewlines) else { return }
        suggestions = found
    }

    private func runSearch() async {
        let text = submitted
        guard !text.isEmpty else { return }
        isSearching = true
        defer { isSearching = false }
        shelves = []
        do {
            let found = try await client.search(text, scope: scope)
            guard text == submitted, !Task.isCancelled else { return }
            shelves = found
            errorText = nil
        } catch {
            if (error as? URLError)?.code == .cancelled || error is CancellationError { return }
            errorText = error.localizedDescription
        }
    }
}
