import Foundation
import Network

/// État du réseau : Wi-Fi ou données mobiles (pour respecter les réglages).
final class NetworkMonitor: @unchecked Sendable {
    static let shared = NetworkMonitor()

    private let monitor = NWPathMonitor()
    private let lock = NSLock()
    private var expensive = false
    private var connected = true
    private var interfaces: [NWInterface.InterfaceType] = []

    private init() {
        monitor.pathUpdateHandler = { [weak self] path in
            guard let self else { return }
            self.lock.lock()
            let current = [NWInterface.InterfaceType.wifi, .cellular, .wiredEthernet, .other]
                .filter { path.usesInterfaceType($0) }
            let changed = !self.interfaces.isEmpty && current != self.interfaces && path.status == .satisfied
            self.interfaces = current
            self.expensive = path.isExpensive
            self.connected = path.status == .satisfied
            self.lock.unlock()
            // Nouveau réseau : les liens de flux déjà obtenus ne sont plus valables.
            if changed {
                Task { await StreamResolver.invalidateAll() }
                NotificationCenter.default.post(name: NetworkMonitor.didChangeNetwork, object: nil)
            }
        }
        monitor.start(queue: DispatchQueue(label: "nova.network"))
    }

    static let didChangeNetwork = Notification.Name("NovaNetworkDidChange")

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
