import SwiftUI

struct RootView: View {
    @Environment(PlayerModel.self) private var player
    @Environment(Router.self) private var router
    @Environment(\.scenePhase) private var scenePhase
    /// QR code « Importer depuis l'iPhone » de Nova pour Windows, scanné avec l'appareil photo.
    @State private var transfer: LibraryTransfer.Request?
    @State private var transferMessage: String?
    @State private var transferring = false

    var body: some View {
        @Bindable var router = router
        // Lu ici pour que la page Jam s'ouvre dès qu'un QR code est scanné.
        let showJam = JamSession.shared.isPresented && !router.showPlayer
        TabView(selection: $router.tab) {
            Tab("Accueil", systemImage: "house.fill", value: AppTab.home) {
                NavigationStack(path: $router.homePath) {
                    HomeView().withRoutes()
                }
            }
            Tab("Classements", systemImage: "square.grid.2x2.fill", value: AppTab.explore) {
                NavigationStack(path: $router.explorePath) {
                    BrowseView(title: "Classements Octave", link: BrowseLink(browseID: "octave:charts"),
                               largeTitle: true, showsReleasesCard: true)
                        .withRoutes()
                }
            }
            Tab("Bibliothèque", systemImage: "square.stack.fill", value: AppTab.library) {
                NavigationStack(path: $router.libraryPath) {
                    LibraryView().withRoutes()
                }
            }
            Tab(value: AppTab.search, role: .search) {
                NavigationStack(path: $router.searchPath) {
                    SearchView().withRoutes()
                }
            }
        }
        .tabBarMinimizeBehavior(.onScrollDown)
        .tabViewBottomAccessory {
            MiniPlayerView { router.showPlayer = true }
        }
        .sheet(isPresented: $router.showPlayer) {
            NowPlayingView()
        }
        .sheet(isPresented: Binding(
            get: { player.showsOctaveAccount && !router.showPlayer },
            set: { if !$0 { player.showsOctaveAccount = false } }
        ), onDismiss: { player.octave.hideAccount() }) {
            OctaveAccountSheet()
        }
        .newPlaylistAlert(isActive: !router.showPlayer)
        .alert("Oups", isPresented: Binding(
            get: { player.errorMessage != nil && !router.showPlayer },
            set: { if !$0 { player.errorMessage = nil } }
        )) {
            Button("OK", role: .cancel) {}
        } message: {
            Text(player.errorMessage ?? "")
        }
        // QR code d'un Jam scanné avec l'appareil photo (« nova://jam/CODE »).
        .onOpenURL { url in
            if let request = LibraryTransfer.request(from: url) {
                router.showPlayer = false
                transfer = request
                return
            }
            guard url.host == "jam" else { return }
            router.showPlayer = false
            Task {
                try? await Task.sleep(for: .milliseconds(400))
                JamSession.shared.open(url)
            }
        }
        .sheet(isPresented: Binding(get: { showJam },
                                    set: { JamSession.shared.isPresented = $0 })) {
            JamView()
        }
        .alert("Associer \(transfer?.computer ?? "ton PC") ?", isPresented: Binding(
            get: { transfer != nil && !transferring },
            set: { if !$0 && !transferring { transfer = nil } }
        )) {
            Button("Associer et envoyer") {
                guard let request = transfer else { return }
                transferring = true
                Task {
                    do {
                        let sent = try await PCSync.shared.pair(request, library: player.library)
                        transferMessage = sent + " Les prochains ajouts seront envoyés automatiquement."
                    } catch {
                        transferMessage = error.localizedDescription
                    }
                    transferring = false
                    transfer = nil
                }
            }
            Button("Annuler", role: .cancel) { transfer = nil }
        } message: {
            Text("Playlists, titres likés, historique, albums et artistes suivis partent vers \(transfer?.computer ?? "Nova") (PC ou Android), sur ton Wi-Fi (\(transfer?.url.host ?? "")). Ensuite, tes ajouts y seront envoyés automatiquement.")
        }
        .alert("Transfert vers Nova (PC ou Android)", isPresented: Binding(
            get: { transferMessage != nil },
            set: { if !$0 { transferMessage = nil } }
        )) {
            Button("OK", role: .cancel) {}
        } message: {
            Text(transferMessage ?? "")
        }
        .overlay {
            if transferring {
                ProgressView("Envoi de ta bibliothèque…")
                    .padding(24)
                    .glassEffect(in: RoundedRectangle(cornerRadius: 20))
            }
        }
        // Nova pour Windows associé : les changements de la bibliothèque y partent tout seuls.
        .onChange(of: player.library.revision) { _, _ in PCSync.shared.libraryChanged(player.library) }
        .task {
            player.octave.warmUp()
            PCSync.shared.startHeartbeat(library: player.library)
            RemoteControl.shared.watchComputer(player: player)
        }
        .onChange(of: scenePhase) { _, phase in
            if phase == .active {
                player.octave.attach()
                Task { try? await PCSync.shared.sync(library: player.library, includeHistory: true) }
                RemoteControl.shared.releaseIfIdle(player: player)
            }
            if phase == .inactive { RemoteControl.shared.attachBeforeLeaving(player: player) }
            if phase != .active {
                player.saveSession(force: true)
                player.library.flush()
            }
        }
    }
}
