import SwiftUI

@main
struct NovaApp: App {
    @State private var player = PlayerModel()

    var body: some Scene {
        WindowGroup {
            RootView()
                .environment(player)
                .tint(.novaAccent)
        }
    }
}

extension Color {
    /// Violet Nova.
    static let novaAccent = Color(red: 0.56, green: 0.40, blue: 1.0)
}
