import SwiftUI

struct WrappedView: View {
    @Environment(LibraryStore.self) private var library
    @Environment(PlayerModel.self) private var player
    @State private var year = String(Calendar.current.component(.year, from: Date()))

    private struct Rank: Identifiable {
        var name: String
        var track: Track
        var plays: Int
        var id: String { name }
    }

    var body: some View {
        let current = String(Calendar.current.component(.year, from: Date()))
        let years = Set(library.listeningYears.keys).union([current]).sorted(by: >)
        let tracks = (library.listeningYears[year] ?? [:]).values.sorted { $0.plays > $1.plays }
        let artists = ranks(tracks, name: { $0.artist })
        let albums = ranks(tracks, name: { track in track.album.map { $0 + " · " + track.artist } ?? "" })
        let plays = tracks.reduce(0) { $0 + $1.plays }
        let minutes = Int((tracks.reduce(0.0) { $0 + Double($1.plays) * ($1.track.duration ?? 0) } / 60).rounded())
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                VStack(alignment: .leading, spacing: 14) {
                    HStack {
                        Label("Récap annuel", systemImage: "sparkles")
                            .font(.subheadline.weight(.semibold))
                        Spacer()
                        Picker("Année", selection: $year) {
                            ForEach(years, id: \.self) { Text($0).tag($0) }
                        }
                        .tint(.white)
                    }
                    Text("Mon année en musique").font(.largeTitle.bold())
                    if let top = tracks.first?.track {
                        HStack(spacing: 12) {
                            RemoteImage(urls: top.artworkURLs(pixels: 220))
                                .frame(width: 64, height: 64)
                                .clipShape(RoundedRectangle(cornerRadius: 10))
                            VStack(alignment: .leading, spacing: 3) {
                                Text("Ton titre le plus écouté").font(.caption)
                                Text(top.title).font(.headline)
                                Text(top.artist).font(.caption)
                            }
                        }
                        Button { player.play(tracks.prefix(50).map(\.track)) } label: {
                            Label("Écouter mon top", systemImage: "play.fill")
                        }
                        .buttonStyle(.borderedProminent)
                        .tint(Color.novaAccent)
                    }
                }
                .foregroundStyle(.white)
                .padding(20)
                .background {
                    RoundedRectangle(cornerRadius: 24)
                        .fill(LinearGradient(colors: [Color(red: 0.19, green: 0.10, blue: 0.32),
                                                      Color(red: 0.51, green: 0.15, blue: 0.40)],
                                             startPoint: .topLeading, endPoint: .bottomTrailing))
                }
                if tracks.isEmpty {
                    ContentUnavailableView("Aucune écoute pour cette année", systemImage: "sparkles",
                                           description: Text("Les écoutes enregistrées dans Nova apparaîtront ici."))
                } else {
                    LazyVGrid(columns: [GridItem(.flexible()), GridItem(.flexible())], spacing: 10) {
                        metric("Écoutes", value: plays)
                        metric("Titres différents", value: tracks.count)
                        metric("Artistes", value: artists.count)
                        metric("Albums", value: albums.count)
                    }
                    if minutes > 0 {
                        Text("\(minutes.formatted()) min estimées à partir de la durée des titres et du nombre d’écoutes.")
                            .font(.caption).foregroundStyle(.secondary)
                    }
                    ranking("Artistes en tête", entries: artists)
                    ranking("Albums en tête", entries: albums)
                    VStack(alignment: .leading, spacing: 10) {
                        Text("Titres les plus écoutés").font(.title3.bold())
                        ForEach(Array(tracks.prefix(20).enumerated()), id: \.element.track.id) { index, entry in
                            HStack(spacing: 8) {
                                Text("\(index + 1)").font(.caption.monospacedDigit()).foregroundStyle(.secondary)
                                TrackRowButton(track: entry.track) { player.play([entry.track]) }
                                Text(entry.plays.formatted()).font(.subheadline.monospacedDigit()).foregroundStyle(.secondary)
                                    .accessibilityLabel("\(entry.plays) écoutes")
                            }
                            if index + 1 < min(20, tracks.count) { Divider() }
                        }
                    }
                    .padding(14)
                    .background(.thinMaterial, in: RoundedRectangle(cornerRadius: 16))
                }
            }
            .padding(16)
        }
        .navigationTitle("Récap annuel")
        .navigationBarTitleDisplayMode(.inline)
    }

    private func ranks(_ tracks: [LibraryStore.ListeningEntry], name: (Track) -> String) -> [Rank] {
        var totals: [String: Rank] = [:]
        for entry in tracks {
            let title = name(entry.track)
            guard !title.isEmpty else { continue }
            let key = title.lowercased()
            totals[key] = Rank(name: title, track: totals[key]?.track ?? entry.track,
                               plays: (totals[key]?.plays ?? 0) + entry.plays)
        }
        return totals.values.sorted { $0.plays == $1.plays ? $0.name < $1.name : $0.plays > $1.plays }
    }

    private func metric(_ label: String, value: Int) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(value.formatted()).font(.title2.bold().monospacedDigit())
            Text(label).font(.caption).foregroundStyle(.secondary)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(14)
        .background(.thinMaterial, in: RoundedRectangle(cornerRadius: 14))
    }

    @ViewBuilder private func ranking(_ title: String, entries: [Rank]) -> some View {
        if let best = entries.first {
            VStack(alignment: .leading, spacing: 12) {
                Text(title).font(.title3.bold())
                ForEach(Array(entries.prefix(8).enumerated()), id: \.element.id) { index, entry in
                    HStack(spacing: 10) {
                        Text("\(index + 1)").font(.caption.monospacedDigit()).foregroundStyle(.secondary)
                        RemoteImage(urls: entry.track.artworkURLs(pixels: 120))
                            .frame(width: 38, height: 38).clipShape(RoundedRectangle(cornerRadius: 7))
                        VStack(alignment: .leading, spacing: 5) {
                            Text(entry.name).font(.subheadline.weight(.semibold)).lineLimit(1)
                            ProgressView(value: Double(entry.plays), total: Double(best.plays)).tint(Color.novaAccent)
                        }
                        Text(entry.plays.formatted()).font(.subheadline.monospacedDigit())
                    }
                }
            }
            .padding(14)
            .background(.thinMaterial, in: RoundedRectangle(cornerRadius: 16))
        }
    }
}
