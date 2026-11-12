import Foundation

struct JamCircle {
    let endpoint: URL
    let key: String

    init?(_ link: String) {
        guard var url = URLComponents(string: link.trimmingCharacters(in: .whitespacesAndNewlines)),
              url.scheme == "https", url.host != nil, url.user == nil, url.password == nil, url.query == nil,
              url.path == "/nova-jam" || url.path == "/nova-jam/",
              let key = url.fragment, key.range(of: #"^[a-fA-F0-9]{32,128}$"#, options: .regularExpression) != nil else { return nil }
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
        request.setValue("Bearer " + key, forHTTPHeaderField: "Authorization")
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try JSONSerialization.data(withJSONObject: body)
        let (data, response) = try await URLSession.shared.data(for: request, delegate: JamNoRedirect())
        let status = (response as? HTTPURLResponse)?.statusCode ?? 0
        let reply = try JSONDecoder().decode(JamRelayReply.self, from: data)
        guard status == 200 else { throw JamRelayError(status: status, reason: reply.error ?? "Relais Jam indisponible.") }
        return reply
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
    var version: Int?
    var state: JamWireState?
    var participants: [String]?
    var events: [JamWireEvent]?
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
