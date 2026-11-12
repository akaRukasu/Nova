import SwiftUI

/// Mini-lecteur affiché au-dessus de la barre d'onglets (accessoire iOS 26+).
struct MiniPlayerView: View {
    @Environment(PlayerModel.self) private var player
    let onOpen: () -> Void

    var body: some View {
        HStack(spacing: 12) {
            Button(action: onOpen) {
                HStack(spacing: 9) {
                    ArtworkThumb(track: player.current, size: 34, corner: 7)
                    trackLabel
                }
            }
            .disabled(player.current == nil)
            .accessibilityHint("Ouvre le lecteur plein écran")
            Spacer(minLength: 6)
            if player.current != nil { PlaybackSourceMenu() }
            Button {
                player.togglePlay()
            } label: {
                if player.isLoading { ProgressView() }
                else { Image(systemName: player.isPlaying ? "pause.fill" : "play.fill").font(.title3) }
            }
            .frame(minWidth: 36, minHeight: 44)
            .disabled(player.current == nil || player.isLoading)
            .accessibilityLabel(player.isPlaying ? "Pause" : "Lecture")
        }
        .buttonStyle(.plain)
        .padding(.horizontal, 14)
        .overlay(alignment: .bottom) {
            if player.duration > 0 {
                ProgressView(value: min(max(0, player.currentTime), player.duration), total: player.duration)
                    .tint(Color.novaAccent)
                    .padding(.horizontal, 14)
                    .allowsHitTesting(false)
            }
        }
    }

    private var trackLabel: some View {
        VStack(alignment: .leading, spacing: 1) {
                Text(player.current?.title ?? "Rien en lecture")
                    .font(.subheadline.weight(.semibold))
                    .lineLimit(1)
                if RemoteControl.shared.isActive {
                    Label("Sur \(RemoteControl.shared.deviceName)", systemImage: "desktopcomputer")
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(Color.novaAccent)
                        .lineLimit(1)
                } else if let artist = player.current?.artist {
                    Text(artist)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                }
        }
    }
}

struct PlaybackSourceMenu: View {
    @Environment(PlayerModel.self) private var player

    var body: some View {
        Menu {
            ForEach(PlaybackSource.allCases) { source in
                Button { player.switchSource(source) } label: {
                    if source == player.source { Label(source.label, systemImage: "checkmark") }
                    else { Text(source.label) }
                }
            }
        } label: {
            Text(player.source.label)
                .font(.caption.weight(.semibold))
                .lineLimit(1)
                .padding(.horizontal, 8)
                .padding(.vertical, 5)
                .background(.thinMaterial, in: Capsule())
                .frame(minHeight: 44)
        }
        .accessibilityLabel("Source de lecture, " + player.source.label)
    }
}
