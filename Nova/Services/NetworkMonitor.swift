import Foundation
import Network

/// État du réseau : Wi-Fi ou données mobiles (pour respecter les réglages).
final class NetworkMonitor: @unchecked Sendable {
    static let shared = NetworkMonitor()

    private let monitor = NWPathMonitor()
    private let lock = NSLock()
    private var expensive = false
    private var connected = true

    private init() {
        monitor.pathUpdateHandler = { [weak self] path in
            guard let self else { return }
            self.lock.lock()
            self.expensive = path.isExpensive
            self.connected = path.status == .satisfied
            self.lock.unlock()
        }
        monitor.start(queue: DispatchQueue(label: "nova.network"))
    }

    /// Données mobiles (ou partage de connexion).
    var isExpensive: Bool {
        lock.lock(); defer { lock.unlock() }
        return expensive
    }

    var isConnected: Bool {
        lock.lock(); defer { lock.unlock() }
        return connected
    }

    var allowsCaching: Bool { !isExpensive || PlaybackSettings.cacheOnCellular }
    var allowsDownloads: Bool { !isExpensive || PlaybackSettings.downloadOnCellular }
}
