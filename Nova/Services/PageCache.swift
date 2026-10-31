import CryptoKit
import Foundation

/// Cache des pages YouTube Music (mémoire + disque) : une page déjà vue s'affiche
/// instantanément, puis se met à jour en arrière-plan.
actor PageCache {
    static let shared = PageCache()

    private struct Entry {
        let date: Date
        let data: Data
    }

    private var memory: [String: Entry] = [:]
    private let directory: URL

    init() {
        let caches = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask)[0]
        directory = caches.appendingPathComponent("Pages", isDirectory: true)
        try? FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    }

    private func fileURL(for key: String) -> URL {
        let hash = SHA256.hash(data: Data(key.utf8)).prefix(12).map { String(format: "%02x", $0) }.joined()
        return directory.appendingPathComponent(hash + ".json")
    }

    /// Valeur en cache et son âge, si elle existe.
    func value<T: Decodable>(_ type: T.Type, for key: String) -> (value: T, age: TimeInterval)? {
        let entry: Entry
        if let hit = memory[key] {
            entry = hit
        } else {
            let url = fileURL(for: key)
            guard let data = try? Data(contentsOf: url),
                  let date = (try? url.resourceValues(forKeys: [.contentModificationDateKey]))?.contentModificationDate
            else { return nil }
            entry = Entry(date: date, data: data)
            memory[key] = entry
        }
        guard let value = try? JSONDecoder().decode(T.self, from: entry.data) else { return nil }
        return (value, Date().timeIntervalSince(entry.date))
    }

    func store<T: Encodable>(_ value: T, for key: String) {
        guard let data = try? JSONEncoder().encode(value) else { return }
        memory[key] = Entry(date: Date(), data: data)
        if memory.count > 80 { memory.removeAll() }
        try? data.write(to: fileURL(for: key), options: .atomic)
    }

    func clear() {
        memory.removeAll()
        let files = (try? FileManager.default.contentsOfDirectory(at: directory, includingPropertiesForKeys: nil)) ?? []
        files.forEach { try? FileManager.default.removeItem(at: $0) }
    }
}

/// Affiche d'abord la version en cache (si elle existe), puis la version fraîche
/// si le cache a plus de `freshFor` secondes.
@MainActor
func loadCached<T: Codable>(_ key: String,
                            freshFor: TimeInterval,
                            fetch: @escaping () async throws -> T,
                            apply: (T) -> Void) async throws {
    let cached = await PageCache.shared.value(T.self, for: key)
    if let cached { apply(cached.value) }
    guard cached == nil || cached!.age > freshFor else { return }
    do {
        let fresh = try await fetch()
        apply(fresh)
        await PageCache.shared.store(fresh, for: key)
    } catch {
        // Le cache suffit si le réseau ne répond pas.
        if cached == nil { throw error }
    }
}
