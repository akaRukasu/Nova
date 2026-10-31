import Foundation
import Observation

/// Historique local (étape 1). La vraie bibliothèque arrive à l'étape 2.
@MainActor
@Observable
final class LibraryStore {
    private(set) var recents: [Track] = []

    private let fileURL: URL = {
        let support = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
        return support.appendingPathComponent("Nova", isDirectory: true).appendingPathComponent("recents.json")
    }()

    init() {
        if let data = try? Data(contentsOf: fileURL),
           let saved = try? JSONDecoder().decode([Track].self, from: data) {
            recents = saved
        }
    }

    func addRecent(_ track: Track) {
        recents.removeAll { $0.id == track.id }
        recents.insert(track, at: 0)
        if recents.count > 100 { recents.removeLast(recents.count - 100) }
        save()
    }

    func clearRecents() {
        recents = []
        save()
    }

    private func save() {
        do {
            try FileManager.default.createDirectory(at: fileURL.deletingLastPathComponent(), withIntermediateDirectories: true)
            try JSONEncoder().encode(recents).write(to: fileURL, options: .atomic)
        } catch {
            // Pas bloquant : l'historique sera réécrit au prochain titre.
        }
    }
}
