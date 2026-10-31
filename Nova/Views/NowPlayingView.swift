import SwiftUI

/// Lecteur plein écran : miniature du clip en 16:9, fond flou, commandes en verre.
struct NowPlayingView: View {
    @Environment(PlayerModel.self) private var player
    @Environment(LibraryStore.self) private var library
    @Environment(Router.self) private var router
    @State private var scrubPosition: Double?
    @State private var showQueue = false
    @State private var showLyrics = false

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
                modes.padding(.top, 14)

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
        .sheet(isPresented: $showLyrics) {
            LyricsView()
                .presentationDetents([.medium, .large])
        }
        .newPlaylistAlert(isActive: true)
        .alert("Oups", isPresented: Binding(
            get: { player.errorMessage != nil },
            set: { if !$0 { player.errorMessage = nil } }
        )) {
            Button("OK", role: .cancel) {}
        } message: {
            Text(player.errorMessage ?? "")
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
        HStack(alignment: .center, spacing: 12) {
            VStack(alignment: .leading, spacing: 4) {
                Text(player.current?.title ?? "")
                    .font(.title2.weight(.bold))
                    .lineLimit(1)
                Button {
                    if let artist = player.current?.artistCollection { router.open(.collection(artist)) }
                } label: {
                    Text(player.current?.artist ?? "")
                        .font(.title3)
                        .foregroundStyle(.white.opacity(0.7))
                        .lineLimit(1)
                }
                .buttonStyle(.plain)
                .disabled(player.current?.artistID == nil)
            }
            Spacer()
            if let track = player.current {
                let liked = library.isLiked(track.id)
                Button {
                    player.toggleLike(track)
                } label: {
                    Image(systemName: liked ? "heart.fill" : "heart")
                        .font(.title3.weight(.semibold))
                        .foregroundStyle(liked ? Color.pink : Color.white)
                        .contentTransition(.symbolEffect(.replace))
                        .frame(width: 40, height: 40)
                        .glassEffect(in: Circle())
                }
                .buttonStyle(.plain)
                .sensoryFeedback(.impact, trigger: liked)
                Menu {
                    TrackMenu(track: track)
                    sleepTimerMenu
                } label: {
                    Image(systemName: "ellipsis")
                        .font(.title3.weight(.semibold))
                        .frame(width: 40, height: 40)
                        .glassEffect(in: Circle())
                }
            }
        }
    }

    private var sleepTimerMenu: some View {
        Menu {
            if player.sleepTimerEnd != nil {
                Button("Désactiver", systemImage: "moon.zzz") { player.setSleepTimer(minutes: nil) }
            }
            ForEach([5, 15, 30, 45, 60, 90], id: \.self) { minutes in
                Button("\(minutes) min") { player.setSleepTimer(minutes: minutes) }
            }
        } label: {
            if let end = player.sleepTimerEnd {
                Label("Minuteur : fin à \(end.formatted(date: .omitted, time: .shortened))", systemImage: "moon.fill")
            } else {
                Label("Minuteur de veille", systemImage: "moon")
            }
        }
    }

    /// Aléatoire et répétition.
    private var modes: some View {
        HStack {
            Button { player.toggleShuffle() } label: {
                Image(systemName: "shuffle")
                    .font(.body.weight(.semibold))
                    .foregroundStyle(player.isShuffled ? Color.novaAccent : Color.white.opacity(0.7))
                    .frame(width: 44, height: 36)
            }
            .accessibilityLabel(player.isShuffled ? "Désactiver l'aléatoire" : "Lecture aléatoire")
            Spacer()
            if player.sleepTimerEnd != nil {
                Label("Minuteur actif", systemImage: "moon.fill")
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(.white.opacity(0.7))
            }
            Spacer()
            Button { player.cycleRepeat() } label: {
                Image(systemName: player.repeatMode == .one ? "repeat.1" : "repeat")
                    .font(.body.weight(.semibold))
                    .foregroundStyle(player.repeatMode == .off ? Color.white.opacity(0.7) : Color.novaAccent)
                    .frame(width: 44, height: 36)
            }
            .accessibilityLabel("Répétition")
        }
        .buttonStyle(.plain)
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
            Button { showLyrics = true } label: {
                Image(systemName: "quote.bubble")
                    .font(.title3.weight(.semibold))
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Paroles")
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
                Section {
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
                } header: {
                    HStack {
                        Text(player.isShuffled ? "À suivre (aléatoire)" : "À suivre")
                        Spacer()
                        if player.hasNext {
                            Button("Effacer") { player.clearUpNext() }
                                .font(.footnote.weight(.semibold))
                                .textCase(nil)
                        }
                    }
                } footer: {
                    if player.repeatMode == .off {
                        Text("À la fin de la file, Nova continue avec la radio du dernier titre.")
                    }
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

/// Paroles du titre en cours.
struct LyricsView: View {
    @Environment(PlayerModel.self) private var player
    @Environment(\.dismiss) private var dismiss
    @State private var lyrics: Lyrics?
    @State private var isLoading = true
    private let client = InnerTubeClient()

    var body: some View {
        NavigationStack {
            ScrollView {
                if let lyrics {
                    VStack(alignment: .leading, spacing: 16) {
                        Text(lyrics.text)
                            .font(.title3.weight(.semibold))
                            .lineSpacing(6)
                            .textSelection(.enabled)
                        if let source = lyrics.source {
                            Text(source)
                                .font(.caption)
                                .foregroundStyle(.secondary)
                        }
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(20)
                }
            }
            .overlay {
                if isLoading {
                    ProgressView()
                } else if lyrics == nil {
                    ContentUnavailableView("Pas de paroles", systemImage: "quote.bubble",
                                           description: Text("YouTube Music n'a pas de paroles pour ce titre."))
                }
            }
            .navigationTitle(player.current?.title ?? "Paroles")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button("OK") { dismiss() }
                }
            }
            .task(id: player.current?.id) {
                guard let id = player.current?.id else { isLoading = false; return }
                isLoading = true
                lyrics = nil
                lyrics = try? await client.lyrics(for: id)
                isLoading = false
            }
        }
    }
}
