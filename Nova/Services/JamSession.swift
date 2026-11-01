import Foundation
import Observation
@preconcurrency import MultipeerConnectivity

/// État partagé d'un Jam, envoyé par l'hôte à chaque changement (et toutes les 3 s).
struct JamState: Codable, Equatable {
    var hostName: String
    var queue: [Track]
    var index: Int
    var isPlaying: Bool
    var position: TimeInterval
    var sentAt: Date
    var participants: [String]
    var guestsCanControl: Bool
    /// Identifiant du titre → prénom de la personne qui l'a ajouté.
    var addedBy: [String: String]

    var current: Track? { queue.indices.contains(index) ? queue[index] : nil }
    var upcoming: [Track] { queue.indices.contains(index) ? Array(queue[(index + 1)...]) : [] }
}

enum JamCommand: String, Codable {
    case play, pause, next, previous
}

enum JamMessage: Codable {
    case state(JamState)
    case hello(name: String)
    case add(Track, next: Bool)
    case command(JamCommand)
    case ended
}

/// Jam : écouter à plusieurs, comme sur Spotify. Un iPhone lance le Jam et joue la musique ;
/// les amis à proximité qui ont Nova le rejoignent (Wi-Fi ou Bluetooth, sans compte ni serveur),
/// ajoutent des titres à la file commune, et peuvent écouter en même temps sur leur iPhone.
@MainActor
@Observable
final class JamSession: NSObject {
    static let shared = JamSession()

    enum Role { case none, host, guest }

    private(set) var role: Role = .none
    /// Jams lancés autour de soi (nom de l'hôte).
    private(set) var nearby: [NearbyJam] = []
    /// Dernier état connu (reçu de l'hôte, ou envoyé par soi en tant qu'hôte).
    private(set) var state: JamState?
    private(set) var isConnecting = false
    var message: String?
    var guestsCanControl = true {
        didSet { if role == .host { broadcastState() } }
    }
    /// Invité : joue la musique aussi sur cet iPhone, calée sur l'hôte.
    var listenAlong = false {
        didSet { if listenAlong, let state { follow(state) } }
    }
    var displayName: String {
        didSet { UserDefaults.standard.set(displayName, forKey: "jamName") }
    }

    struct NearbyJam: Identifiable, Hashable {
        let peer: MCPeerID
        let name: String
        var id: MCPeerID { peer }
    }

    @ObservationIgnored private let serviceType = "nova-jam"
    @ObservationIgnored private var peerID: MCPeerID?
    @ObservationIgnored private var session: MCSession?
    @ObservationIgnored private var advertiser: MCNearbyServiceAdvertiser?
    @ObservationIgnored private var browser: MCNearbyServiceBrowser?
    @ObservationIgnored private var heartbeat: Task<Void, Never>?
    @ObservationIgnored private var lastSignature = ""
    @ObservationIgnored private var lastSent = Date.distantPast
    @ObservationIgnored private var names: [MCPeerID: String] = [:]
    @ObservationIgnored private var addedBy: [String: String] = [:]

    private var player: PlayerModel { PlayerModel.shared }

    override init() {
        displayName = UserDefaults.standard.string(forKey: "jamName") ?? ""
        super.init()
    }

    private var publicName: String {
        let name = displayName.trimmingCharacters(in: .whitespaces)
        return name.isEmpty ? "Ami Nova" : String(name.prefix(40))
    }

    private func makePeer() -> MCPeerID {
        let peer = MCPeerID(displayName: publicName)
        peerID = peer
        return peer
    }

    // MARK: Hôte

    func startHosting() {
        leave(silently: true)
        let peer = makePeer()
        let session = MCSession(peer: peer, securityIdentity: nil, encryptionPreference: .required)
        session.delegate = self
        self.session = session
        let advertiser = MCNearbyServiceAdvertiser(peer: peer, discoveryInfo: ["name": publicName], serviceType: serviceType)
        advertiser.delegate = self
        advertiser.startAdvertisingPeer()
        self.advertiser = advertiser
        role = .host
        addedBy = [:]
        broadcastState()
        heartbeat = Task { [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(for: .seconds(1))
                self?.hostTick()
            }
        }
    }

    /// Envoie l'état dès que la file, le titre ou la lecture changent, et toutes les 3 s.
    private func hostTick() {
        guard role == .host else { return }
        let signature = "\(player.queue.map(\.id).joined(separator: ","))|\(player.index)|\(player.isPlaying)"
        if signature != lastSignature || Date().timeIntervalSince(lastSent) > 3 { broadcastState() }
    }

    private func currentHostState() -> JamState {
        JamState(hostName: publicName, queue: Array(player.queue.prefix(200)), index: player.index,
                 isPlaying: player.isPlaying, position: player.currentTime, sentAt: Date(),
                 participants: (session?.connectedPeers ?? []).map { names[$0] ?? $0.displayName },
                 guestsCanControl: guestsCanControl, addedBy: addedBy)
    }

    private func broadcastState() {
        guard role == .host else { return }
        let current = currentHostState()
        state = current
        lastSignature = "\(player.queue.map(\.id).joined(separator: ","))|\(player.index)|\(player.isPlaying)"
        lastSent = Date()
        send(.state(current))
    }

    private func handleAsHost(_ message: JamMessage, from peer: MCPeerID) {
        let guest = names[peer] ?? peer.displayName
        switch message {
        case .hello(let name):
            names[peer] = name
            self.message = "\(name) a rejoint le Jam"
        case .add(let track, let next):
            addedBy[track.id] = guest
            next ? player.playNext(track) : player.enqueue(track)
        case .command(let command):
            guard guestsCanControl else { return }
            switch command {
            case .play: player.resume()
            case .pause: player.pause()
            case .next: player.next()
            case .previous: player.previous()
            }
        case .state, .ended:
            return
        }
        broadcastState()
    }

    // MARK: Invité

    /// Cherche les Jams autour de soi (tant que la page Jam est ouverte).
    func startBrowsing() {
        guard role == .none, browser == nil else { return }
        let peer = peerID ?? makePeer()
        let browser = MCNearbyServiceBrowser(peer: peer, serviceType: serviceType)
        browser.delegate = self
        browser.startBrowsingForPeers()
        self.browser = browser
    }

    func stopBrowsing() {
        browser?.stopBrowsingForPeers()
        browser = nil
        if role == .none { nearby = [] }
    }

    func join(_ jam: NearbyJam) {
        guard let browser, let peer = peerID else { return }
        let session = MCSession(peer: peer, securityIdentity: nil, encryptionPreference: .required)
        session.delegate = self
        self.session = session
        isConnecting = true
        browser.invitePeer(jam.peer, to: session, withContext: nil, timeout: 20)
    }

    /// Ajoute un titre à la file commune (hôte : directement ; invité : envoyé à l'hôte).
    func add(_ track: Track, next: Bool = false) {
        switch role {
        case .host:
            addedBy[track.id] = publicName
            next ? player.playNext(track) : player.enqueue(track)
            broadcastState()
        case .guest:
            send(.add(track, next: next))
            message = "« \(track.title) » ajouté au Jam"
        case .none:
            break
        }
    }

    func command(_ command: JamCommand) {
        guard role == .guest else { return }
        send(.command(command))
    }

    private func handleAsGuest(_ message: JamMessage) {
        switch message {
        case .state(let received):
            state = received
            if listenAlong { follow(received) }
        case .ended:
            leave(silently: true)
            self.message = "Le Jam est terminé"
        default:
            return
        }
    }

    /// Écoute en même temps : position de l'hôte, corrigée du temps de transmission.
    private func follow(_ state: JamState) {
        let elapsed = state.isPlaying ? max(0, min(Date().timeIntervalSince(state.sentAt), 5)) : 0
        player.followJam(queue: state.queue, index: state.index, position: state.position + elapsed,
                         playing: state.isPlaying)
    }

    // MARK: Fin

    func leave(silently: Bool = false) {
        if role == .host { send(.ended) }
        heartbeat?.cancel()
        heartbeat = nil
        advertiser?.stopAdvertisingPeer()
        advertiser = nil
        browser?.stopBrowsingForPeers()
        browser = nil
        session?.disconnect()
        session = nil
        role = .none
        state = nil
        nearby = []
        names = [:]
        isConnecting = false
        listenAlong = false
        if !silently { message = nil }
    }

    // MARK: Envoi

    private func send(_ message: JamMessage) {
        guard let session, !session.connectedPeers.isEmpty,
              let data = try? JSONEncoder().encode(message) else { return }
        try? session.send(data, toPeers: session.connectedPeers, with: .reliable)
    }

    fileprivate func peer(_ peer: MCPeerID, changed newState: MCSessionState) {
        switch newState {
        case .connected:
            if role == .host {
                broadcastState()
            } else {
                role = .guest
                isConnecting = false
                stopBrowsing()
                send(.hello(name: publicName))
            }
        case .notConnected:
            if role == .host {
                if let name = names.removeValue(forKey: peer) { message = "\(name) a quitté le Jam" }
                broadcastState()
            } else if role == .guest {
                leave(silently: true)
                message = "Connexion au Jam perdue"
            } else if isConnecting {
                isConnecting = false
                message = "Impossible de rejoindre ce Jam"
            }
        default:
            break
        }
    }

    fileprivate func received(_ data: Data, from peer: MCPeerID) {
        guard let message = try? JSONDecoder().decode(JamMessage.self, from: data) else { return }
        role == .host ? handleAsHost(message, from: peer) : handleAsGuest(message)
    }

    fileprivate func found(_ peer: MCPeerID, info: [String: String]?) {
        guard peer != peerID, !nearby.contains(where: { $0.peer == peer }) else { return }
        nearby.append(NearbyJam(peer: peer, name: info?["name"] ?? peer.displayName))
    }

    fileprivate func lost(_ peer: MCPeerID) {
        nearby.removeAll { $0.peer == peer }
    }

    fileprivate var hostSession: MCSession? { role == .host ? session : nil }
}

// MARK: - Délégués (appelés hors du fil principal)

extension JamSession: MCSessionDelegate {
    nonisolated func session(_ session: MCSession, peer peerID: MCPeerID, didChange state: MCSessionState) {
        Task { @MainActor in self.peer(peerID, changed: state) }
    }

    nonisolated func session(_ session: MCSession, didReceive data: Data, fromPeer peerID: MCPeerID) {
        Task { @MainActor in self.received(data, from: peerID) }
    }

    nonisolated func session(_ session: MCSession, didReceive stream: InputStream, withName streamName: String,
                             fromPeer peerID: MCPeerID) {}
    nonisolated func session(_ session: MCSession, didStartReceivingResourceWithName resourceName: String,
                             fromPeer peerID: MCPeerID, with progress: Progress) {}
    nonisolated func session(_ session: MCSession, didFinishReceivingResourceWithName resourceName: String,
                             fromPeer peerID: MCPeerID, at localURL: URL?, withError error: Error?) {}
}

extension JamSession: MCNearbyServiceAdvertiserDelegate {
    /// Tout ami à proximité peut rejoindre le Jam, comme un Jam Spotify ouvert.
    nonisolated func advertiser(_ advertiser: MCNearbyServiceAdvertiser, didReceiveInvitationFromPeer peerID: MCPeerID,
                                withContext context: Data?, invitationHandler: @escaping (Bool, MCSession?) -> Void) {
        Task { @MainActor in
            let session = self.hostSession
            invitationHandler(session != nil, session)
        }
    }
}

extension JamSession: MCNearbyServiceBrowserDelegate {
    nonisolated func browser(_ browser: MCNearbyServiceBrowser, foundPeer peerID: MCPeerID,
                             withDiscoveryInfo info: [String: String]?) {
        Task { @MainActor in self.found(peerID, info: info) }
    }

    nonisolated func browser(_ browser: MCNearbyServiceBrowser, lostPeer peerID: MCPeerID) {
        Task { @MainActor in self.lost(peerID) }
    }
}
