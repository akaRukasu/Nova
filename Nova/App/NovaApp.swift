import SwiftUI

@main
struct NovaApp: App {
    @State private var player = PlayerModel()
    @State private var router = Router()
    @State private var importer = ImportManager()

    var body: some Scene {
        WindowGroup {
            RootView()
                .environment(player)
                .environment(player.library)
                .environment(player.downloads)
                .environment(player.account)
                .environment(router)
                .environment(importer)
                .tint(.novaAccent)
        }
    }
}

extension Color {
    /// Violet Nova.
    static let novaAccent = Color(red: 0.56, green: 0.40, blue: 1.0)
}
