import Foundation

/// Titre venant d'une autre plateforme, à retrouver sur YouTube Music.
struct ImportedTrack: Codable, Hashable {
    var title: String
    var artist: String
    var album: String?
    var duration: TimeInterval?

    var label: String { artist.isEmpty ? title : "\(artist) — \(title)" }
}

/// Playlist (ou liste de titres likés) à importer.
struct ImportedPlaylist: Identifiable, Hashable {
    var id = UUID()
    var name: String
    var source: String
    var tracks: [ImportedTrack] = []
    /// Titres déjà sur YouTube : pas besoin de les chercher.
    var youTubeTracks: [Track]?
    /// Va dans « Titres likés » plutôt que dans une playlist.
    var isLiked = false
    /// Nombre de titres annoncé quand la liste n'est pas encore chargée.
    var expectedCount: Int?

    var count: Int { youTubeTracks?.count ?? (tracks.isEmpty ? (expectedCount ?? 0) : tracks.count) }
}

enum ImportError: LocalizedError {
    case unsupportedLink
    case nothingFound
    case http(Int, String)

    var errorDescription: String? {
        switch self {
        case .unsupportedLink:
            return "Lien non reconnu. Colle le lien d'une playlist ou d'un album Spotify, Deezer, Apple Music ou YouTube."
        case .nothingFound:
            return "Aucun titre trouvé. La playlist est peut-être privée : rends-la publique ou exporte-la en fichier."
        case .http(let code, let service):
            return "\(service) a répondu avec l'erreur \(code)."
        }
    }
}

/// Lecture des playlists des autres plateformes.
enum ImportSources {
    private static let browserAgent = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15"

    // MARK: - Liens

    /// Playlist ou album public à partir de son lien.
    static func fromLink(_ text: String, client: InnerTubeClient = InnerTubeClient()) async throws -> [ImportedPlaylist] {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let start = trimmed.range(of: "http") else { throw ImportError.unsupportedLink }
        let raw = String(trimmed[start.lowerBound...]).components(separatedBy: .whitespacesAndNewlines).first ?? ""
        guard var url = URL(string: raw), let host = url.host?.lowercased() else { throw ImportError.unsupportedLink }

        // Liens courts (link.deezer.com, spotify.link…) : on suit la redirection.
        if host.contains("link.deezer.com") || host.contains("spotify.link") || host.contains("deezer.page.link") {
            url = try await resolveRedirect(url)
        }
        let finalHost = url.host?.lowercased() ?? host

        if finalHost.contains("spotify.com") {
            let parts = url.pathComponents.filter { $0 != "/" && !$0.hasPrefix("intl-") }
            guard let index = parts.firstIndex(where: { ["playlist", "album", "track"].contains($0) }),
                  parts.indices.contains(index + 1) else { throw ImportError.unsupportedLink }
            return [try await spotifyEmbed(kind: parts[index], id: parts[index + 1])]
        }
        if finalHost.contains("deezer.com") {
            let parts = url.pathComponents.filter { $0 != "/" }
            if let index = parts.firstIndex(of: "profile"), parts.indices.contains(index + 1) {
                return try await deezerProfile(userID: parts[index + 1])
            }
            guard let index = parts.firstIndex(where: { ["playlist", "album"].contains($0) }),
                  parts.indices.contains(index + 1) else { throw ImportError.unsupportedLink }
            return [try await deezer(kind: parts[index], id: parts[index + 1])]
        }
        if finalHost.contains("music.apple.com") || finalHost.contains("itunes.apple.com") {
            return [try await appleMusic(url)]
        }
        if finalHost.contains("youtube.com") || finalHost.contains("youtu.be") {
            let list = URLComponents(url: url, resolvingAgainstBaseURL: false)?
                .queryItems?.first { $0.name == "list" }?.value
            let browse = url.pathComponents.last.flatMap { $0.hasPrefix("MPREb") ? $0 : nil }
            guard let id = list.map({ "VL" + $0 }) ?? browse else { throw ImportError.unsupportedLink }
            let kind: CollectionKind = id.hasPrefix("MPREb") ? .album : .playlist
            let content = try await client.collection(id)
            let tracks = try await client.allTracks(of: MusicCollection(id: id, kind: kind, title: content.header.title))
            guard !tracks.isEmpty else { throw ImportError.nothingFound }
            return [ImportedPlaylist(name: content.header.title.isEmpty ? "Playlist YouTube" : content.header.title,
                                     source: "YouTube", youTubeTracks: tracks)]
        }
        throw ImportError.unsupportedLink
    }

    private static func resolveRedirect(_ url: URL) async throws -> URL {
        var request = URLRequest(url: url)
        request.setValue(browserAgent, forHTTPHeaderField: "User-Agent")
        let (data, response) = try await URLSession.shared.data(for: request)
        if let final = response.url, final.host != url.host { return final }
        // Certaines redirections passent par la page elle-même.
        let html = String(decoding: data, as: UTF8.self)
        if let match = html.range(of: #"https://(www\.)?(deezer|open\.spotify)\.com/[^"'\s<>]+"#, options: .regularExpression),
           let found = URL(string: String(html[match])) {
            return found
        }
        return response.url ?? url
    }

    // MARK: - Spotify

    /// Playlist ou album public, lu sur le lecteur intégrable de Spotify.
    static func spotifyEmbed(kind: String, id: String) async throws -> ImportedPlaylist {
        let html = try await fetchText(URL(string: "https://open.spotify.com/embed/\(kind)/\(id)")!, service: "Spotify")
        guard let json = scriptJSON(in: html, id: "__NEXT_DATA__"),
              let entity = JSONWalk.first("entity", in: json) as? [String: Any] else {
            throw ImportError.nothingFound
        }
        let name = (entity["name"] as? String) ?? (entity["title"] as? String) ?? "Playlist Spotify"
        let list = (entity["trackList"] as? [[String: Any]]) ?? []
        var tracks = list.compactMap { item -> ImportedTrack? in
            guard let title = item["title"] as? String, !title.isEmpty else { return nil }
            let artist = (item["subtitle"] as? String)?.replacingOccurrences(of: "\u{00A0}", with: " ") ?? ""
            return ImportedTrack(title: title, artist: artist, duration: (item["duration"] as? Double).map { $0 / 1000 })
        }
        if tracks.isEmpty, kind == "track", let title = entity["title"] as? String ?? entity["name"] as? String {
            let artists = (entity["artists"] as? [[String: Any]])?.compactMap { $0["name"] as? String }.joined(separator: ", ") ?? ""
            tracks = [ImportedTrack(title: title, artist: artists)]
        }
        guard !tracks.isEmpty else { throw ImportError.nothingFound }
        return ImportedPlaylist(name: name, source: "Spotify", tracks: tracks)
    }

    /// Compte Spotify connecté : titres likés et playlists, via l'API web.
    static func spotifyAccount(token: String) async throws -> [ImportedPlaylist] {
        var playlists: [ImportedPlaylist] = []
        let liked = try await spotifyTracks(URL(string: "https://api.spotify.com/v1/me/tracks?limit=50")!, token: token)
        if !liked.isEmpty {
            playlists.append(ImportedPlaylist(name: "Titres likés Spotify", source: "Spotify", tracks: liked, isLiked: true))
        }
        var next: URL? = URL(string: "https://api.spotify.com/v1/me/playlists?limit=50")
        while let url = next {
            let page = try await spotifyGET(url, token: token)
            for item in (page["items"] as? [[String: Any]]) ?? [] {
                guard let id = item["id"] as? String, let name = item["name"] as? String else { continue }
                let total = ((item["tracks"] as? [String: Any]) ?? (item["items"] as? [String: Any]))?["total"] as? Int
                playlists.append(ImportedPlaylist(name: name, source: "Spotify:\(id)", expectedCount: total))
            }
            next = (page["next"] as? String).flatMap(URL.init(string:))
        }
        return playlists
    }

    /// Charge les titres d'une playlist Spotify du compte.
    static func spotifyPlaylistTracks(id: String, token: String) async throws -> [ImportedTrack] {
        do {
            return try await spotifyTracks(URL(string: "https://api.spotify.com/v1/playlists/\(id)/items?limit=100")!, token: token)
        } catch {
            return try await spotifyTracks(URL(string: "https://api.spotify.com/v1/playlists/\(id)/tracks?limit=100")!, token: token)
        }
    }

    private static func spotifyTracks(_ first: URL, token: String) async throws -> [ImportedTrack] {
        var tracks: [ImportedTrack] = []
        var next: URL? = first
        while let url = next {
            let page = try await spotifyGET(url, token: token)
            for item in (page["items"] as? [[String: Any]]) ?? [] {
                let track = (item["track"] as? [String: Any]) ?? (item["item"] as? [String: Any]) ?? item
                guard let title = track["name"] as? String, !title.isEmpty else { continue }
                let artists = ((track["artists"] as? [[String: Any]]) ?? []).compactMap { $0["name"] as? String }
                let album = (track["album"] as? [String: Any])?["name"] as? String
                let duration = (track["duration_ms"] as? Double).map { $0 / 1000 }
                tracks.append(ImportedTrack(title: title, artist: artists.joined(separator: ", "), album: album, duration: duration))
            }
            next = (page["next"] as? String).flatMap(URL.init(string:))
        }
        return tracks
    }

    private static func spotifyGET(_ url: URL, token: String) async throws -> [String: Any] {
        var request = URLRequest(url: url)
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        let (data, response) = try await URLSession.shared.data(for: request)
        let status = (response as? HTTPURLResponse)?.statusCode ?? 0
        guard status == 200 else { throw ImportError.http(status, "Spotify") }
        return (try JSONSerialization.jsonObject(with: data) as? [String: Any]) ?? [:]
    }

    // MARK: - Deezer (API publique)

    static func deezer(kind: String, id: String) async throws -> ImportedPlaylist {
        let info = try await fetchJSON(URL(string: "https://api.deezer.com/\(kind)/\(id)")!, service: "Deezer")
        if let error = info["error"] as? [String: Any] {
            throw ImportError.http((error["code"] as? Int) ?? 0, "Deezer")
        }
        let name = (info["title"] as? String) ?? "Playlist Deezer"
        let albumTitle = kind == "album" ? name : nil
        let tracks = try await deezerTracks(URL(string: "https://api.deezer.com/\(kind)/\(id)/tracks?limit=100")!, album: albumTitle)
        guard !tracks.isEmpty else { throw ImportError.nothingFound }
        return ImportedPlaylist(name: name, source: "Deezer", tracks: tracks)
    }

    /// Profil Deezer public : coups de cœur et playlists.
    static func deezerProfile(userID: String) async throws -> [ImportedPlaylist] {
        var playlists: [ImportedPlaylist] = []
        let favorites = try await deezerTracks(URL(string: "https://api.deezer.com/user/\(userID)/tracks?limit=100")!, album: nil)
        if !favorites.isEmpty {
            playlists.append(ImportedPlaylist(name: "Coups de cœur Deezer", source: "Deezer", tracks: favorites, isLiked: true))
        }
        var next: URL? = URL(string: "https://api.deezer.com/user/\(userID)/playlists?limit=100")
        while let url = next {
            let page = try await fetchJSON(url, service: "Deezer")
            for item in (page["data"] as? [[String: Any]]) ?? [] {
                guard let id = item["id"], let title = item["title"] as? String else { continue }
                if (item["is_loved_track"] as? Bool) == true { continue }
                playlists.append(ImportedPlaylist(name: title, source: "Deezer:\(id)", expectedCount: item["nb_tracks"] as? Int))
            }
            next = (page["next"] as? String).flatMap(URL.init(string:))
        }
        guard !playlists.isEmpty else { throw ImportError.nothingFound }
        return playlists
    }

    static func deezerPlaylistTracks(id: String) async throws -> [ImportedTrack] {
        try await deezerTracks(URL(string: "https://api.deezer.com/playlist/\(id)/tracks?limit=100")!, album: nil)
    }

    private static func deezerTracks(_ first: URL, album: String?) async throws -> [ImportedTrack] {
        var tracks: [ImportedTrack] = []
        var next: URL? = first
        var pages = 0
        while let url = next, pages < 100 {
            let page = try await fetchJSON(url, service: "Deezer")
            for item in (page["data"] as? [[String: Any]]) ?? [] {
                guard let title = (item["title"] as? String) ?? (item["title_short"] as? String) else { continue }
                let artist = (item["artist"] as? [String: Any])?["name"] as? String ?? ""
                let albumName = (item["album"] as? [String: Any])?["title"] as? String ?? album
                tracks.append(ImportedTrack(title: title, artist: artist, album: albumName,
                                            duration: (item["duration"] as? Double)))
            }
            next = (page["next"] as? String).flatMap(URL.init(string:))
            pages += 1
        }
        return tracks
    }

    // MARK: - Apple Music (page publique)

    static func appleMusic(_ url: URL) async throws -> ImportedPlaylist {
        let html = try await fetchText(url, service: "Apple Music")
        var name = metaContent(in: html, property: "og:title") ?? "Playlist Apple Music"
        name = name.replacingOccurrences(of: #"\s+(par|by)\s+.+\s+(sur|on)\s+Apple Music$"#, with: "", options: .regularExpression)
            .replacingOccurrences(of: #"\s+(sur|on)\s+Apple Music$"#, with: "", options: .regularExpression)
        var tracks: [ImportedTrack] = []

        if let data = scriptJSON(in: html, id: "serialized-server-data") {
            var seen = Set<String>()
            walkDicts(data) { dict in
                guard let title = dict["title"] as? String,
                      let artist = dict["artistName"] as? String,
                      dict["duration"] != nil || dict["trackNumber"] != nil || dict["contentDescriptor"] != nil
                else { return }
                let key = "\(title)|\(artist)"
                guard seen.insert(key).inserted else { return }
                let duration = (dict["duration"] as? Double).map { $0 > 10_000 ? $0 / 1000 : $0 }
                tracks.append(ImportedTrack(title: title, artist: artist, album: dict["albumName"] as? String, duration: duration))
            }
        }
        if tracks.isEmpty {
            // Repli : données structurées schema.org.
            for json in ldJSON(in: html) {
                walkDicts(json) { dict in
                    guard (dict["@type"] as? String) == "MusicRecording", let title = dict["name"] as? String else { return }
                    let artist = ((dict["byArtist"] as? [[String: Any]])?.first?["name"] as? String)
                        ?? ((dict["byArtist"] as? [String: Any])?["name"] as? String) ?? ""
                    tracks.append(ImportedTrack(title: title, artist: artist))
                }
            }
        }
        guard !tracks.isEmpty else { throw ImportError.nothingFound }
        return ImportedPlaylist(name: name, source: "Apple Music", tracks: tracks)
    }

    // MARK: - Fichiers

    /// CSV (Exportify, TuneMyMusic, Soundiiz…), TXT (« Artiste - Titre ») ou JSON (export de données Spotify).
    static func fromFile(_ data: Data, fileName: String) throws -> [ImportedPlaylist] {
        let baseName = (fileName as NSString).deletingPathExtension
        let ext = (fileName as NSString).pathExtension.lowercased()
        if ext == "json" || data.first == UInt8(ascii: "{") || data.first == UInt8(ascii: "[") {
            if let json = try? JSONSerialization.jsonObject(with: data) {
                let playlists = fromJSON(json, fallbackName: baseName)
                if !playlists.isEmpty { return playlists }
            }
        }
        let text = String(data: data, encoding: .utf8) ?? String(decoding: data, as: UTF8.self)
        let playlists = ext == "txt" ? fromLines(text, name: baseName) : fromCSV(text, fallbackName: baseName)
        let result = playlists.isEmpty ? fromLines(text, name: baseName) : playlists
        guard !result.isEmpty else { throw ImportError.nothingFound }
        return result
    }

    private static func fromJSON(_ json: Any, fallbackName: String) -> [ImportedPlaylist] {
        // Export de données Spotify : Playlist1.json
        if let root = json as? [String: Any], let lists = root["playlists"] as? [[String: Any]] {
            let playlists = lists.compactMap { list -> ImportedPlaylist? in
                let name = (list["name"] as? String) ?? fallbackName
                let items = (list["items"] as? [[String: Any]]) ?? []
                let tracks = items.compactMap { item -> ImportedTrack? in
                    let track = (item["track"] as? [String: Any]) ?? item
                    return importedTrack(from: track)
                }
                return tracks.isEmpty ? nil : ImportedPlaylist(name: name, source: "Fichier", tracks: tracks)
            }
            if !playlists.isEmpty { return playlists }
        }
        // Export de données Spotify : YourLibrary.json
        if let root = json as? [String: Any], let items = root["tracks"] as? [[String: Any]] {
            let tracks = items.compactMap(importedTrack(from:))
            if !tracks.isEmpty {
                return [ImportedPlaylist(name: "Titres likés (\(fallbackName))", source: "Fichier", tracks: tracks, isLiked: true)]
            }
        }
        var tracks: [ImportedTrack] = []
        walkDicts(json) { dict in
            if let track = importedTrack(from: dict) { tracks.append(track) }
        }
        return tracks.isEmpty ? [] : [ImportedPlaylist(name: fallbackName, source: "Fichier", tracks: tracks)]
    }

    private static func importedTrack(from dict: [String: Any]) -> ImportedTrack? {
        let titleKeys = ["trackName", "track", "title", "name", "songName", "song"]
        let artistKeys = ["artistName", "artist", "artists", "artist_name", "author", "creator"]
        guard let title = titleKeys.lazy.compactMap({ dict[$0] as? String }).first, !title.isEmpty else { return nil }
        var artist = artistKeys.lazy.compactMap({ dict[$0] as? String }).first
        if artist == nil, let list = dict["artists"] as? [[String: Any]] {
            artist = list.compactMap { $0["name"] as? String }.joined(separator: ", ")
        }
        guard let artist, !artist.isEmpty else { return nil }
        let album = (dict["albumName"] as? String) ?? (dict["album"] as? String)
        return ImportedTrack(title: title, artist: artist, album: album)
    }

    private static func fromLines(_ text: String, name: String) -> [ImportedPlaylist] {
        let separators = [" - ", " – ", " — ", "\t"]
        let tracks = text.components(separatedBy: .newlines).compactMap { line -> ImportedTrack? in
            let value = line.trimmingCharacters(in: .whitespaces)
            guard !value.isEmpty, !value.hasPrefix("#") else { return nil }
            for separator in separators {
                let parts = value.components(separatedBy: separator)
                if parts.count >= 2 {
                    return ImportedTrack(title: parts.dropFirst().joined(separator: separator).trimmingCharacters(in: .whitespaces),
                                         artist: parts[0].trimmingCharacters(in: .whitespaces))
                }
            }
            return ImportedTrack(title: value, artist: "")
        }
        return tracks.isEmpty ? [] : [ImportedPlaylist(name: name, source: "Fichier", tracks: tracks)]
    }

    private static func fromCSV(_ text: String, fallbackName: String) -> [ImportedPlaylist] {
        let firstLine = text.prefix { $0 != "\n" }
        let delimiter: Character = [";", "\t", ","].max { a, b in
            firstLine.filter { $0 == a }.count < firstLine.filter { $0 == b }.count
        } ?? ","
        let rows = parseCSV(text, delimiter: delimiter)
        guard rows.count >= 2 else { return [] }
        let header = rows[0].map { normalizeHeader($0) }

        func column(_ names: [String]) -> Int? {
            for name in names { if let index = header.firstIndex(of: name) { return index } }
            for name in names { if let index = header.firstIndex(where: { $0.contains(name) }) { return index } }
            return nil
        }
        guard let titleColumn = column(["trackname", "track", "title", "titre", "song", "songname", "name", "nomdutitre", "morceau"]),
              let artistColumn = column(["artistnames", "artistname", "artist", "artists", "artiste", "artistes", "interprete"]) else {
            return []
        }
        let albumColumn = column(["albumname", "album"])
        let playlistColumn = column(["playlistname", "playlist"])
        let durationColumn = column(["durationms", "duration", "duree"])

        var order: [String] = []
        var grouped: [String: [ImportedTrack]] = [:]
        for row in rows.dropFirst() {
            guard row.indices.contains(titleColumn) else { continue }
            let title = row[titleColumn].trimmingCharacters(in: .whitespaces)
            guard !title.isEmpty else { continue }
            let artist = row.indices.contains(artistColumn) ? row[artistColumn].trimmingCharacters(in: .whitespaces) : ""
            let album = albumColumn.flatMap { row.indices.contains($0) ? row[$0] : nil }
            var duration: TimeInterval?
            if let durationColumn, row.indices.contains(durationColumn) {
                let value = row[durationColumn]
                duration = Double(value).map { $0 > 10_000 ? $0 / 1000 : $0 } ?? TimeInterval(clockString: value)
            }
            let playlist = playlistColumn.flatMap { row.indices.contains($0) ? row[$0] : nil }.flatMap { $0.isEmpty ? nil : $0 } ?? fallbackName
            if grouped[playlist] == nil { order.append(playlist) }
            grouped[playlist, default: []].append(ImportedTrack(title: title, artist: artist.replacingOccurrences(of: ";", with: ", "),
                                                                album: album, duration: duration))
        }
        return order.map { ImportedPlaylist(name: $0, source: "Fichier", tracks: grouped[$0] ?? []) }
    }

    private static func normalizeHeader(_ value: String) -> String {
        value.folding(options: [.diacriticInsensitive, .caseInsensitive], locale: nil)
            .lowercased()
            .filter { $0.isLetter }
    }

    static func parseCSV(_ text: String, delimiter: Character) -> [[String]] {
        var rows: [[String]] = []
        var row: [String] = []
        var field = ""
        var inQuotes = false
        var iterator = text.makeIterator()
        var pending: Character? = nil
        while let char = pending ?? iterator.next() {
            pending = nil
            if inQuotes {
                if char == "\"" {
                    if let next = iterator.next() {
                        if next == "\"" { field.append("\"") } else { inQuotes = false; pending = next }
                    } else {
                        inQuotes = false
                    }
                } else {
                    field.append(char)
                }
            } else if char == "\"" {
                inQuotes = true
            } else if char == delimiter {
                row.append(field)
                field = ""
            } else if char == "\n" || char == "\r\n" || char == "\r" {
                row.append(field)
                field = ""
                if !(row.count == 1 && row[0].isEmpty) { rows.append(row) }
                row = []
            } else if char != "\u{FEFF}" {
                field.append(char)
            }
        }
        if !field.isEmpty || !row.isEmpty {
            row.append(field)
            rows.append(row)
        }
        return rows
    }

    // MARK: - Outils

    private static func fetchText(_ url: URL, service: String) async throws -> String {
        var request = URLRequest(url: url)
        request.setValue(browserAgent, forHTTPHeaderField: "User-Agent")
        request.setValue("fr-FR,fr;q=0.9,en;q=0.8", forHTTPHeaderField: "Accept-Language")
        let (data, response) = try await URLSession.shared.data(for: request)
        let status = (response as? HTTPURLResponse)?.statusCode ?? 0
        guard status == 200 else { throw ImportError.http(status, service) }
        return String(decoding: data, as: UTF8.self)
    }

    private static func fetchJSON(_ url: URL, service: String) async throws -> [String: Any] {
        var request = URLRequest(url: url)
        request.setValue(browserAgent, forHTTPHeaderField: "User-Agent")
        let (data, response) = try await URLSession.shared.data(for: request)
        let status = (response as? HTTPURLResponse)?.statusCode ?? 0
        guard status == 200 else { throw ImportError.http(status, service) }
        return (try JSONSerialization.jsonObject(with: data) as? [String: Any]) ?? [:]
    }

    /// JSON d'une balise `<script id="…">`.
    static func scriptJSON(in html: String, id: String) -> Any? {
        guard let marker = html.range(of: "id=\"\(id)\""),
              let open = html[marker.upperBound...].range(of: ">"),
              let close = html[open.upperBound...].range(of: "</script>") else { return nil }
        let body = html[open.upperBound..<close.lowerBound]
        return try? JSONSerialization.jsonObject(with: Data(body.utf8))
    }

    private static func ldJSON(in html: String) -> [Any] {
        var results: [Any] = []
        var searchRange = html.startIndex..<html.endIndex
        while let marker = html.range(of: "application/ld+json", range: searchRange),
              let open = html[marker.upperBound...].range(of: ">"),
              let close = html[open.upperBound...].range(of: "</script>") {
            if let json = try? JSONSerialization.jsonObject(with: Data(html[open.upperBound..<close.lowerBound].utf8)) {
                results.append(json)
            }
            searchRange = close.upperBound..<html.endIndex
        }
        return results
    }

    private static func metaContent(in html: String, property: String) -> String? {
        guard let marker = html.range(of: "property=\"\(property)\""),
              let content = html[marker.upperBound...].range(of: "content=\""),
              let end = html[content.upperBound...].range(of: "\"") else { return nil }
        let value = String(html[content.upperBound..<end.lowerBound])
        return value.replacingOccurrences(of: "&amp;", with: "&")
            .replacingOccurrences(of: "&#39;", with: "'")
            .replacingOccurrences(of: "&quot;", with: "\"")
    }

    static func walkDicts(_ object: Any, _ visit: ([String: Any]) -> Void) {
        if let dict = object as? [String: Any] {
            visit(dict)
            for key in dict.keys.sorted() { walkDicts(dict[key]!, visit) }
        } else if let array = object as? [Any] {
            for value in array { walkDicts(value, visit) }
        }
    }
}

/// Retrouve sur YouTube Music les titres venant d'ailleurs.
enum TrackMatcher {
    static func match(_ track: ImportedTrack, client: InnerTubeClient) async -> Track? {
        let query = [track.title, track.artist].filter { !$0.isEmpty }.joined(separator: " ")
        guard let shelves = try? await client.search(query, scope: .songs) else { return nil }
        let candidates = shelves.flatMap(\.tracks)
        guard !candidates.isEmpty else { return nil }

        let wantedTitle = normalize(stripExtras(track.title))
        let wantedArtists = Set(normalize(track.artist).split(separator: " ").map(String.init))

        var best: (Track, Double)?
        for (rank, candidate) in candidates.prefix(8).enumerated() {
            let title = normalize(stripExtras(candidate.title))
            var score = 0.0
            if title == wantedTitle { score += 3 }
            else if title.contains(wantedTitle) || wantedTitle.contains(title) { score += 2 }
            else {
                let a = Set(title.split(separator: " ")), b = Set(wantedTitle.split(separator: " "))
                let overlap = Double(a.intersection(b).count) / Double(max(b.count, 1))
                score += overlap * 1.5
            }
            let artists = Set(normalize(candidate.artist).split(separator: " ").map(String.init))
            if !wantedArtists.isEmpty {
                let overlap = Double(artists.intersection(wantedArtists).count) / Double(wantedArtists.count)
                score += overlap * 2
            }
            if let a = track.duration, let b = candidate.duration {
                let gap = abs(a - b)
                score += gap < 4 ? 1 : (gap < 15 ? 0.4 : -0.5)
            }
            score -= Double(rank) * 0.1
            if best == nil || score > best!.1 { best = (candidate, score) }
        }
        guard let best, best.1 >= 1.5 else { return nil }
        return best.0
    }

    private static func stripExtras(_ value: String) -> String {
        var text = value
        for pattern in [#"\s*[\(\[][^\)\]]*(feat|ft\.|with|avec|remaster|version|edit|mix|live|radio)[^\)\]]*[\)\]]"#,
                        #"\s+-\s+.*(remaster|version|edit|mix|live|radio).*$"#] {
            text = text.replacingOccurrences(of: pattern, with: "", options: [.regularExpression, .caseInsensitive])
        }
        return text
    }

    static func normalize(_ value: String) -> String {
        value.folding(options: [.diacriticInsensitive, .caseInsensitive, .widthInsensitive], locale: nil)
            .lowercased()
            .replacingOccurrences(of: "&", with: " ")
            .components(separatedBy: CharacterSet.alphanumerics.inverted)
            .filter { !$0.isEmpty && !["feat", "ft", "the", "et", "and", "with", "avec"].contains($0) }
            .joined(separator: " ")
    }
}
