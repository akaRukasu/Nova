import Foundation
import Network
import Observation
import UIKit

/// Envoi de la bibliothèque vers Nova pour Windows, sur le réseau local (QR code affiché par le PC).
enum LibraryTransfer {
    struct Request: Identifiable, Equatable, Codable {
        var url: URL
        let token: String
        let computer: String
        /// Identifiant du PC (annoncé en Bonjour) : l'iPhone le retrouve même si son adresse change.
        var pcId: String?
        var id: String { token }
    }

    enum TransferError: LocalizedError {
        case refused(Int)
        case notLocal

        var errorDescription: String? {
            switch self {
            case .refused(let code): return "Le PC a refusé le transfert (\(code)). Affiche un nouveau QR code dans Nova pour Windows."
            case .notLocal: return "Ce QR code ne vient pas d'un PC de ton réseau local."
            }
        }
    }

    /// « nova://sync?u=http://192.168.1.20:51234/sync&t=JETON&n=PC-de-Lucas »
    static func request(from url: URL) -> Request? {
        guard url.scheme == "nova", url.host == "sync",
              let items = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems,
              let target = items.first(where: { $0.name == "u" })?.value.flatMap(URL.init(string:)),
              let token = items.first(where: { $0.name == "t" })?.value, !token.isEmpty else { return nil }
        let computer = items.first(where: { $0.name == "n" })?.value ?? "ton PC"
        return Request(url: target, token: token, computer: computer, pcId: items.first(where: { $0.name == "id" })?.value)
    }

    /// Seulement vers une adresse du réseau local : la bibliothèque ne part jamais sur Internet.
    static func isLocal(_ url: URL) -> Bool {
        guard url.scheme == "http", let host = url.host else { return false }
        if host.hasSuffix(".local") { return true }
        let parts = host.split(separator: ".").compactMap { Int($0) }
        guard parts.count == 4 else { return false }
        return parts[0] == 10 || (parts[0] == 192 && parts[1] == 168) || (parts[0] == 172 && (16...31).contains(parts[1]))
            || (parts[0] == 169 && parts[1] == 254)
    }

    @MainActor
    static func send(_ request: Request, library: LibraryStore) async throws -> String {
        guard isLocal(request.url) else { throw TransferError.notLocal }
        guard let body = await library.exportDataInBackground() else { throw TransferError.refused(0) }
        var urlRequest = URLRequest(url: request.url, timeoutInterval: 60)
        urlRequest.httpMethod = "POST"
        urlRequest.setValue("application/json", forHTTPHeaderField: "Content-Type")
        urlRequest.setValue(request.token, forHTTPHeaderField: "X-Nova-Token")
        urlRequest.setValue(UIDevice.current.name, forHTTPHeaderField: "X-Nova-Device")
        let (data, response) = try await URLSession.shared.upload(for: urlRequest, from: body)
        let status = (response as? HTTPURLResponse)?.statusCode ?? 0
        guard status == 200 else { throw TransferError.refused(status) }
        let summary = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any]
        let playlists = summary?["playlists"] as? Int ?? library.playlists.count
        let tracks = summary?["tracks"] as? Int ?? library.songs.count
        return "\(playlists) playlists et \(tracks) titres envoyés vers \(request.computer)."
    }
}

/// Synchronisation automatique avec le PC associé : dès que la bibliothèque change (et à l'ouverture),
/// Nova retrouve le PC sur le Wi-Fi (adresse connue, sinon Bonjour) et lui envoie les nouveautés.
@MainActor
@Observable
final class PCSync {
    static let shared = PCSync()

    private struct State: Codable {
        var request: LibraryTransfer.Request
        var lastRevision = -1
        var lastHistoryRevision: Int?
        var lastSync: Date?
        /// Adresses où le PC a déjà répondu (maison, partage de connexion…), la plus récente d'abord.
        var knownURLs: [URL]?
    }

    private(set) var pairedComputer: String?
    private(set) var lastSync: Date?
    private(set) var isSyncing = false
    @ObservationIgnored private var state: State?
    @ObservationIgnored private var pending: Task<Void, Never>?
    @ObservationIgnored private var heartbeat: Task<Void, Never>?

    private init() {
        if let data = UserDefaults.standard.data(forKey: "pcSync"), let saved = try? JSONDecoder().decode(State.self, from: data) {
            state = saved
            pairedComputer = saved.request.computer
            lastSync = saved.lastSync
        }
    }

    var isPaired: Bool { state != nil }

    private func persist() {
        if let state, let data = try? JSONEncoder().encode(state) { UserDefaults.standard.set(data, forKey: "pcSync") }
    }

    /// Association (QR code) puis premier envoi complet.
    func pair(_ request: LibraryTransfer.Request, library: LibraryStore) async throws -> String {
        state = State(request: request)
        pairedComputer = request.computer
        persist()
        startHeartbeat(library: library)
        return try await sync(library: library, force: true) ?? ""
    }

    func unpair() {
        state = nil
        pairedComputer = nil
        lastSync = nil
        UserDefaults.standard.removeObject(forKey: "pcSync")
        heartbeat?.cancel()
    }

    /// Bibliothèque modifiée : envoi groupé 20 s plus tard (plusieurs ajouts d'affilée = un seul envoi).
    func libraryChanged(_ library: LibraryStore) {
        guard isPaired else { return }
        pending?.cancel()
        pending = Task { [weak self] in
            try? await Task.sleep(for: .seconds(20))
            guard !Task.isCancelled else { return }
            _ = try? await self?.sync(library: library)
        }
    }

    /// Vérification régulière (toutes les 10 min) tant que Nova tourne : le PC a pu être rallumé entre-temps.
    func startHeartbeat(library: LibraryStore) {
        guard isPaired, heartbeat == nil else { return }
        heartbeat = Task { [weak self] in
            while !Task.isCancelled {
                _ = try? await self?.sync(library: library, includeHistory: true)
                try? await Task.sleep(for: .seconds(600))
            }
        }
    }

    @discardableResult
    func sync(library: LibraryStore, force: Bool = false, includeHistory: Bool = false) async throws -> String? {
        guard var current = state, !isSyncing else { return nil }
        let contentChanged = library.revision != current.lastRevision
        let historyChanged = includeHistory && library.historyRevision != current.lastHistoryRevision
        guard force || contentChanged || historyChanged else { return nil }
        isSyncing = true
        defer { isSyncing = false }
        guard let url = await locate(current.request) else {
            if force { throw LibraryTransfer.TransferError.refused(0) }
            return nil
        }
        remember(url)
        current.request.url = url
        current.knownURLs = state?.knownURLs
        let message = try await LibraryTransfer.send(current.request, library: library)
        current.lastRevision = library.revision
        current.lastHistoryRevision = library.historyRevision
        current.lastSync = Date()
        state = current
        lastSync = current.lastSync
        persist()
        return message
    }

    // MARK: Trouver le PC

    /// Adresse actuelle du PC associé (sans « /sync ») et son code, pour la télécommande.
    func locateComputer() async -> (base: URL, token: String)? {
        guard let request = state?.request, let url = await locate(request),
              var components = URLComponents(url: url, resolvingAgainstBaseURL: false) else { return nil }
        components.path = ""
        guard let base = components.url else { return nil }
        remember(url)
        return (base, request.token)
    }

    /// Adresse où le PC vient de répondre : utilisée en premier la prochaine fois, sans oublier les autres
    /// (l'adresse de la maison reste connue après un passage par le partage de connexion).
    private func remember(_ url: URL) {
        guard var current = state else { return }
        let previous = current.request.url
        var known = [url, previous] + (current.knownURLs ?? [])
        var seen = Set<URL>()
        known = known.filter { seen.insert($0).inserted }
        guard current.request.url != url || current.knownURLs != Array(known.prefix(6)) else { return }
        current.request.url = url
        current.knownURLs = Array(known.prefix(6))
        state = current
        persist()
    }

    private func locate(_ request: LibraryTransfer.Request) async -> URL? {
        // Toutes les adresses déjà connues, essayées en même temps.
        var seen = Set<URL>()
        let known = ([request.url] + (state?.knownURLs ?? [])).filter { seen.insert($0).inserted }
        if let found = await firstAnswering(known, pcId: request.pcId, timeout: 2.5) { return found }
        guard let pcId = request.pcId else { return nil }
        if let found = await browse(pcId: pcId) { return found }
        let ports = Array(Set([request.url.port ?? 47822, 47822]))
        // Partage de connexion de cet iPhone (le PC y reçoit 172.20.10.2 à .14), puis tout le réseau Wi-Fi de l'iPhone :
        // adresse du PC changée par la box, ou Bonjour bloqué sur le réseau.
        var candidates = (2...14).flatMap { host in ports.compactMap { URL(string: "http://172.20.10.\(host):\($0)/sync") } }
        if let (prefix, own) = Self.wifiSubnet() {
            candidates += (1...254).filter { $0 != own }.flatMap { host in ports.compactMap { URL(string: "http://\(prefix).\(host):\($0)/sync") } }
        }
        return await firstAnswering(candidates.filter { !seen.contains($0) }, pcId: pcId, timeout: 1.5)
    }

    /// Première adresse où le PC associé répond (par groupes de 64, pour ne pas saturer le réseau).
    private func firstAnswering(_ urls: [URL], pcId: String?, timeout: TimeInterval) async -> URL? {
        var start = 0
        while start < urls.count {
            let batch = Array(urls[start..<min(start + 64, urls.count)])
            start += 64
            let found = await withTaskGroup(of: URL?.self) { group -> URL? in
                for url in batch {
                    group.addTask { await self.answers(url, pcId: pcId, timeout: timeout) ? url : nil }
                }
                for await found in group {
                    if let found {
                        group.cancelAll()
                        return found
                    }
                }
                return nil
            }
            if let found { return found }
        }
        return nil
    }

    /// Réseau Wi-Fi de l'iPhone (« 192.168.1 ») et son propre numéro dessus.
    nonisolated private static func wifiSubnet() -> (String, Int)? {
        var addresses: UnsafeMutablePointer<ifaddrs>?
        guard getifaddrs(&addresses) == 0, let first = addresses else { return nil }
        defer { freeifaddrs(addresses) }
        var pointer: UnsafeMutablePointer<ifaddrs>? = first
        while let entry = pointer {
            defer { pointer = entry.pointee.ifa_next }
            guard String(cString: entry.pointee.ifa_name) == "en0", let address = entry.pointee.ifa_addr,
                  address.pointee.sa_family == UInt8(AF_INET) else { continue }
            var host = [CChar](repeating: 0, count: Int(NI_MAXHOST))
            guard getnameinfo(address, socklen_t(address.pointee.sa_len), &host, socklen_t(host.count), nil, 0, NI_NUMERICHOST) == 0 else { continue }
            let parts = String(cString: host).split(separator: ".")
            guard parts.count == 4, let own = Int(parts[3]) else { continue }
            let prefix = parts[0...2].joined(separator: ".")
            guard LibraryTransfer.isLocal(URL(string: "http://\(prefix).1")!) else { return nil }
            return (prefix, own)
        }
        return nil
    }

    /// Le PC répond-il à cette adresse (et est-ce bien lui) ?
    private func answers(_ url: URL, pcId: String?, timeout: TimeInterval = 3) async -> Bool {
        guard LibraryTransfer.isLocal(url), var components = URLComponents(url: url, resolvingAgainstBaseURL: false) else { return false }
        components.path = "/status"
        guard let status = components.url else { return false }
        var request = URLRequest(url: status, timeoutInterval: timeout)
        request.httpMethod = "GET"
        guard let (data, response) = try? await URLSession.shared.data(for: request),
              (response as? HTTPURLResponse)?.statusCode == 200,
              let json = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] else { return false }
        return pcId == nil || json["pcId"] as? String == pcId
    }

    /// Bonjour : « _nova-sync._tcp » dont l'identifiant est celui du PC associé.
    private func browse(pcId: String) async -> URL? {
        await withCheckedContinuation { continuation in
            let browser = NWBrowser(for: .bonjourWithTXTRecord(type: "_nova-sync._tcp", domain: nil), using: .tcp)
            var finished = false
            let finish: (URL?) -> Void = { url in
                guard !finished else { return }
                finished = true
                browser.cancel()
                continuation.resume(returning: url)
            }
            browser.browseResultsChangedHandler = { results, _ in
                for result in results {
                    guard case .bonjour(let txt) = result.metadata, txt["id"] == pcId else { continue }
                    PCSync.resolve(result.endpoint) { url in DispatchQueue.main.async { finish(url) } }
                    return
                }
            }
            browser.start(queue: .main)
            DispatchQueue.main.asyncAfter(deadline: .now() + 6) { finish(nil) }
        }
    }

    /// Adresse IPv4 et port d'un service Bonjour (connexion ouverte puis refermée aussitôt).
    nonisolated private static func resolve(_ endpoint: NWEndpoint, completion: @escaping @Sendable (URL?) -> Void) {
        let parameters = NWParameters.tcp
        if let ip = parameters.defaultProtocolStack.internetProtocol as? NWProtocolIP.Options { ip.version = .v4 }
        let connection = NWConnection(to: endpoint, using: parameters)
        connection.stateUpdateHandler = { state in
            switch state {
            case .ready:
                if case .hostPort(let host, let port) = connection.currentPath?.remoteEndpoint,
                   case .ipv4(let address) = host {
                    completion(URL(string: "http://\(address):\(port.rawValue)/sync"))
                } else {
                    completion(nil)
                }
                connection.cancel()
            case .failed, .cancelled:
                completion(nil)
            default:
                break
            }
        }
        connection.start(queue: .global(qos: .utility))
        DispatchQueue.global().asyncAfter(deadline: .now() + 5) { connection.cancel() }
    }
}
