import Foundation

/// Cache disque des titres déjà écoutés (fichiers m4a), limité en taille.
actor AudioCache {
    static let shared = AudioCache()

    private let directory: URL
    private let maxBytes: Int64 = 1_500_000_000 // 1,5 Go
    private var inFlight: Set<String> = []

    init() {
        let caches = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask)[0]
        directory = caches.appendingPathComponent("Audio", isDirectory: true)
        try? FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    }

    private func fileURL(for id: String) -> URL {
        directory.appendingPathComponent("\(id).m4a")
    }

    /// Fichier local s'il existe ; touche sa date pour le garder en tête du cache.
    func localURL(for id: String) -> URL? {
        let url = fileURL(for: id)
        guard FileManager.default.fileExists(atPath: url.path) else { return nil }
        try? FileManager.default.setAttributes([.modificationDate: Date()], ofItemAtPath: url.path)
        return url
    }

    func contains(_ id: String) -> Bool {
        FileManager.default.fileExists(atPath: fileURL(for: id).path)
    }

    /// Télécharge le fichier distant et le range dans le cache.
    func store(remote: URL, id: String) async {
        guard !contains(id), !inFlight.contains(id) else { return }
        inFlight.insert(id)
        defer { inFlight.remove(id) }
        do {
            let (temp, response) = try await URLSession.shared.download(from: remote)
            guard (response as? HTTPURLResponse)?.statusCode == 200 else {
                try? FileManager.default.removeItem(at: temp)
                return
            }
            let destination = fileURL(for: id)
            try? FileManager.default.removeItem(at: destination)
            try FileManager.default.moveItem(at: temp, to: destination)
            prune()
        } catch {
            // Le cache est un bonus : un échec ne bloque jamais la lecture.
        }
    }

    /// Supprime les fichiers les plus anciens au-delà de la taille maximale.
    private func prune() {
        let keys: [URLResourceKey] = [.contentModificationDateKey, .fileSizeKey]
        guard let files = try? FileManager.default.contentsOfDirectory(at: directory, includingPropertiesForKeys: keys) else { return }
        let entries = files.compactMap { url -> (URL, Date, Int64)? in
            guard let values = try? url.resourceValues(forKeys: Set(keys)) else { return nil }
            return (url, values.contentModificationDate ?? .distantPast, Int64(values.fileSize ?? 0))
        }.sorted { $0.1 > $1.1 }

        var total: Int64 = 0
        for (url, _, size) in entries {
            total += size
            if total > maxBytes { try? FileManager.default.removeItem(at: url) }
        }
    }

    func sizeInBytes() -> Int64 {
        let files = (try? FileManager.default.contentsOfDirectory(at: directory, includingPropertiesForKeys: [.fileSizeKey])) ?? []
        return files.reduce(0) { $0 + Int64((try? $1.resourceValues(forKeys: [.fileSizeKey]).fileSize) ?? 0) }
    }

    func clear() {
        let files = (try? FileManager.default.contentsOfDirectory(at: directory, includingPropertiesForKeys: nil)) ?? []
        files.forEach { try? FileManager.default.removeItem(at: $0) }
    }
}
