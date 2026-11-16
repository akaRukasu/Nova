import SwiftUI

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
