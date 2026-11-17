import SwiftUI

struct AlbumPlaybackActions: View {
    let play: () -> Void
    let shuffle: () -> Void
    var isSaved = false
    var onSave: (() -> Void)? = nil

    var body: some View {
        HStack(spacing: 12) {
            Button(action: play) {
                HStack(spacing: 8) {
                    Image(systemName: "play.fill").font(.system(size: 16, weight: .semibold))
                    Text("Lecture").font(.headline)
                }
                .foregroundStyle(.white)
                .padding(.horizontal, 12).padding(.vertical, 15)
                .frame(maxWidth: .infinity, minHeight: 54)
            }
            .buttonStyle(AlbumPlayStyle())
            .accessibilityIdentifier("album.play")
            roundButton("shuffle", label: "Lecture aléatoire", action: shuffle)
            if let onSave {
                roundButton(isSaved ? "checkmark" : "plus",
                            label: isSaved ? "Retirer de la bibliothèque" : "Ajouter à la bibliothèque", action: onSave)
            }
        }
    }

    private func roundButton(_ symbol: String, label: String, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Image(systemName: symbol).font(.system(size: 19, weight: .semibold))
                .foregroundStyle(.primary)
                .frame(width: 54, height: 54)
                .background(.ultraThinMaterial, in: Circle())
                .overlay { Circle().strokeBorder(.primary.opacity(0.1)) }
                .contentShape(Circle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel(label)
    }
}

private struct AlbumPlayStyle: ButtonStyle {
    @Environment(\.isEnabled) private var isEnabled
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .background(LinearGradient(colors: [Color.novaAccent, Color.novaAccent.opacity(0.82)],
                                       startPoint: .topLeading, endPoint: .bottomTrailing), in: Capsule())
            .shadow(color: Color.novaAccent.opacity(isEnabled ? 0.2 : 0), radius: 12, y: 5)
            .opacity(isEnabled ? (configuration.isPressed ? 0.85 : 1) : 0.4)
            .scaleEffect(configuration.isPressed && !reduceMotion ? 0.97 : 1)
            .animation(reduceMotion ? nil : .easeOut(duration: 0.16), value: configuration.isPressed)
    }
}

struct AlbumHeader<Actions: View>: View {
    let title: String
    let artist: String
    let artwork: [URL]
    let details: String
    var onArtist: (() -> Void)? = nil
    @ViewBuilder let actions: () -> Actions

    var body: some View {
        VStack(spacing: 18) {
            RemoteImage(urls: artwork, maxPixels: 1000)
                .frame(width: 238, height: 238)
                .clipShape(RoundedRectangle(cornerRadius: 18, style: .continuous))
                .overlay { RoundedRectangle(cornerRadius: 18).strokeBorder(.white.opacity(0.16)) }
                .shadow(color: .black.opacity(0.25), radius: 22, y: 12)
                .padding(.bottom, 8)
            VStack(spacing: 8) {
                Text(title).font(.title.weight(.bold)).tracking(-0.6)
                    .multilineTextAlignment(.center).fixedSize(horizontal: false, vertical: true)
                    .accessibilityAddTraits(.isHeader)
                if !artist.isEmpty {
                    if let onArtist {
                        Button(artist, action: onArtist).font(.headline).tint(Color.novaAccent)
                    } else { Text(artist).font(.headline).foregroundStyle(Color.novaAccent) }
                }
                if !details.isEmpty {
                    Text(details).font(.caption).foregroundStyle(.secondary)
                        .multilineTextAlignment(.center).lineSpacing(3)
                }
            }
            actions().controlSize(.large)
        }
        .frame(maxWidth: .infinity)
        .padding(.horizontal, 22).padding(.vertical, 28)
        .background {
            GeometryReader { geometry in
                RemoteImage(urls: artwork, maxPixels: 480)
                    .frame(width: geometry.size.width, height: geometry.size.height)
                    .blur(radius: 42).opacity(0.3)
                    .overlay { Rectangle().fill(.ultraThinMaterial).opacity(0.72) }
            }
        }
        .clipShape(RoundedRectangle(cornerRadius: 28, style: .continuous))
        .overlay { RoundedRectangle(cornerRadius: 28).strokeBorder(.primary.opacity(0.06)) }
    }
}

#Preview("Commandes d’album") {
    VStack(spacing: 28) {
        AlbumPlaybackActions(play: {}, shuffle: {}, onSave: {})
        AlbumPlaybackActions(play: {}, shuffle: {})
    }
    .padding(24)
    .preferredColorScheme(.dark)
}
