import Foundation

/// Client minimal de l'API interne de YouTube Music (InnerTube, client WEB_REMIX).
struct InnerTubeClient {
    private static let base = URL(string: "https://music.youtube.com/youtubei/v1/")!
    private static let clientName = "WEB_REMIX"
    private static let clientVersion = "1.20260707.12.00"
    private static let userAgent = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15"
    /// Filtre « Titres » de la recherche.
    private static let songsFilter = "EgWKAQIIAWoMEA4QChADEAQQCRAF"

    // MARK: - Requêtes publiques

    func search(_ query: String) async throws -> [Track] {
        let json = try await post("search", body: ["query": query, "params": Self.songsFilter])
        let items = JSONWalk.collect("musicResponsiveListItemRenderer", in: json)
        return Self.unique(items.compactMap(Self.parseListItem))
    }

    /// Radio YouTube Music à partir d'un titre (titres qui suivent naturellement).
    func radio(for videoID: String) async throws -> [Track] {
        let json = try await post("next", body: [
            "videoId": videoID,
            "playlistId": "RDAMVM\(videoID)",
            "isAudioOnly": true,
            "enablePersistentPlaylistPanel": true,
            "tunerSettingValue": "AUTOMIX_SETTING_NORMAL",
        ])
        let items = JSONWalk.collect("playlistPanelVideoRenderer", in: json)
        return Self.unique(items.compactMap(Self.parsePanelItem))
    }

    // MARK: - Transport

    private func post(_ endpoint: String, body: [String: Any]) async throws -> [String: Any] {
        var components = URLComponents(url: Self.base.appendingPathComponent(endpoint), resolvingAgainstBaseURL: false)!
        components.queryItems = [URLQueryItem(name: "prettyPrint", value: "false")]
        var request = URLRequest(url: components.url!)
        request.httpMethod = "POST"
        request.timeoutInterval = 15
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue(Self.userAgent, forHTTPHeaderField: "User-Agent")
        request.setValue("https://music.youtube.com", forHTTPHeaderField: "Origin")
        request.setValue("https://music.youtube.com/", forHTTPHeaderField: "Referer")
        request.setValue("67", forHTTPHeaderField: "X-YouTube-Client-Name")
        request.setValue(Self.clientVersion, forHTTPHeaderField: "X-YouTube-Client-Version")

        var payload = body
        payload["context"] = [
            "client": [
                "clientName": Self.clientName,
                "clientVersion": Self.clientVersion,
                "hl": "fr",
                "gl": "FR",
            ],
        ]
        request.httpBody = try JSONSerialization.data(withJSONObject: payload)

        let (data, response) = try await URLSession.shared.data(for: request)
        let status = (response as? HTTPURLResponse)?.statusCode ?? 0
        guard status == 200 else { throw NovaError.badResponse(status) }
        return (try JSONSerialization.jsonObject(with: data) as? [String: Any]) ?? [:]
    }

    // MARK: - Analyse des réponses

    private static func parseListItem(_ item: [String: Any]) -> Track? {
        let videoID = ((item["playlistItemData"] as? [String: Any])?["videoId"] as? String)
            ?? (JSONWalk.first("videoId", in: item["overlay"] as Any) as? String)
        guard let videoID else { return nil }

        let columns = (item["flexColumns"] as? [[String: Any]]) ?? []
        func columnText(_ index: Int) -> String {
            guard columns.indices.contains(index) else { return "" }
            let renderer = columns[index]["musicResponsiveListItemFlexColumnRenderer"] as? [String: Any]
            return JSONWalk.runsText(renderer?["text"])
        }

        let title = columnText(0)
        guard !title.isEmpty else { return nil }
        let parts = columnText(1).components(separatedBy: " • ").map { $0.trimmingCharacters(in: .whitespaces) }
        let duration = parts.last.flatMap { TimeInterval(clockString: $0) }
        let artist = parts.first ?? ""
        let album = parts.count >= 3 ? parts[1] : nil

        return Track(id: videoID, title: title, artist: artist, album: album,
                     duration: duration, artworkURL: bestThumbnail(in: item["thumbnail"] as Any))
    }

    private static func parsePanelItem(_ item: [String: Any]) -> Track? {
        guard let videoID = item["videoId"] as? String else { return nil }
        let title = JSONWalk.runsText(item["title"])
        guard !title.isEmpty else { return nil }
        let byline = JSONWalk.runsText(item["longBylineText"]).components(separatedBy: " • ")
        let duration = TimeInterval(clockString: JSONWalk.runsText(item["lengthText"]))
        return Track(id: videoID, title: title, artist: byline.first ?? "",
                     album: byline.count >= 3 ? byline[1] : nil,
                     duration: duration, artworkURL: bestThumbnail(in: item["thumbnail"] as Any))
    }

    /// Plus grande miniature, agrandie à 544 px quand c'est une image Google redimensionnable.
    private static func bestThumbnail(in object: Any) -> URL? {
        guard let thumbs = JSONWalk.first("thumbnails", in: object) as? [[String: Any]],
              let raw = thumbs.last?["url"] as? String else { return nil }
        let upscaled = raw.replacingOccurrences(of: #"=w\d+-h\d+"#, with: "=w544-h544", options: .regularExpression)
        return URL(string: upscaled)
    }

    private static func unique(_ tracks: [Track]) -> [Track] {
        var seen = Set<String>()
        return tracks.filter { seen.insert($0.id).inserted }
    }
}

/// Parcours générique du JSON d'InnerTube, dont la structure change souvent.
enum JSONWalk {
    /// Tous les objets rangés sous `key`, dans l'ordre des tableaux.
    static func collect(_ key: String, in object: Any) -> [[String: Any]] {
        var found: [[String: Any]] = []
        walk(object) { dict in
            if let value = dict[key] as? [String: Any] { found.append(value) }
        }
        return found
    }

    /// Première valeur trouvée sous `key`.
    static func first(_ key: String, in object: Any) -> Any? {
        if let dict = object as? [String: Any] {
            if let value = dict[key] { return value }
            for value in dict.values { if let hit = first(key, in: value) { return hit } }
        } else if let array = object as? [Any] {
            for value in array { if let hit = first(key, in: value) { return hit } }
        }
        return nil
    }

    /// Texte d'un objet `{ runs: [{ text }] }` ou `{ simpleText }`.
    static func runsText(_ object: Any?) -> String {
        guard let dict = object as? [String: Any] else { return "" }
        if let simple = dict["simpleText"] as? String { return simple }
        let runs = (dict["runs"] as? [[String: Any]]) ?? []
        return runs.compactMap { $0["text"] as? String }.joined()
    }

    private static func walk(_ object: Any, _ visit: ([String: Any]) -> Void) {
        if let dict = object as? [String: Any] {
            visit(dict)
            // Clés triées pour un ordre stable entre deux appels.
            for key in dict.keys.sorted() { walk(dict[key]!, visit) }
        } else if let array = object as? [Any] {
            for value in array { walk(value, visit) }
        }
    }
}
