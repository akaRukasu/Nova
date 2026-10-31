import SwiftUI

struct HomeView: View {
    @Environment(PlayerModel.self) private var player

    var body: some View {
        NavigationStack {
            ScrollView {
                if player.library.recents.isEmpty {
                    ContentUnavailableView("Bienvenue sur Nova", systemImage: "sparkles",
                                           description: Text("Cherche un titre pour lancer ta première écoute. Tes mix personnalisés apparaîtront ici."))
                        .padding(.top, 80)
                } else {
                    VStack(alignment: .leading, spacing: 28) {
                        resumeCard
                        recentsShelf
                    }
                    .padding(.vertical, 12)
                }
            }
            .navigationTitle("Accueil")
        }
    }

    /// Grande carte 16:9 pour reprendre le dernier titre.
    @ViewBuilder private var resumeCard: some View {
        if let last = player.library.recents.first {
            Button {
                player.startRadio(from: last)
            } label: {
                ZStack(alignment: .bottomLeading) {
                    RemoteImage(urls: last.videoThumbnailURLs)
                        .aspectRatio(16 / 9, contentMode: .fit)
                    LinearGradient(colors: [.clear, .black.opacity(0.75)], startPoint: .center, endPoint: .bottom)
                    VStack(alignment: .leading, spacing: 4) {
                        Text("Reprendre avec la radio")
                            .font(.caption.weight(.semibold))
                            .textCase(.uppercase)
                            .foregroundStyle(.white.opacity(0.8))
                        Text(last.title)
                            .font(.title3.weight(.bold))
                            .foregroundStyle(.white)
                            .lineLimit(1)
                        Text(last.artist)
                            .font(.subheadline)
                            .foregroundStyle(.white.opacity(0.8))
                            .lineLimit(1)
                    }
                    .padding(16)
                }
                .clipShape(RoundedRectangle(cornerRadius: 22, style: .continuous))
            }
            .buttonStyle(.plain)
            .padding(.horizontal, 16)
        }
    }

    private var recentsShelf: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("Écoutés récemment")
                .font(.title2.weight(.bold))
                .padding(.horizontal, 16)
            ScrollView(.horizontal, showsIndicators: false) {
                LazyHStack(alignment: .top, spacing: 14) {
                    ForEach(Array(player.library.recents.prefix(20).enumerated()), id: \.element.id) { position, track in
                        Button {
                            player.play(Array(player.library.recents), startAt: position)
                        } label: {
                            VStack(alignment: .leading, spacing: 6) {
                                RemoteImage(urls: track.videoThumbnailURLs)
                                    .frame(width: 220, height: 124)
                                    .clipShape(RoundedRectangle(cornerRadius: 14, style: .continuous))
                                Text(track.title)
                                    .font(.subheadline.weight(.semibold))
                                    .lineLimit(1)
                                Text(track.artist)
                                    .font(.caption)
                                    .foregroundStyle(.secondary)
                                    .lineLimit(1)
                            }
                            .frame(width: 220, alignment: .leading)
                        }
                        .buttonStyle(.plain)
                        .contextMenu { TrackMenu(track: track) }
                    }
                }
                .padding(.horizontal, 16)
            }
        }
    }
}
