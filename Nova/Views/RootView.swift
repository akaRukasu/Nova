import SwiftUI

struct RootView: View {
    @Environment(PlayerModel.self) private var player
    @Environment(Router.self) private var router
    @Environment(\.scenePhase) private var scenePhase

    var body: some View {
        @Bindable var router = router
        TabView(selection: $router.tab) {
            Tab("Accueil", systemImage: "house.fill", value: AppTab.home) {
                NavigationStack(path: $router.homePath) {
                    HomeView().withRoutes()
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
        .onChange(of: scenePhase) { _, phase in
            if phase != .active { player.saveSession(force: true) }
        }
    }
}
