import Foundation
import Observation

/// Titres téléchargés pour l'écoute hors ligne. Contrairement au cache, ils ne sont jamais effacés automatiquement.
@MainActor
@Observable
final class DownloadStore {
    enum State { case none, queued, downloading, downloaded }

    /// Titres disponibles hors ligne, du plus récent au plus ancien.
    private(set) var tracks: [Track] = []
    private(set) var pending: [Track] = []
    private(set) var activeID: String?
    private(set) var failedCount = 0
    private var downloadedIDs: Set<String> = []

    @ObservationIgnored private var worker: Task<Void, Never>?
    @ObservationIgnored private let directory: URL
    @ObservationIgnored private let indexURL: URL

    init() {
        let support = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("Nova", isDirectory: true)
        var downloads = support.appendingPathComponent("Downloads", isDirectory: true)
        try? FileManager.default.createDirectory(at: downloads, withIntermediateDirectories: true)
        var values = URLResourceValues()
        values.isExcludedFromBackup = true
        try? downloads.setResourceValues(values)
        directory = downloads
        indexURL = support.appendingPathComponent("downloads.json")

        if let data = try? Data(contentsOf: indexURL),
           let saved = try? JSONDecoder().decode([Track].self, from: data) {
            tracks = saved.filter { FileManager.default.fileExists(atPath: fileURL(for: $0.id).path) }
            downloadedIDs = Set(tracks.map(\.id))
        }
    }

    private func fileURL(for id: String) -> URL {
        directory.appendingPathComponent("\(id).m4a")
    }

    func state(of id: String) -> State {
        if downloadedIDs.contains(id) { return .downloaded }
        if activeID == id { return .downloading }
        if pending.contains(where: { $0.id == id }) { return .queued }
        return .none
    }

    func localURL(for id: String) -> URL? {
        downloadedIDs.contains(id) ? fileURL(for: id) : nil
    }

    func isDownloaded(_ tracks: [Track]) -> Bool {
        !tracks.isEmpty && tracks.allSatisfy { downloadedIDs.contains($0.id) }
    }

    func download(_ list: [Track]) {
        var seen = Set(pending.map(\.id))
        for track in list where !downloadedIDs.contains(track.id) && seen.insert(track.id).inserted {
            pending.append(track)
        }
        failedCount = 0
        startWorker()
    }

    func remove(_ id: String) {
        pending.removeAll { $0.id == id }
        guard downloadedIDs.contains(id) else { return }
        try? FileManager.default.removeItem(at: fileURL(for: id))
        downloadedIDs.remove(id)
        tracks.removeAll { $0.id == id }
        save()
    }

    func remove(_ list: [Track]) {
        list.forEach { remove($0.id) }
    }

    func cancelAll() {
        pending.removeAll()
    }

    func removeAll() {
        pending.removeAll()
        for track in tracks { try? FileManager.default.removeItem(at: fileURL(for: track.id)) }
        tracks = []
        downloadedIDs = []
        save()
    }

    func sizeInBytes() -> Int64 {
        tracks.reduce(0) { total, track in
            let size = (try? fileURL(for: track.id).resourceValues(forKeys: [.fileSizeKey]).fileSize) ?? 0
            return total + Int64(size)
        }
    }

    private func startWorker() {
        guard worker == nil else { return }
        worker = Task { [weak self] in
            while let next = self?.pending.first {
                guard let self else { return }
                self.activeID = next.id
                let ok = await self.fetch(next)
                self.pending.removeAll { $0.id == next.id }
                if ok {
                    self.tracks.insert(next, at: 0)
                    self.downloadedIDs.insert(next.id)
                    self.save()
                } else {
                    self.failedCount += 1
                }
                self.activeID = nil
            }
            self?.worker = nil
        }
    }

    private func fetch(_ track: Track) async -> Bool {
        let destination = fileURL(for: track.id)
        if let cached = await AudioCache.shared.localURL(for: track.id) {
            try? FileManager.default.removeItem(at: destination)
            if (try? FileManager.default.copyItem(at: cached, to: destination)) != nil { return true }
        }
        do {
            let stream = try await StreamResolver.audioStream(for: track.id)
            guard stream.isM4A else { return false }
            try await ChunkedDownloader.download(stream.url, to: destination)
            return true
        } catch {
            return false
        }
    }

    private func save() {
        try? JSONEncoder().encode(tracks).write(to: indexURL, options: .atomic)
    }
}
