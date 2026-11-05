import Foundation
import YouTubeKit

/// Trouve l'URL du fichier audio d'un titre via YouTubeKit.
enum StreamResolver {
    struct Resolved {
        let url: URL
        /// Seuls les m4a sont mis en cache : AVFoundation les lit sans conversion.
        let isM4A: Bool
    }

    /// Flux déjà résolus : relancer un titre ne refait pas l'extraction (plusieurs requêtes).
    private static let cache = ResolvedCache()
    private static let gate = ResolveGate()

    /// `background` : préparation du titre suivant, téléchargements. Ces extractions passent une par une.
    enum Urgency: Sendable { case playback, background }

    /// L'extraction exécute le code JavaScript de YouTube (JavaScriptCore) : c'est très gourmand.
    /// iOS ferme une app en arrière-plan qui dépasse 80 % de processeur pendant une minute : on n'en
    /// lance donc jamais deux pour le même titre, et une seule à la fois pour ce qui n'est pas urgent.
    static func audioStream(for videoID: String, urgency: Urgency = .playback) async throws -> Resolved {
        if let hit = await cache.value(for: videoID) { return hit }
        let resolved = try await gate.run(videoID, urgent: urgency == .playback) {
            if let hit = await cache.value(for: videoID) { return hit }
            return try await resolve(videoID)
        }
        await cache.store(resolved, for: videoID)
        return resolved
    }

    /// Une extraction est-elle en cours (pour ne pas en empiler d'autres en arrière-plan) ?
    static var isBusy: Bool {
        get async { await gate.isBusy }
    }

    /// Lien refusé en cours de lecture (expiré, ou lié à l'ancien réseau) : on en redemandera un.
    static func invalidate(_ videoID: String) async {
        await cache.remove(videoID)
    }

    /// Changement de réseau (Wi-Fi ↔ données mobiles) : les liens de YouTube sont liés à l'adresse IP.
    static func invalidateAll() async {
        await cache.removeAll()
    }

    private static func resolve(_ videoID: String) async throws -> Resolved {
        let streams = try await YouTube(videoID: videoID, methods: [.local, .remote]).streams
        let audio = streams.filterAudioOnly()
        let m4aStreams = audio.filter({ $0.fileExtension == .m4a })
        let chosen = PlaybackSettings.preferHighQuality
            ? m4aStreams.highestAudioBitrateStream()
            : m4aStreams.lowestAudioBitrateStream()
        if let m4a = chosen {
            return Resolved(url: m4a.url, isM4A: true)
        }
        if let playable = audio.filter({ $0.isNativelyPlayable }).highestAudioBitrateStream() {
            return Resolved(url: playable.url, isM4A: false)
        }
        throw NovaError.noPlayableStream
    }
}

/// Extractions en cours : une seule par titre, et une seule à la fois pour les non urgentes.
private actor ResolveGate {
    private var tasks: [String: Task<StreamResolver.Resolved, Error>] = [:]
    private var backgroundRunning = false
    private var waiters: [CheckedContinuation<Void, Never>] = []

    var isBusy: Bool { !tasks.isEmpty }

    func run(_ id: String, urgent: Bool,
             work: @escaping @Sendable () async throws -> StreamResolver.Resolved) async throws -> StreamResolver.Resolved {
        if let running = tasks[id] { return try await running.value }
        if !urgent {
            await acquire()
            // Pendant l'attente, le même titre a pu être lancé ailleurs.
            if let running = tasks[id] {
                release()
                return try await running.value
            }
        }
        let task = Task(priority: urgent ? .userInitiated : .utility) { try await work() }
        tasks[id] = task
        defer {
            tasks[id] = nil
            if !urgent { release() }
        }
        return try await task.value
    }

    private func acquire() async {
        guard backgroundRunning else { backgroundRunning = true; return }
        await withCheckedContinuation { waiters.append($0) }
    }

    private func release() {
        if waiters.isEmpty { backgroundRunning = false } else { waiters.removeFirst().resume() }
    }
}

/// URLs de flux valides jusqu'à leur expiration (paramètre « expire » de Google).
private actor ResolvedCache {
    private var entries: [String: (StreamResolver.Resolved, Date)] = [:]

    func value(for id: String) -> StreamResolver.Resolved? {
        guard let (resolved, expiry) = entries[id], expiry > Date().addingTimeInterval(60) else { return nil }
        return resolved
    }

    func remove(_ id: String) {
        entries[id] = nil
    }

    func removeAll() {
        entries.removeAll()
    }

    func store(_ resolved: StreamResolver.Resolved, for id: String) {
        let expire = URLComponents(url: resolved.url, resolvingAgainstBaseURL: false)?
            .queryItems?.first { $0.name == "expire" }?.value.flatMap(TimeInterval.init)
        let expiry = expire.map(Date.init(timeIntervalSince1970:)) ?? Date().addingTimeInterval(3 * 3600)
        entries[id] = (resolved, expiry)
        if entries.count > 300 { entries = entries.filter { $0.value.1 > Date() } }
    }
}
