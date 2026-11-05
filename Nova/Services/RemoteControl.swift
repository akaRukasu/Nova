import AVFoundation
import Foundation
import Observation

/// Télécommande de Nova pour Windows (comme Spotify Connect) : le PC associé joue la musique,
/// l'iPhone affiche ce qui joue et envoie les commandes. Le lecteur de l'iPhone reflète l'état du PC.
@MainActor
@Observable
final class RemoteControl {
    static let shared = RemoteControl()

    struct State: Decodable, Equatable {
        var name: String?
        var track: Track?
        var queue: [Track]
        var playing: Bool
        var loading: Bool?
        var time: Double
        var duration: Double
        var volume: Double
        var shuffled: Bool?
        var `repeat`: String?
    }

    private(set) var isActive = false
    private(set) var isConnecting = false
    private(set) var state: State?
    var errorMessage: String?

    @ObservationIgnored private var base: URL?
    @ObservationIgnored private var token = ""
    @ObservationIgnored private var poller: Task<Void, Never>?
    @ObservationIgnored private var failures = 0

    var deviceName: String { PCSync.shared.pairedComputer ?? state?.name ?? "PC" }

    /// Passe la lecture sur le PC : le titre en cours y reprend au même endroit.
    func activate(player: PlayerModel, transfer: Bool = true) async {
        guard !isActive, !isConnecting else { return }
        isConnecting = true
        defer { isConnecting = false }
        guard let found = await PCSync.shared.locateComputer() else {
            errorMessage = "\(deviceName) est introuvable : Nova doit être ouvert sur le PC, sur le même Wi-Fi."
            return
        }
        base = found.base
        token = found.token
        guard (await fetchState()) != nil else {
            errorMessage = "\(deviceName) ne répond pas."
            return
        }
        // Transfert : ce qui jouait sur l'iPhone continue sur le PC.
        let upcoming = Array(player.queue.dropFirst(player.index))
        let position = player.currentTime
        let wasPlaying = player.isPlaying
        player.enterRemote()
        isActive = true
        attachedAutomatically = !transfer
        SilentAudio.shared.start()
        if transfer, !upcoming.isEmpty, wasPlaying {
            await send(["action": "playTracks", "index": 0], tracks: upcoming)
            if position > 2 { await send(["action": "seek", "value": position]) }
        }
        startPolling(player: player)
    }

    /// Retour sur l'iPhone : le PC se met en pause et la lecture reprend ici au même endroit.
    func deactivate(player: PlayerModel, resumeHere: Bool = true) async {
        guard isActive else { return }
        let last = state
        if last?.playing == true { await send(["action": "pause"]) }
        poller?.cancel()
        poller = nil
        isActive = false
        SilentAudio.shared.stop()
        player.leaveRemote(resumeAt: resumeHere && last?.playing == true ? last : nil)
        state = nil
    }

    /// Mode activé tout seul parce que le PC jouait (et non choisi dans « Appareils »).
    private(set) var attachedAutomatically = false
    @ObservationIgnored private var idleSince: Date?
    @ObservationIgnored private var watcher: Task<Void, Never>?

    /// Tant que Nova est ouvert sur l'iPhone : si le PC associé joue et que l'iPhone ne joue rien,
    /// l'iPhone affiche la lecture du PC (centre de contrôle, écran verrouillé) et la pilote.
    func watchComputer(player: PlayerModel) {
        guard watcher == nil else { return }
        watcher = Task { [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(for: .seconds(5))
                guard let self, PCSync.shared.isPaired, !self.isActive, !self.isConnecting, !player.isPlaying else { continue }
                if self.base == nil, let found = await PCSync.shared.locateComputer() {
                    self.base = found.base
                    self.token = found.token
                }
                if let state = await self.fetchState(), state.playing {
                    await self.activate(player: player, transfer: false)
                }
            }
        }
    }

    private func startPolling(player: PlayerModel) {
        poller?.cancel()
        poller = Task { [weak self] in
            while !Task.isCancelled {
                guard let self else { return }
                if let fresh = await self.fetchState() {
                    self.failures = 0
                    player.mirrorRemote(fresh)
                    // Activé tout seul et le PC ne joue plus depuis 10 min : on rend la main (batterie).
                    if self.attachedAutomatically {
                        if fresh.playing { self.idleSince = nil } else if self.idleSince == nil { self.idleSince = Date() }
                        if let idle = self.idleSince, Date().timeIntervalSince(idle) > 600 {
                            self.idleSince = nil
                            await self.deactivate(player: player, resumeHere: false)
                            return
                        }
                    }
                } else {
                    self.failures += 1
                    if self.failures >= 5 {
                        self.errorMessage = "Connexion avec \(self.deviceName) perdue."
                        await self.deactivate(player: player, resumeHere: false)
                        return
                    }
                }
                try? await Task.sleep(for: .seconds(1))
            }
        }
    }

    @discardableResult
    private func fetchState() async -> State? {
        guard let url = base?.appendingPathComponent("remote/state") else { return nil }
        var request = URLRequest(url: url, timeoutInterval: 4)
        request.setValue(token, forHTTPHeaderField: "X-Nova-Token")
        guard let (data, response) = try? await URLSession.shared.data(for: request),
              (response as? HTTPURLResponse)?.statusCode == 200,
              let decoded = try? JSONDecoder().decode(State.self, from: data) else { return nil }
        state = decoded
        return decoded
    }

    /// Commande vers le PC ; l'état renvoyé met l'iPhone à jour aussitôt.
    func send(_ command: [String: Any], tracks: [Track]? = nil) async {
        guard let url = base?.appendingPathComponent("remote/command") else { return }
        var body = command
        if let tracks, let data = try? JSONEncoder().encode(Array(tracks.prefix(300))),
           let list = try? JSONSerialization.jsonObject(with: data) {
            body["tracks"] = list
        }
        var request = URLRequest(url: url, timeoutInterval: 8)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue(token, forHTTPHeaderField: "X-Nova-Token")
        request.httpBody = try? JSONSerialization.data(withJSONObject: body)
        guard let (data, _) = try? await URLSession.shared.data(for: request),
              let decoded = try? JSONDecoder().decode(State.self, from: data) else { return }
        state = decoded
        PlayerModel.shared.mirrorRemote(decoded)
    }

    func command(_ action: String, value: Double? = nil) {
        var body: [String: Any] = ["action": action]
        if let value { body["value"] = value }
        Task { await send(body) }
    }
}

/// Son silencieux joué pendant que le PC est piloté : iOS n'affiche les commandes de lecture
/// (centre de contrôle, écran verrouillé) que pour une app qui joue du son. Les boutons pilotent le PC.
@MainActor
final class SilentAudio {
    static let shared = SilentAudio()
    private var player: AVAudioPlayer?

    func start() {
        guard player == nil else { return }
        try? AVAudioSession.sharedInstance().setCategory(.playback, mode: .default, policy: .longFormAudio)
        try? AVAudioSession.sharedInstance().setActive(true)
        player = try? AVAudioPlayer(data: Self.silence())
        player?.numberOfLoops = -1
        player?.volume = 0
        player?.play()
    }

    func stop() {
        player?.stop()
        player = nil
    }

    /// Une seconde de silence (WAV 8 kHz, 16 bits, mono), créée en mémoire.
    private static func silence() -> Data {
        let rate: UInt32 = 8000, samples = rate
        var data = Data()
        func append<T>(_ value: T) { withUnsafeBytes(of: value) { data.append(contentsOf: $0) } }
        data.append(contentsOf: Array("RIFF".utf8)); append(UInt32(36 + samples * 2).littleEndian)
        data.append(contentsOf: Array("WAVEfmt ".utf8)); append(UInt32(16).littleEndian)
        append(UInt16(1).littleEndian); append(UInt16(1).littleEndian)
        append(rate.littleEndian); append((rate * 2).littleEndian)
        append(UInt16(2).littleEndian); append(UInt16(16).littleEndian)
        data.append(contentsOf: Array("data".utf8)); append(UInt32(samples * 2).littleEndian)
        data.append(Data(count: Int(samples * 2)))
        return data
    }
}
