import Foundation

struct JamCircle {
    static let defaultRelay = JamCircle(endpoint: URL(string: "https://akarukasu.astra.usbx.me/nova-jam")!)
    let endpoint: URL
    let key: String?

    init(endpoint: URL, key: String? = nil) {
        self.endpoint = endpoint
        self.key = key
    }

    init?(_ link: String) {
        guard var url = URLComponents(string: link.trimmingCharacters(in: .whitespacesAndNewlines)),
              url.scheme == "https", url.host != nil, url.user == nil, url.password == nil, url.query == nil,
              url.path == "/nova-jam" || url.path == "/nova-jam/",
              let key = url.fragment, key.range(of: #"^[a-fA-F0-9]{32,128}$"#, options: .regularExpression) != nil else { return nil }
        url.path = "/nova-jam"
        url.fragment = nil
        guard let endpoint = url.url else { return nil }
        self.endpoint = endpoint
        self.key = key
    }

    func request(_ action: String, fields: [String: Any] = [:]) async throws -> JamRelayReply {
        var body = fields
        body["action"] = action
        var request = URLRequest(url: endpoint, timeoutInterval: 6)
        request.httpMethod = "POST"
        if let key { request.setValue("Bearer " + key, forHTTPHeaderField: "Authorization") }
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try JSONSerialization.data(withJSONObject: body)
        let (data, response) = try await URLSession.shared.data(for: request, delegate: JamNoRedirect())
        let status = (response as? HTTPURLResponse)?.statusCode ?? 0
        let reply = try? JSONDecoder().decode(JamRelayReply.self, from: data)
        guard status == 200 else {
            let fallback = key != nil && (status == 401 || status == 403)
                ? "Vérifie le lien de configuration hôte dans Nova."
                : "Le relais Jam ne répond pas (HTTP \(status))."
            throw JamRelayError(status: status, reason: reply?.error ?? fallback)
        }
        guard let reply else { throw JamRelayError(status: status, reason: "Réponse du relais Jam illisible.") }
        return reply
    }
}

struct JamInvitation {
    let room: String
    let circle: JamCircle

    init?(_ url: URL) {
        guard var parts = URLComponents(url: url, resolvingAgainstBaseURL: false),
              parts.scheme == "https", parts.host != nil, parts.user == nil, parts.password == nil,
              parts.path == "/nova-jam/app/", parts.query == nil,
              let fragment = parts.fragment else { return nil }
        let keys = fragment.split(separator: ".", omittingEmptySubsequences: false)
        guard keys.count == 2, keys[0].utf8.count == 16, keys[1].utf8.count == 48,
              keys.allSatisfy({ part in part.utf8.allSatisfy { (48...57).contains($0) || (97...102).contains($0) } }) else { return nil }
        parts.path = "/nova-jam"
        parts.fragment = nil
        guard let endpoint = parts.url else { return nil }
        room = String(keys[0])
        circle = JamCircle(endpoint: endpoint, key: String(keys[1]))
    }

    static func link(circle: JamCircle, room: String, key: String) -> URL? {
        guard var parts = URLComponents(url: circle.endpoint, resolvingAgainstBaseURL: false) else { return nil }
        parts.path = "/nova-jam/app/"
        parts.fragment = room + "." + key
        guard let url = parts.url, JamInvitation(url) != nil else { return nil }
        return url
    }
}

private final class JamNoRedirect: NSObject, URLSessionTaskDelegate {
    func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse,
                    newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) {
        completionHandler(nil)
    }
}

struct JamRelayError: LocalizedError {
    let status: Int
    let reason: String
    var errorDescription: String? { reason }
}

struct RemoteJamRoom: Codable, Identifiable, Hashable {
    let id: String
    let name: String
    let people: Int
}

struct JamRelayReply: Decodable {
    var error: String?
    var rooms: [RemoteJamRoom]?
    var id: String?
    var token: String?
    var invite: String?
    var version: Int?
    var state: JamWireState?
    var participants: [String]?
    var events: [JamWireEvent]?

    func hostInvitation(circle: JamCircle, room: String) throws -> URL {
        guard let invite, let url = JamInvitation.link(circle: circle, room: room, key: invite) else {
            throw JamRelayError(status: 200, reason: "Le relais n’a pas fourni d’invitation. Réessaie de créer le Jam.")
        }
        return url
    }
}

struct JamWireState: Codable {
    var hostName: String
    var queue: [LibraryStore.HistorySnapshot.WireTrack]
    var index: Int
    var playing: Bool
    var position: Double
    var sentAt: Double
    var participants: [String]
    var guestsCanControl: Bool
    var addedBy: [String: String]

    init(_ state: JamState) {
        hostName = state.hostName
        queue = state.queue.map(LibraryStore.HistorySnapshot.WireTrack.init)
        index = state.index
        playing = state.isPlaying
        position = state.position
        sentAt = state.sentAt.timeIntervalSince1970 * 1000
        participants = state.participants
        guestsCanControl = state.guestsCanControl
        addedBy = state.addedBy
    }

    var native: JamState {
        JamState(hostName: hostName, queue: queue.map(\.track), index: index, isPlaying: playing,
                 position: position, sentAt: Date(timeIntervalSince1970: sentAt / 1000),
                 participants: participants, guestsCanControl: guestsCanControl, addedBy: addedBy)
    }
}

struct JamWireEvent: Decodable {
    struct Event: Decodable {
        var type: String
        var track: LibraryStore.HistorySnapshot.WireTrack?
        var next: Bool?
        var command: JamCommand?
    }
    var seq: Int
    var name: String
    var event: Event
}
