import SwiftUI

enum AppTab: Hashable {
    case home, library, search
}

struct RootView: View {
    @Environment(PlayerModel.self) private var player
    @State private var tab: AppTab = .home
    @State private var showPlayer = false

    var body: some View {
        TabView(selection: $tab) {
            Tab("Accueil", systemImage: "house.fill", value: AppTab.home) {
                HomeView()
            }
            Tab("Bibliothèque", systemImage: "square.stack.fill", value: AppTab.library) {
                LibraryView()
            }
            Tab(value: AppTab.search, role: .search) {
                SearchView()
            }
        }
        .tabBarMinimizeBehavior(.onScrollDown)
        .tabViewBottomAccessory {
            MiniPlayerView { showPlayer = true }
        }
        .sheet(isPresented: $showPlayer) {
            NowPlayingView()
        }
        .alert("Lecture impossible", isPresented: Binding(
            get: { player.errorMessage != nil },
            set: { if !$0 { player.errorMessage = nil } }
        )) {
            Button("OK", role: .cancel) {}
        } message: {
            Text(player.errorMessage ?? "")
        }
    }
}
