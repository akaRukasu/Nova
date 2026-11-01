import SwiftUI

/// Rangée « Tes mix » (Accueil et Découvrir).
struct MixesRow: View {
    @Environment(LibraryStore.self) private var library
    @State private var entries: [Entry] = []

    struct Entry: Identifiable {
        let kind: MixKind
        let previews: [Track]
        var id: String { kind.id }
    }

    var body: some View {
        Group {
            if !entries.isEmpty {
                row
            }
        }
        // Calcul une seule fois (et quand la bibliothèque change), pas à chaque affichage.
        .task(id: library.songs.count &+ library.recents.count &* 31) {
            entries = MixBuilder.kinds(library: library).map {
                Entry(kind: $0, previews: MixBuilder.preview($0, library: library))
            }
        }
    }

    private var row: some View {
            VStack(alignment: .leading, spacing: 12) {
                Text("Tes mix")
                    .font(.title2.weight(.bold))
                    .padding(.horizontal, 16)
                ScrollView(.horizontal, showsIndicators: false) {
                    LazyHStack(spacing: 14) {
                        ForEach(entries) { entry in
                            NavigationLink(value: Route.mix(entry.kind)) {
                                VStack(alignment: .leading, spacing: 6) {
                                    MixCard(kind: entry.kind, previews: entry.previews)
                                        .frame(width: 170, height: 170)
                                    Text(entry.kind.subtitle)
                                        .font(.caption)
                                        .foregroundStyle(.secondary)
                                        .lineLimit(2)
                                        .frame(width: 170, alignment: .leading)
                                }
                            }
                            .buttonStyle(.plain)
                        }
                    }
                    .scrollTargetLayout()
                    .padding(.horizontal, 16)
                }
                .scrollTargetBehavior(.viewAligned)
            }
    }
}

/// Carte d'un mix : mosaïque de pochettes sous un dégradé, titre en blanc.
struct MixCard: View {
    let kind: MixKind
    let previews: [Track]
    var titleFont: Font = .title3.weight(.heavy)

    var body: some View {
        ZStack(alignment: .bottomLeading) {
            LinearGradient(colors: kind.colors, startPoint: .topLeading, endPoint: .bottomTrailing)
            if !previews.isEmpty {
                GeometryReader { proxy in
                    let side = proxy.size.width / 2
                    LazyVGrid(columns: [GridItem(.fixed(side), spacing: 0), GridItem(.fixed(side), spacing: 0)], spacing: 0) {
                        ForEach(Array(previews.prefix(4).enumerated()), id: \.offset) { _, track in
                            RemoteImage(urls: track.squareArtworkURLs)
                                .frame(width: side, height: side)
                        }
                    }
                }
                .opacity(0.55)
                .blendMode(.overlay)
            }
            LinearGradient(colors: [kind.colors[0].opacity(0.15), kind.colors[1].opacity(0.95)],
                           startPoint: .top, endPoint: .bottom)
            VStack(alignment: .leading, spacing: 2) {
                Text("NOVA")
                    .font(.caption2.weight(.bold))
                    .tracking(2)
                    .foregroundStyle(.white.opacity(0.75))
                Text(kind.title)
                    .font(titleFont)
                    .foregroundStyle(.white)
                    .lineLimit(2)
                    .minimumScaleFactor(0.7)
            }
            .padding(14)
        }
        .clipShape(RoundedRectangle(cornerRadius: 16, style: .continuous))
        .shadow(color: kind.colors[1].opacity(0.3), radius: 8, y: 4)
    }
}

/// Page d'un mix.
struct MixView: View {
    @Environment(LibraryStore.self) private var library
    @Environment(PlayerModel.self) private var player
    let kind: MixKind
    @State private var tracks: [Track] = []
    @State private var previews: [Track] = []
    @State private var isLoading = true
    @State private var saved = false

    var body: some View {
        List {
            Section {
                VStack(spacing: 16) {
                    MixCard(kind: kind, previews: previews, titleFont: .largeTitle.weight(.heavy))
                        .frame(width: 250, height: 250)
                    Text(kind.subtitle)
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                        .multilineTextAlignment(.center)
                    PlayShuffleButtons {
                        player.play(tracks)
                    } shuffle: {
                        player.play(tracks, shuffled: true)
                    }
                    .disabled(tracks.isEmpty)
                }
                .frame(maxWidth: .infinity)
                .listRowSeparator(.hidden)
                .listRowBackground(Color.clear)
            }
            Section {
                ForEach(Array(tracks.enumerated()), id: \.element.id) { position, track in
                    TrackRowButton(track: track) { player.play(tracks, startAt: position) }
                }
            } footer: {
                if !tracks.isEmpty {
                    Text("\(tracks.count) titres · renouvelé chaque jour")
                }
            }
        }
        .listStyle(.plain)
        .overlay {
            if isLoading {
                ProgressView("Préparation du mix…")
            } else if tracks.isEmpty {
                ContentUnavailableView("Mix vide pour l'instant", systemImage: "music.note.list",
                                       description: Text("Écoute et like quelques titres de plus : le mix se remplira tout seul."))
            }
        }
        .navigationTitle(kind.title)
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                Button {
                    library.upsertPlaylist(name: kind.title, tracks: tracks)
                    saved = true
                } label: {
                    Image(systemName: saved ? "checkmark" : "plus")
                }
                .disabled(tracks.isEmpty)
                .accessibilityLabel("Enregistrer comme playlist")
            }
        }
        .task {
            previews = MixBuilder.preview(kind, library: library)
            tracks = await MixBuilder.tracks(for: kind, library: library)
            isLoading = false
        }
    }
}
