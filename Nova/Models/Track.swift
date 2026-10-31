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
    /// Identifiant de la page artiste (UC…), si YouTube Music le fournit.
    var artistID: String?
    /// Identifiant de la page album (MPREb…), si YouTube Music le fournit.
    var albumID: String?

    var subtitle: String {
        [artist, album ?? ""].filter { !$0.isEmpty }.joined(separator: " · ")
    }

    var shareURL: URL {
        URL(string: "https://music.youtube.com/watch?v=\(id)")!
    }

    /// Miniatures 16:9 de la vidéo, de la meilleure à la plus petite, puis la pochette.
    var videoThumbnailURLs: [URL] {
        let names = ["maxresdefault.jpg", "hq720.jpg", "sddefault.jpg"]
        var urls = names.compactMap { URL(string: "https://i.ytimg.com/vi/\(id)/\($0)") }
        if let artworkURL { urls.append(artworkURL) }
        return urls
    }

    /// Pochette d'abord, miniature vidéo ensuite (pour les vignettes carrées).
    var squareArtworkURLs: [URL] {
        var urls: [URL] = []
        if let artworkURL { urls.append(artworkURL) }
        if let url = URL(string: "https://i.ytimg.com/vi/\(id)/hqdefault.jpg") { urls.append(url) }
        return urls
    }

    var artistCollection: MusicCollection? {
        artistID.map { MusicCollection(id: $0, kind: .artist, title: artist) }
    }

    var albumCollection: MusicCollection? {
        albumID.map { MusicCollection(id: $0, kind: .album, title: album ?? title, subtitle: artist, artworkURL: artworkURL) }
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

    /// « 1 h 12 min » ou « 45 min ».
    var longDurationString: String {
        let minutes = Int((self / 60).rounded())
        if minutes >= 60 { return "\(minutes / 60) h \(String(format: "%02d", minutes % 60)) min" }
        return "\(max(minutes, 1)) min"
    }
}

enum NovaError: LocalizedError {
    case noPlayableStream
    case badResponse(Int)
    case emptyPage

    var errorDescription: String? {
        switch self {
        case .noPlayableStream: return "Aucun flux audio lisible pour ce titre."
        case .badResponse(let code): return "YouTube Music a répondu avec l'erreur \(code)."
        case .emptyPage: return "Cette page est vide ou indisponible."
        }
    }
}
