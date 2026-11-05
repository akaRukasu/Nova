import Foundation

/// Envoi de la bibliothèque vers Nova pour Windows, sur le réseau local (QR code affiché par le PC).
enum LibraryTransfer {
    struct Request: Identifiable, Equatable {
        let url: URL
        let token: String
        let computer: String
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
        return Request(url: target, token: token, computer: computer)
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
        guard let body = library.exportData() else { throw TransferError.refused(0) }
        var urlRequest = URLRequest(url: request.url, timeoutInterval: 60)
        urlRequest.httpMethod = "POST"
        urlRequest.setValue("application/json", forHTTPHeaderField: "Content-Type")
        urlRequest.setValue(request.token, forHTTPHeaderField: "X-Nova-Token")
        let (data, response) = try await URLSession.shared.upload(for: urlRequest, from: body)
        let status = (response as? HTTPURLResponse)?.statusCode ?? 0
        guard status == 200 else { throw TransferError.refused(status) }
        let summary = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any]
        let playlists = summary?["playlists"] as? Int ?? library.playlists.count
        let tracks = summary?["tracks"] as? Int ?? library.songs.count
        return "\(playlists) playlists et \(tracks) titres envoyés vers \(request.computer)."
    }
}
