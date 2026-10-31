import Foundation

/// Un titre YouTube Music. `id` est l'identifiant vidéo YouTube.
struct Track: Identifiable, Codable, Hashable {
    let id: String
    var title: String
    var artist: String
    var album: String?
    var duration: TimeInterval?
    /// Pochette fournie par YouTube Music (carrée).
    var artworkURL: URL?

    var subtitle: String {
        [artist, album].compactMap { $0 }.filter { !$0.isEmpty }.joined(separator: " · ")
    }

    /// Miniatures 16:9 de la vidéo, de la meilleure à la plus petite, puis la pochette.
    var videoThumbnailURLs: [URL] {
        let names = ["maxresdefault.jpg", "hq720.jpg", "sddefault.jpg"]
        var urls = names.compactMap { URL(string: "https://i.ytimg.com/vi/\(id)/\($0)") }
        if let artworkURL { urls.append(artworkURL) }
        return urls
    }

    /// Pochette d'abord, miniature vidéo ensuite (pour les petites vignettes carrées).
    var squareArtworkURLs: [URL] {
        var urls: [URL] = []
        if let artworkURL { urls.append(artworkURL) }
        if let url = URL(string: "https://i.ytimg.com/vi/\(id)/hqdefault.jpg") { urls.append(url) }
        return urls
    }
}

extension TimeInterval {
    /// 3:45 ou 1:02:03
    var clockString: String {
        guard isFinite, self >= 0 else { return "--:--" }
        let total = Int(self.rounded(.down))
        let h = total / 3600, m = (total % 3600) / 60, s = total % 60
        return h > 0 ? String(format: "%d:%02d:%02d", h, m, s) : String(format: "%d:%02d", m, s)
    }

    /// Lit « 3:45 » ou « 1:02:03 ».
    init?(clockString: String) {
        let parts = clockString.trimmingCharacters(in: .whitespaces).split(separator: ":").map { Int($0) }
        guard !parts.isEmpty, parts.count <= 3, parts.allSatisfy({ $0 != nil }) else { return nil }
        self = TimeInterval(parts.compactMap { $0 }.reduce(0) { $0 * 60 + $1 })
    }
}

enum NovaError: LocalizedError {
    case noPlayableStream
    case badResponse(Int)

    var errorDescription: String? {
        switch self {
        case .noPlayableStream: return "Aucun flux audio lisible pour ce titre."
        case .badResponse(let code): return "YouTube Music a répondu avec l'erreur \(code)."
        }
    }
}
