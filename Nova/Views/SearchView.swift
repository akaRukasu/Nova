import SwiftUI

struct SearchView: View {
    @Environment(PlayerModel.self) private var player
    @State private var query = ""
    @State private var results: [Track] = []
    @State private var isSearching = false
    @State private var errorText: String?
    private let client = InnerTubeClient()

    var body: some View {
        NavigationStack {
            List {
                ForEach(Array(results.enumerated()), id: \.element.id) { position, track in
                    Button {
                        player.play(results, startAt: position)
                    } label: {
                        TrackRow(track: track, isCurrent: player.current?.id == track.id)
                    }
                    .buttonStyle(.plain)
                    .contextMenu { TrackMenu(track: track) }
                }
            }
            .listStyle(.plain)
            .overlay { overlay }
            .navigationTitle("Recherche")
            .searchable(text: $query, prompt: "Titres, artistes, albums")
            .onSubmit(of: .search) { Task { await runSearch() } }
            .task(id: query) {
                try? await Task.sleep(for: .milliseconds(450))
                guard !Task.isCancelled else { return }
                await runSearch()
            }
        }
    }

    @ViewBuilder private var overlay: some View {
        if isSearching && results.isEmpty {
            ProgressView()
        } else if let errorText, results.isEmpty {
            ContentUnavailableView("Recherche impossible", systemImage: "wifi.exclamationmark", description: Text(errorText))
        } else if results.isEmpty && !query.isEmpty && !isSearching {
            ContentUnavailableView.search(text: query)
        } else if results.isEmpty {
            ContentUnavailableView("Que veux-tu écouter ?", systemImage: "magnifyingglass",
                                   description: Text("Cherche un titre, un artiste ou un album."))
        }
    }

    private func runSearch() async {
        let text = query.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else {
            results = []
            errorText = nil
            return
        }
        isSearching = true
        defer { isSearching = false }
        do {
            let found = try await client.search(text)
            guard text == query.trimmingCharacters(in: .whitespacesAndNewlines) else { return }
            results = found
            errorText = nil
        } catch {
            if (error as? URLError)?.code == .cancelled || error is CancellationError { return }
            errorText = error.localizedDescription
        }
    }
}
