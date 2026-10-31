import AVKit
import SwiftUI

/// Vignette carrée arrondie.
struct ArtworkThumb: View {
    let track: Track?
    var size: CGFloat = 52
    var corner: CGFloat = 8

    var body: some View {
        RemoteImage(urls: track?.squareArtworkURLs ?? [])
            .frame(width: size, height: size)
            .clipShape(RoundedRectangle(cornerRadius: corner, style: .continuous))
    }
}

/// Ligne de titre pour les listes.
struct TrackRow: View {
    let track: Track
    var isCurrent = false

    var body: some View {
        HStack(spacing: 12) {
            ArtworkThumb(track: track)
            VStack(alignment: .leading, spacing: 2) {
                Text(track.title)
                    .font(.body.weight(.medium))
                    .foregroundStyle(isCurrent ? Color.novaAccent : Color.primary)
                    .lineLimit(1)
                Text(track.subtitle)
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
            }
            Spacer(minLength: 8)
            if let duration = track.duration {
                Text(duration.clockString)
                    .font(.footnote.monospacedDigit())
                    .foregroundStyle(.secondary)
            }
        }
        .contentShape(Rectangle())
    }
}

/// Menu contextuel commun à toutes les listes de titres.
struct TrackMenu: View {
    @Environment(PlayerModel.self) private var player
    let track: Track

    var body: some View {
        Button("Lire ensuite", systemImage: "text.line.first.and.arrowtriangle.forward") {
            player.playNext(track)
        }
        Button("Ajouter à la file", systemImage: "text.line.last.and.arrowtriangle.forward") {
            player.enqueue(track)
        }
        Button("Lancer la radio", systemImage: "dot.radiowaves.left.and.right") {
            player.startRadio(from: track)
        }
        ShareLink(item: URL(string: "https://music.youtube.com/watch?v=\(track.id)")!) {
            Label("Partager", systemImage: "square.and.arrow.up")
        }
    }
}

/// Bouton AirPlay du système.
struct RoutePicker: UIViewRepresentable {
    func makeUIView(context: Context) -> AVRoutePickerView {
        let view = AVRoutePickerView()
        view.prioritizesVideoDevices = false
        view.tintColor = .white
        view.activeTintColor = UIColor(Color.novaAccent)
        return view
    }

    func updateUIView(_ uiView: AVRoutePickerView, context: Context) {}
}
