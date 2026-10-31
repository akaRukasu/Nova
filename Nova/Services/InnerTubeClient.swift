import CryptoKit
import Foundation

enum SearchScope: String, CaseIterable, Hashable {
    case all = "Tout"
    case songs = "Titres"
    case videos = "Vidéos"
    case albums = "Albums"
    case artists = "Artistes"
    case playlists = "Playlists"

    /// Filtres de recherche d'InnerTube.
    var params: [String] {
        switch self {
        case .all: return []
        case .songs: return ["EgWKAQIIAWoMEA4QChADEAQQCRAF"]
        case .videos: return ["EgWKAQIQAWoMEA4QChADEAQQCRAF"]
        case .albums: return ["EgWKAQIYAWoMEA4QChADEAQQCRAF"]
        case .artists: return ["EgWKAQIgAWoMEA4QChADEAQQCRAF"]
        // Playlists YouTube Music, puis playlists de la communauté.
        case .playlists: return ["EgeKAQQoADgBagwQDhAKEAMQBBAJEAU=", "EgeKAQQoAEABagwQDhAKEAMQBBAJEAU="]
        }
    }
}

/// Client de l'API interne de YouTube Music (InnerTube, client WEB_REMIX).
/// Quand un compte est connecté, les requêtes portent ses cookies.
struct InnerTubeClient {
    private static let base = URL(string: "https://music.youtube.com/youtubei/v1/")!
    private static let origin = "https://music.youtube.com"
    private static let clientName = "WEB_REMIX"
    private static let clientVersion = "1.20260707.12.00"
    static let userAgent = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15"

    typealias Parser = InnerTubeParser

    // MARK: - Recherche

    func search(_ query: String, scope: SearchScope) async throws -> [Shelf] {
        if scope == .all {
            let json = try await post("search", body: ["query": query])
            return Parser.shelves(in: json)
        }
        var shelves: [Shelf] = []
        for params in scope.params {
            let json = try await post("search", body: ["query": query, "params": params])
            shelves += Parser.shelves(in: json)
        }
        let items = Parser.unique(shelves.flatMap(\.items))
        return [Shelf(id: "results", title: "", items: items, layout: .list)]
    }

    func suggestions(_ input: String) async throws -> [String] {
        let json = try await post("music/get_search_suggestions", body: ["input": input])
        let renderers = JSONWalk.collect("searchSuggestionRenderer", in: json)
        var seen = Set<String>()
        return renderers.compactMap { renderer -> String? in
            let query = (JSONWalk.first("searchEndpoint", in: renderer) as? JSONObject)?["query"] as? String
            let value = query ?? Parser.text(renderer["suggestion"])
            return value.isEmpty ? nil : value
        }.filter { seen.insert($0).inserted }
    }

    // MARK: - Pages

    func home() async throws -> BrowsePage {
        try await browse(BrowseLink(browseID: "FEmusic_home"))
    }

    func browse(_ link: BrowseLink) async throws -> BrowsePage {
        var body: [String: Any] = ["browseId": link.browseID]
        if let params = link.params { body["params"] = params }
        let json = try await post("browse", body: body)
        return BrowsePage(header: Parser.header(in: json),
                          shelves: Parser.shelves(in: json),
                          continuation: Parser.sectionContinuation(in: json))
    }

    /// Suite d'une page à sections (accueil).
    func browseContinuation(_ token: String) async throws -> BrowsePage {
        let json = try await continuation(token)
        return BrowsePage(shelves: Parser.shelves(in: json), continuation: Parser.sectionContinuation(in: json))
    }

    /// Album ou playlist : en-tête, premiers titres et suggestions.
    func collection(_ id: String) async throws -> CollectionContent {
        let page = try await browse(BrowseLink(browseID: id))
        let main = page.shelves.first { $0.layout == .list && !$0.tracks.isEmpty }
        guard main != nil || !page.header.title.isEmpty else { throw NovaError.emptyPage }
        let tracks = Self.fill(main?.tracks ?? [], header: page.header, collectionID: id)
        let related = page.shelves.filter { $0.id != main?.id }
        return CollectionContent(header: page.header, tracks: tracks, continuation: main?.continuation, related: related)
    }

    /// Titres suivants d'une playlist longue.
    func moreTracks(_ token: String, header: PageHeader, collectionID: String) async throws -> (tracks: [Track], next: String?) {
        let json = try await continuation(token)
        let tracks = JSONWalk.collect("musicResponsiveListItemRenderer", in: json)
            .compactMap(Parser.responsiveItem)
            .compactMap(\.track)
        return (Self.fill(tracks, header: header, collectionID: collectionID), Parser.continuationToken(in: json))
    }

    /// Tous les titres d'une collection (pour Lecture, Aléatoire, Télécharger…).
    func allTracks(of collection: MusicCollection) async throws -> [Track] {
        if collection.kind == .artist {
            let page = try await browse(BrowseLink(browseID: collection.id))
            let songs = page.shelves.first { $0.layout == .list && !$0.tracks.isEmpty }
            if let more = songs?.more, more.browseID.hasPrefix("VL") {
                let all = try? await allTracks(of: MusicCollection(id: more.browseID, kind: .playlist, title: collection.title))
                if let all, !all.isEmpty { return all }
            }
            return songs?.tracks ?? []
        }
        let content = try await self.collection(collection.id)
        var tracks = content.tracks
        var token = content.continuation
        var pages = 0
        while let current = token, pages < 40 {
            let more = try await moreTracks(current, header: content.header, collectionID: collection.id)
            tracks += more.tracks
            token = more.next
            pages += 1
        }
        return tracks
    }

    /// Complète les titres d'un album avec l'artiste et la pochette de l'en-tête.
    static func fill(_ tracks: [Track], header: PageHeader, collectionID: String) -> [Track] {
        let isAlbum = collectionID.hasPrefix("MPREb")
        return tracks.map { track in
            var track = track
            if track.artist.isEmpty, let artist = header.artist { track.artist = artist }
            if track.artistID == nil, isAlbum { track.artistID = header.artistID }
            if track.artworkURL == nil { track.artworkURL = header.artworkURL }
            if isAlbum {
                track.album = track.album ?? header.title
                track.albumID = track.albumID ?? collectionID
            }
            return track
        }
    }

    // MARK: - Lecture

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
        var seen = Set<String>()
        return items.compactMap(Self.parsePanelItem).filter { seen.insert($0.id).inserted }
    }

    func lyrics(for videoID: String) async throws -> Lyrics? {
        let next = try await post("next", body: ["videoId": videoID, "isAudioOnly": true])
        let browseID = JSONWalk.collect("tabRenderer", in: next).lazy.compactMap { tab in
            ((tab["endpoint"] as? JSONObject)?["browseEndpoint"] as? JSONObject)?["browseId"] as? String
        }.first { $0.hasPrefix("MPLYt") }
        guard let browseID else { return nil }
        let page = try await post("browse", body: ["browseId": browseID])
        guard let shelf = JSONWalk.first("musicDescriptionShelfRenderer", in: page) as? JSONObject else { return nil }
        let text = Parser.text(shelf["description"])
        guard !text.isEmpty else { return nil }
        let source = Parser.text(shelf["footer"])
        return Lyrics(text: text, source: source.isEmpty ? nil : source)
    }

    private static func parsePanelItem(_ item: JSONObject) -> Track? {
        guard let videoID = item["videoId"] as? String else { return nil }
        let title = Parser.text(item["title"])
        guard !title.isEmpty else { return nil }
        let info = Parser.meta(Parser.runs(item["longBylineText"]))
        let duration = TimeInterval(clockString: Parser.text(item["lengthText"]))
        return Track(id: videoID, title: title, artist: info.artist ?? "", album: info.album,
                     duration: duration, artworkURL: Parser.thumbnail(item["thumbnail"]),
                     artistID: info.artistID, albumID: info.albumID)
    }

    // MARK: - Compte

    /// Nom et photo du compte connecté.
    func accountInfo() async throws -> (name: String, photo: URL?) {
        let json = try await post("account/account_menu", body: [:])
        guard let header = JSONWalk.first("activeAccountHeaderRenderer", in: json) as? JSONObject else {
            throw NovaError.emptyPage
        }
        return (Parser.text(header["accountName"]), Parser.thumbnail(header["accountPhoto"], upscale: false))
    }

    /// « J'aime » synchronisé avec le compte YouTube.
    func setLiked(_ liked: Bool, videoID: String) async throws {
        _ = try await post(liked ? "like/like" : "like/removelike", body: ["target": ["videoId": videoID]])
    }

    /// Ajoute un titre à une playlist du compte YouTube.
    func addToAccountPlaylist(_ playlistID: String, videoID: String) async throws {
        let id = playlistID.hasPrefix("VL") ? String(playlistID.dropFirst(2)) : playlistID
        _ = try await post("browse/edit_playlist", body: [
            "playlistId": id,
            "actions": [["action": "ACTION_ADD_VIDEO", "addedVideoId": videoID, "dedupeOption": "DEDUPE_OPTION_SKIP"]],
        ])
    }

    // MARK: - Transport

    private func continuation(_ token: String) async throws -> JSONObject {
        try await post("browse", body: ["continuation": token], query: [
            URLQueryItem(name: "ctoken", value: token),
            URLQueryItem(name: "continuation", value: token),
            URLQueryItem(name: "type", value: "next"),
        ])
    }

    private func post(_ endpoint: String, body: [String: Any], query: [URLQueryItem] = []) async throws -> JSONObject {
        var components = URLComponents(url: Self.base.appendingPathComponent(endpoint), resolvingAgainstBaseURL: false)!
        components.queryItems = [URLQueryItem(name: "prettyPrint", value: "false")] + query
        var request = URLRequest(url: components.url!)
        request.httpMethod = "POST"
        request.timeoutInterval = 20
        request.httpShouldHandleCookies = false
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue(Self.userAgent, forHTTPHeaderField: "User-Agent")
        request.setValue(Self.origin, forHTTPHeaderField: "Origin")
        request.setValue(Self.origin + "/", forHTTPHeaderField: "Referer")
        request.setValue("67", forHTTPHeaderField: "X-YouTube-Client-Name")
        request.setValue(Self.clientVersion, forHTTPHeaderField: "X-YouTube-Client-Version")

        if let cookies = AuthSession.shared.cookieHeader {
            request.setValue(cookies, forHTTPHeaderField: "Cookie")
            request.setValue("0", forHTTPHeaderField: "X-Goog-AuthUser")
            request.setValue(Self.origin, forHTTPHeaderField: "X-Origin")
            if let sapisid = AuthSession.shared.sapisid {
                request.setValue(Self.sapisidHash(sapisid), forHTTPHeaderField: "Authorization")
            }
        }

        var payload = body
        payload["context"] = [
            "client": [
                "clientName": Self.clientName,
                "clientVersion": Self.clientVersion,
                "hl": "fr",
                "gl": "FR",
            ],
            "user": ["lockedSafetyMode": false],
        ]
        request.httpBody = try JSONSerialization.data(withJSONObject: payload)

        let (data, response) = try await URLSession.shared.data(for: request)
        let status = (response as? HTTPURLResponse)?.statusCode ?? 0
        guard status == 200 else { throw NovaError.badResponse(status) }
        return (try JSONSerialization.jsonObject(with: data) as? JSONObject) ?? [:]
    }

    /// En-tête d'autorisation utilisé par le site YouTube Music.
    private static func sapisidHash(_ sapisid: String) -> String {
        let timestamp = Int(Date().timeIntervalSince1970)
        let digest = Insecure.SHA1.hash(data: Data("\(timestamp) \(sapisid) \(origin)".utf8))
        let hex = digest.map { String(format: "%02x", $0) }.joined()
        return "SAPISIDHASH \(timestamp)_\(hex)"
    }
}
