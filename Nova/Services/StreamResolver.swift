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

    static func audioStream(for videoID: String) async throws -> Resolved {
        if let hit = await cache.value(for: videoID) { return hit }
        let resolved = try await resolve(videoID)
        await cache.store(resolved, for: videoID)
        return resolved
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

/// URLs de flux valides jusqu'à leur expiration (paramètre « expire » de Google).
private actor ResolvedCache {
    private var entries: [String: (StreamResolver.Resolved, Date)] = [:]

    func value(for id: String) -> StreamResolver.Resolved? {
        guard let (resolved, expiry) = entries[id], expiry > Date().addingTimeInterval(60) else { return nil }
        return resolved
    }

    func store(_ resolved: StreamResolver.Resolved, for id: String) {
        let expire = URLComponents(url: resolved.url, resolvingAgainstBaseURL: false)?
            .queryItems?.first { $0.name == "expire" }?.value.flatMap(TimeInterval.init)
        let expiry = expire.map(Date.init(timeIntervalSince1970:)) ?? Date().addingTimeInterval(3 * 3600)
        entries[id] = (resolved, expiry)
        if entries.count > 300 { entries = entries.filter { $0.value.1 > Date() } }
    }
}
