import SwiftUI

struct WrappedView: View {
    @Environment(LibraryStore.self) private var library
    @Environment(PlayerModel.self) private var player
    @State private var year = String(Calendar.current.component(.year, from: Date()))
    private struct ArtistCount: Identifiable {
        var name: String
        var plays: Int
        var id: String { name }
    }

    var body: some View {
        let current = String(Calendar.current.component(.year, from: Date()))
        let years = Set(library.listeningYears.keys).union([current]).sorted(by: >)
        let tracks = (library.listeningYears[year] ?? [:]).values.sorted { $0.plays > $1.plays }
        let artists = Dictionary(grouping: tracks, by: { $0.track.artist })
            .map { ArtistCount(name: $0.key, plays: $0.value.reduce(0) { $0 + $1.plays }) }
            .sorted { $0.plays > $1.plays }
        List {
            Picker("Année", selection: $year) {
                ForEach(years, id: \.self) { Text($0).tag($0) }
            }
            if tracks.isEmpty {
                ContentUnavailableView("Aucune écoute pour cette année", systemImage: "sparkles",
                                       description: Text("Les écoutes enregistrées depuis la mise à jour apparaîtront ici."))
            } else {
                Section {
                    LabeledContent("Écoutes", value: tracks.reduce(0) { $0 + $1.plays }.formatted())
                    LabeledContent("Titres", value: tracks.count.formatted())
                }
                Section("Titres les plus écoutés") {
                    ForEach(tracks.prefix(10), id: \.track.id) { entry in
                        TrackRowButton(track: entry.track) { player.play([entry.track]) }
                    }
                }
                Section("Artistes les plus écoutés") {
                    ForEach(artists.prefix(10)) { artist in
                        LabeledContent(artist.name, value: artist.plays.formatted())
                    }
                }
            }
        }
        .navigationTitle("Récap annuel")
    }
}
