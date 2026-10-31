import SwiftUI

/// Lecteur plein écran : miniature du clip en 16:9, fond flou, commandes en verre.
struct NowPlayingView: View {
    @Environment(PlayerModel.self) private var player
    @State private var scrubPosition: Double?
    @State private var showQueue = false

    var body: some View {
        ZStack {
            background
            VStack(spacing: 0) {
                Capsule()
                    .fill(.white.opacity(0.35))
                    .frame(width: 40, height: 5)
                    .padding(.top, 10)

                Spacer(minLength: 20)

                RemoteImage(urls: player.current?.videoThumbnailURLs ?? [])
                    .aspectRatio(16 / 9, contentMode: .fit)
                    .clipShape(RoundedRectangle(cornerRadius: 20, style: .continuous))
                    .shadow(color: .black.opacity(0.4), radius: 24, y: 12)
                    .scaleEffect(player.isPlaying ? 1 : 0.92)
                    .animation(.spring(response: 0.45, dampingFraction: 0.75), value: player.isPlaying)

                Spacer(minLength: 28)

                titleBlock
                progress.padding(.top, 22)
                controls.padding(.top, 18)

                Spacer(minLength: 24)

                bottomBar
                    .padding(.bottom, 8)
            }
            .padding(.horizontal, 26)
            .foregroundStyle(.white)
        }
        .sheet(isPresented: $showQueue) {
            QueueView()
                .presentationDetents([.medium, .large])
        }
        .presentationDragIndicator(.hidden)
    }

    private var background: some View {
        ZStack {
            Color.black
            RemoteImage(urls: player.current?.videoThumbnailURLs ?? [])
                .scaleEffect(1.6)
                .blur(radius: 70)
                .opacity(0.85)
            LinearGradient(colors: [.black.opacity(0.15), .black.opacity(0.65)], startPoint: .top, endPoint: .bottom)
        }
        .ignoresSafeArea()
    }

    private var titleBlock: some View {
        HStack(alignment: .center) {
            VStack(alignment: .leading, spacing: 4) {
                Text(player.current?.title ?? "")
                    .font(.title2.weight(.bold))
                    .lineLimit(1)
                Text(player.current?.artist ?? "")
                    .font(.title3)
                    .foregroundStyle(.white.opacity(0.7))
                    .lineLimit(1)
            }
            Spacer()
            if let track = player.current {
                Menu {
                    TrackMenu(track: track)
                } label: {
                    Image(systemName: "ellipsis")
                        .font(.title3.weight(.semibold))
                        .frame(width: 40, height: 40)
                        .glassEffect(in: Circle())
                }
            }
        }
    }

    private var progress: some View {
        VStack(spacing: 6) {
            Slider(
                value: Binding(
                    get: { scrubPosition ?? player.currentTime },
                    set: { scrubPosition = $0 }
                ),
                in: 0...max(player.duration, 1),
                onEditingChanged: { editing in
                    if !editing, let target = scrubPosition {
                        player.seek(to: target)
                        scrubPosition = nil
                    }
                }
            )
            .tint(.white)
            HStack {
                Text((scrubPosition ?? player.currentTime).clockString)
                Spacer()
                Text("-" + max(0, player.duration - (scrubPosition ?? player.currentTime)).clockString)
            }
            .font(.caption.monospacedDigit())
            .foregroundStyle(.white.opacity(0.65))
        }
    }

    private var controls: some View {
        HStack {
            Spacer()
            Button { player.previous() } label: {
                Image(systemName: "backward.fill").font(.system(size: 30))
            }
            Spacer()
            Button { player.togglePlay() } label: {
                ZStack {
                    if player.isLoading {
                        ProgressView().tint(.white).controlSize(.large)
                    } else {
                        Image(systemName: player.isPlaying ? "pause.fill" : "play.fill")
                            .font(.system(size: 44))
                            .contentTransition(.symbolEffect(.replace))
                    }
                }
                .frame(width: 84, height: 84)
                .glassEffect(.regular.interactive(), in: Circle())
            }
            Spacer()
            Button { player.next() } label: {
                Image(systemName: "forward.fill").font(.system(size: 30))
            }
            Spacer()
        }
        .buttonStyle(.plain)
    }

    private var bottomBar: some View {
        HStack(spacing: 18) {
            RoutePicker()
                .frame(width: 30, height: 30)
            Spacer()
            Button { showQueue = true } label: {
                Image(systemName: "list.bullet")
                    .font(.title3.weight(.semibold))
            }
            .buttonStyle(.plain)
        }
        .padding(.horizontal, 22)
        .padding(.vertical, 12)
        .glassEffect(in: Capsule())
    }
}

/// File d'attente : titres à venir, réordonnables.
struct QueueView: View {
    @Environment(PlayerModel.self) private var player
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            List {
                if let current = player.current {
                    Section("En cours") {
                        TrackRow(track: current, isCurrent: true)
                    }
                }
                Section("À suivre") {
                    ForEach(Array(player.upNext.enumerated()), id: \.offset) { offset, track in
                        Button {
                            player.jump(to: player.index + 1 + offset)
                        } label: {
                            TrackRow(track: track)
                        }
                        .buttonStyle(.plain)
                    }
                    .onDelete { player.removeFromQueue(at: $0) }
                    .onMove { player.moveInQueue(from: $0, to: $1) }
                }
            }
            .navigationTitle("File d'attente")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarLeading) { EditButton() }
                ToolbarItem(placement: .topBarTrailing) {
                    Button("OK") { dismiss() }
                }
            }
        }
    }
}
