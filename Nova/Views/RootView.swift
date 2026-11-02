import SwiftUI

struct RootView: View {
    @Environment(PlayerModel.self) private var player
    @Environment(Router.self) private var router
    @Environment(\.scenePhase) private var scenePhase

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
            Tab("Nouveautés", systemImage: "square.grid.2x2.fill", value: AppTab.explore) {
                NavigationStack(path: $router.explorePath) {
                    BrowseView(title: "Nouveautés", link: BrowseLink(browseID: "FEmusic_explore"),
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
        .onChange(of: scenePhase) { _, phase in
            if phase != .active { player.saveSession(force: true) }
        }
    }
}
