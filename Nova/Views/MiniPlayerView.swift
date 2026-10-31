import SwiftUI

/// Mini-lecteur affiché au-dessus de la barre d'onglets (accessoire iOS 26+).
struct MiniPlayerView: View {
    @Environment(PlayerModel.self) private var player
    let onOpen: () -> Void

    var body: some View {
        HStack(spacing: 12) {
            ArtworkThumb(track: player.current, size: 34, corner: 7)
            VStack(alignment: .leading, spacing: 1) {
                Text(player.current?.title ?? "Rien en lecture")
                    .font(.subheadline.weight(.semibold))
                    .lineLimit(1)
                if let artist = player.current?.artist {
                    Text(artist)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                }
            }
            Spacer(minLength: 8)
            Group {
                if player.isLoading {
                    ProgressView()
                } else {
                    Button {
                        player.togglePlay()
                    } label: {
                        Image(systemName: player.isPlaying ? "pause.fill" : "play.fill")
                            .font(.title3)
                            .contentTransition(.symbolEffect(.replace))
                    }
                    .disabled(player.current == nil)
                }
            }
            .frame(width: 32)
            Button {
                player.next()
            } label: {
                Image(systemName: "forward.fill")
                    .font(.title3)
            }
            .disabled(player.current == nil)
        }
        .buttonStyle(.plain)
        .padding(.horizontal, 14)
        .contentShape(Rectangle())
        .onTapGesture {
            if player.current != nil { onOpen() }
        }
    }
}
