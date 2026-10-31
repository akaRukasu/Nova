import Foundation
import YouTubeKit

/// Trouve l'URL du fichier audio d'un titre via YouTubeKit.
enum StreamResolver {
    struct Resolved {
        let url: URL
        /// Seuls les m4a sont mis en cache : AVFoundation les lit sans conversion.
        let isM4A: Bool
    }

    static func audioStream(for videoID: String) async throws -> Resolved {
        let streams = try await YouTube(videoID: videoID, methods: [.local, .remote]).streams
        let audio = streams.filterAudioOnly()
        if let m4a = audio.filter({ $0.fileExtension == .m4a }).highestAudioBitrateStream() {
            return Resolved(url: m4a.url, isM4A: true)
        }
        if let playable = audio.filter({ $0.isNativelyPlayable }).highestAudioBitrateStream() {
            return Resolved(url: playable.url, isM4A: false)
        }
        throw NovaError.noPlayableStream
    }
}
