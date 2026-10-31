import SwiftUI

struct LibraryView: View {
    @Environment(PlayerModel.self) private var player
    @State private var cacheSize: Int64 = 0
    @State private var confirmClear = false

    var body: some View {
        NavigationStack {
            List {
                if !player.library.recents.isEmpty {
                    Section("Historique") {
                        ForEach(Array(player.library.recents.enumerated()), id: \.element.id) { position, track in
                            Button {
                                player.play(Array(player.library.recents), startAt: position)
                            } label: {
                                TrackRow(track: track, isCurrent: player.current?.id == track.id)
                            }
                            .buttonStyle(.plain)
                            .contextMenu { TrackMenu(track: track) }
                        }
                    }
                }
                Section {
                    LabeledContent("Titres en cache", value: ByteCountFormatter.string(fromByteCount: cacheSize, countStyle: .file))
                    Button("Vider le cache", role: .destructive) { confirmClear = true }
                } header: {
                    Text("Stockage")
                } footer: {
                    Text("Les titres écoutés restent sur l'iPhone (1,5 Go maximum) pour se relancer instantanément.")
                }
            }
            .navigationTitle("Bibliothèque")
            .task { cacheSize = await AudioCache.shared.sizeInBytes() }
            .confirmationDialog("Vider le cache audio ?", isPresented: $confirmClear, titleVisibility: .visible) {
                Button("Vider", role: .destructive) {
                    Task {
                        await AudioCache.shared.clear()
                        cacheSize = await AudioCache.shared.sizeInBytes()
                    }
                }
            }
        }
    }
}
