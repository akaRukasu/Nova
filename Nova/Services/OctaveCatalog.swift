import Foundation

enum PlaybackSource: String, CaseIterable, Identifiable, Codable {
    case octave, youtube
    var id: String { rawValue }
    var label: String { self == .octave ? "Octave" : "YouTube Music" }
}

actor OctaveCatalog {
    static let shared = OctaveCatalog()
    static let origin = URL(string: "https://music.octavestreaming.com")!
    private var recordings: [String: Track] = [:]

    struct Entry: Decodable {
        struct ID: Decodable {
            let value: String
            init(from decoder: Decoder) throws {
                let container = try decoder.singleValueContainer()
                if let number = try? container.decode(UInt64.self) { value = String(number) }
                else { value = try container.decode(String.self) }
            }
        }
        struct Detail: Decodable {
            var id: ID?
            var title: String?
            var name: String?
            var cover_big: URL?
            var cover_medium: URL?
            var picture_big: URL?
            var picture_medium: URL?
        }
        var id: ID?
        var title: String?
        var name: String?
        var artist: Detail?
        var album: Detail?
        var duration: Double?
        var cover_big: URL?
        var cover_medium: URL?
        var picture_big: URL?
        var picture_medium: URL?
        var tracks: [Entry]?
        var artwork: URL? { cover_big ?? cover_medium ?? picture_big ?? picture_medium }

        func track(album release: Entry? = nil) -> Track? {
            guard let id, let title, let key = OctaveCatalog.key(id.value) else { return nil }
            let performer = artist ?? release?.artist
            return Track(id: key, title: title, artist: performer?.name ?? "", album: release?.title ?? album?.title,
                         duration: duration, artworkURL: release?.artwork ?? album?.cover_big ?? album?.cover_medium,
                         artistID: performer?.id.flatMap { OctaveCatalog.key($0.value) },
                         albumID: (release?.id ?? album?.id).flatMap { OctaveCatalog.key($0.value) })
        }
        func collection(_ kind: CollectionKind) -> MusicCollection? {
            guard let id, let key = OctaveCatalog.key(id.value), let title = kind == .artist ? name : title else { return nil }
            return MusicCollection(id: key, kind: kind, title: title, subtitle: artist?.name ?? "", artworkURL: artwork)
        }
    }

    struct Catalog: Decodable {
        struct Top: Decodable {
            let tracks: [Entry]?
            init(from decoder: Decoder) throws {
                // Recherche et suggestions renvoient une fiche "top", la page artiste une liste.
                tracks = try? decoder.singleValueContainer().decode([Entry].self)
            }
        }
        var tracks: [Entry]?
        var albums: [Entry]?
        var artists: [Entry]?
        var playlists: [Entry]?
        var album: Entry?
        var playlist: Entry?
        var artist: Entry?
        var top: Top?
        var related: [Entry]?
        var bio: String?
        var queries: [String]?
    }

    nonisolated static func key(_ id: String) -> String? {
        guard id.range(of: #"^[0-9]{1,20}$"#, options: .regularExpression) != nil else { return nil }
        return "octave:" + id
    }
    nonisolated static func id(_ key: String) -> String? {
        guard key.hasPrefix("octave:") else { return nil }
        let value = String(key.dropFirst(7))
        return self.key(value) == key ? value : nil
    }
    nonisolated static func trackURL(_ track: Track) -> URL? {
        guard let album = track.albumID.flatMap(id), let trackID = id(track.id) else { return nil }
        var url = URLComponents(url: origin.appending(path: "album/" + album), resolvingAgainstBaseURL: false)!
        url.queryItems = [URLQueryItem(name: "t", value: trackID)]
        return url.url
    }
    nonisolated static func searchURL(_ track: Track) -> URL {
        origin.appending(path: "search").appending(queryItems: [URLQueryItem(name: "q", value: track.title + " " + track.artist)])
    }

    private func request(_ path: String, query: [URLQueryItem] = []) async throws -> Catalog {
        let base = URL(string: "https://api.octavestreaming.com/api")!
        let url = base.appending(path: path).appending(queryItems: query)
        var request = URLRequest(url: url)
        request.timeoutInterval = 12
        let (data, response) = try await URLSession.shared.data(for: request)
        guard let http = response as? HTTPURLResponse, (200..<300).contains(http.statusCode) else {
            throw URLError(.badServerResponse)
        }
        do {
            return try JSONDecoder().decode(Catalog.self, from: data)
        } catch is DecodingError {
            throw OctaveWebPlayerCatalogError.invalidResponse
        }
    }

    private func shelves(_ result: Catalog, scope: SearchScope, charts: Bool = false) -> [Shelf] {
        var resultShelves: [Shelf] = []
        if scope == .all || scope == .songs {
            resultShelves.append(Shelf(id: "octave-tracks", title: charts ? "Titres populaires sur Octave" : "Titres",
                                       items: (result.tracks ?? []).compactMap { $0.track().map(MusicItem.track) },
                                       layout: charts ? .grid : .list))
        }
        let groups: [(CollectionKind, SearchScope, String, [Entry]?)] = [
            (.album, .albums, "Albums", result.albums), (.artist, .artists, "Artistes", result.artists),
            (.playlist, .playlists, "Playlists", result.playlists),
        ]
        for (kind, filter, title, entries) in groups where scope == .all || scope == filter {
            resultShelves.append(Shelf(id: "octave-" + kind.rawValue, title: title, items: (entries ?? []).compactMap {
                $0.collection(kind).map(MusicItem.collection)
            }, layout: .cards))
        }
        return resultShelves.filter { !$0.items.isEmpty }
    }

    func search(_ query: String, scope: SearchScope) async throws -> [Shelf] {
        var result = try await request("search/page", query: [.init(name: "query", value: query), .init(name: "limit", value: "30")])
        if let artists = result.artists, scope == .artists || scope == .all {
            let wanted = ArtistNames.key(query)
            let matches = artists.filter { ArtistNames.key($0.name ?? "") == wanted }
            result.artists = matches + artists.filter { ArtistNames.key($0.name ?? "") != wanted }
        }
        return shelves(result, scope: scope)
    }
    func suggestions(_ query: String) async throws -> [String] {
        try await request("suggest", query: [.init(name: "query", value: query), .init(name: "limit", value: "6")]).queries ?? []
    }
    func charts() async throws -> BrowsePage {
        let result = try await request("charts")
        return BrowsePage(shelves: shelves(result, scope: .all, charts: true))
    }
    func collection(_ collection: MusicCollection) async throws -> CollectionContent {
        guard let id = Self.id(collection.id) else { throw NovaError.emptyPage }
        let data = try await request(collection.kind.rawValue + "/" + id)
        guard let entry = data.album ?? data.playlist else { throw NovaError.emptyPage }
        let header = PageHeader(title: entry.title ?? collection.title, artist: entry.artist?.name, artworkURL: entry.artwork)
        return CollectionContent(header: header, tracks: (entry.tracks ?? []).compactMap {
            $0.track(album: collection.kind == .album ? entry : nil)
        }, continuation: nil, related: [])
    }
    func artist(_ id: String) async throws -> BrowsePage {
        guard let id = Self.id(id) else { throw NovaError.emptyPage }
        var result = try await request("artist/" + id)
        result.tracks = result.top?.tracks
        result.artists = result.related
        return BrowsePage(header: PageHeader(title: result.artist?.name ?? "", description: result.bio,
                                              artworkURL: result.artist?.artwork), shelves: shelves(result, scope: .all))
    }

    nonisolated static func normalize(_ value: String) -> String {
        value.folding(options: [.caseInsensitive, .diacriticInsensitive], locale: Locale(identifier: "en_US_POSIX"))
            .components(separatedBy: CharacterSet.alphanumerics.inverted)
            .filter { !$0.isEmpty && !["feat", "ft", "with", "avec", "and", "et", "the"].contains($0) }
            .joined(separator: " ")
    }
    nonisolated static func lead(_ value: String) -> String {
        names(value).first ?? value
    }
    private nonisolated static func names(_ value: String) -> [String] {
        value.replacingOccurrences(of: #"\s*(?:[,;&]|\s+(?:et|and|feat\.?|ft\.?)\s+)\s*"#,
                                   with: "|", options: .regularExpression)
            .split(separator: "|").map { String($0).trimmingCharacters(in: .whitespaces) }.filter { !$0.isEmpty }
    }
    private nonisolated static func recordingTitle(_ title: String, artist: String) -> String {
        var cleaned = title
            .replacingOccurrences(of: #"\s*[\[(]\s*(?:official(?:\s+(?:music|explicit))?\s+(?:audio|video|visuali[sz]er)|(?:official\s+)?(?:with\s+)?lyrics?(?:\s+video)?|paroles(?:\s*/\s*lyrics)?|audio(?:\s+officiel)?|clip\s+officiel|vid[ée]o\s+officielle|official)\s*[\])]\s*"#,
                                  with: " ", options: [.regularExpression, .caseInsensitive])
            .replacingOccurrences(of: #"\s+[-–—]\s*(?:official(?:\s+(?:music|explicit))?\s+(?:audio|video|visuali[sz]er)|(?:official\s+)?(?:with\s+)?lyrics?(?:\s+video)?|paroles(?:\s*/\s*lyrics)?|audio(?:\s+officiel)?|clip\s+officiel|vid[ée]o\s+officielle|official)\s*$"#,
                                  with: "", options: [.regularExpression, .caseInsensitive])
            .trimmingCharacters(in: .whitespacesAndNewlines)
        let credited = Set([normalize(artist), normalize(lead(artist))].filter { !$0.isEmpty })
        if let regex = try? NSRegularExpression(pattern: #"^(.+?)(?:\s+[-–—|]\s+|\s*:\s+)(.+)$"#),
           let match = regex.firstMatch(in: cleaned, range: NSRange(cleaned.startIndex..., in: cleaned)),
           let prefix = Range(match.range(at: 1), in: cleaned),
           let remainder = Range(match.range(at: 2), in: cleaned) {
            if credited.contains(normalize(String(cleaned[prefix]))) {
                cleaned = String(cleaned[remainder]).trimmingCharacters(in: .whitespacesAndNewlines)
            } else if credited.contains(normalize(String(cleaned[remainder]))) {
                cleaned = String(cleaned[prefix]).trimmingCharacters(in: .whitespacesAndNewlines)
            }
        }
        let wrappers = [("\"","\""), ("“", "”"), ("«", "»"), ("'", "'"), ("‘", "’")]
        if wrappers.contains(where: { cleaned.hasPrefix($0.0) && cleaned.hasSuffix($0.1) }), cleaned.count >= 2 {
            cleaned = String(cleaned.dropFirst().dropLast()).trimmingCharacters(in: .whitespacesAndNewlines)
        }
        return cleaned
    }

    private nonisolated static func credits(_ track: Track) -> (title: String, guests: Set<String>) {
        let title = recordingTitle(track.title, artist: track.artist)
        let pattern = #"\s*(?:\((?:feat(?:uring)?\.?|ft\.?|with|avec)\s+([^()]+)\)|\[(?:feat(?:uring)?\.?|ft\.?|with|avec)\s+([^\[\]]+)\]|\s+(?:feat(?:uring)?\.?|ft\.?)\s+(.+))\s*$"#
        let artistGuests = names(track.artist).dropFirst().map(normalize)
        guard let regex = try? NSRegularExpression(pattern: pattern, options: [.caseInsensitive]),
              let match = regex.firstMatch(in: title, range: NSRange(title.startIndex..<title.endIndex, in: title)),
              let range = Range(match.range, in: title) else { return (normalize(title), Set(artistGuests)) }
        let guests = (1..<match.numberOfRanges).compactMap { Range(match.range(at: $0), in: title) }
            .flatMap { names(String(title[$0])) }.map(normalize)
        return (normalize(String(title[..<range.lowerBound])), Set(artistGuests + guests))
    }
    private nonisolated static func sameCredits(_ wanted: Track, _ candidate: Track) -> Bool {
        let a = credits(wanted), b = credits(candidate)
        guard !a.title.isEmpty, a.title == b.title else { return false }
        if normalize(wanted.artist) == normalize(candidate.artist) || normalize(lead(wanted.artist)) == normalize(lead(candidate.artist)) {
            return a.guests.isSubset(of: b.guests) || b.guests.isSubset(of: a.guests)
        }
        let left = Set(names(wanted.artist).map(normalize)).union(a.guests)
        let right = Set(names(candidate.artist).map(normalize)).union(b.guests)
        return !left.isEmpty && !right.isEmpty && (left.isSubset(of: right) || right.isSubset(of: left))
    }
    private nonisolated static func sameClipCredits(_ clip: Track, _ candidate: Track) -> Bool {
        if sameCredits(clip, candidate) { return true }
        let title = recordingTitle(candidate.title, artist: candidate.artist)
        guard let regex = try? NSRegularExpression(pattern: #"\s+\(([^()]+) EP\)$"#, options: [.caseInsensitive]),
              let match = regex.firstMatch(in: title, range: NSRange(title.startIndex..., in: title)),
              let range = Range(match.range, in: title),
              let releaseRange = Range(match.range(at: 1), in: title),
              let album = candidate.album, let left = clip.duration, let right = candidate.duration,
              abs(left - right) <= 8 else { return false }
        let release = String(title[releaseRange])
        guard normalize(album).hasPrefix(normalize(release)),
              release.range(of: #"\b(live|demo|remix|cover|instrumental|acoustic|edit)\b"#,
                            options: [.regularExpression, .caseInsensitive]) == nil else { return false }
        var comparable = candidate
        comparable.title = String(title[..<range.lowerBound])
        return sameCredits(clip, comparable)
    }

    nonisolated static func sameRecording(_ wanted: Track, _ candidate: Track) -> Bool {
        guard sameCredits(wanted, candidate) else { return false }
        if normalize(recordingTitle(wanted.title, artist: wanted.artist)) == normalize(recordingTitle(candidate.title, artist: candidate.artist)) { return true }
        guard let left = wanted.duration, let right = candidate.duration else { return false }
        return abs(left - right) <= 8
    }
    private func suitable(_ wanted: Track, _ tracks: [Track]) -> Track? {
        let exact = tracks.filter {
            guard Self.sameRecording(wanted, $0) else { return false }
            if let a = wanted.duration, let b = $0.duration { return abs(a - b) <= 8 }
            return true
        }
        if let album = wanted.album, let match = exact.first(where: { Self.normalize($0.album ?? "") == Self.normalize(album) }) { return match }
        if wanted.id.hasPrefix("octave:played-"), let album = wanted.album, !Self.normalize(album).isEmpty,
           let match = tracks.first(where: {
               Self.normalize($0.album ?? "") == Self.normalize(album)
                   && Self.normalize($0.title) == Self.normalize(wanted.title)
                   && Self.normalize($0.artist) == Self.normalize(wanted.artist)
           }) { return match }
        if let first = exact.first { return first }
        if !wanted.hasSquareArtwork, let duration = wanted.duration {
            let audio = tracks.filter { candidate in
                guard candidate.hasSquareArtwork, let length = candidate.duration,
                      Self.sameCredits(wanted, candidate), Self.normalize(candidate.artist) == Self.normalize(wanted.artist) else { return false }
                return duration > length && duration - length <= min(15, max(10, duration * 0.04))
            }
            if audio.count == 1 { return audio[0] }
        }
        return nil
    }
    func recording(_ track: Track) async throws -> Track? {
        if Self.trackURL(track) != nil { return track }
        if let known = recordings[track.id] { return known }
        let lead = Self.lead(track.artist)
        let query = Self.recordingTitle(track.title, artist: track.artist) + " " + lead
        let alternate = Self.credits(track).title + " " + lead
        var shelves = try await search(query, scope: .all)
        var tracks = shelves.flatMap(\.tracks).filter { Self.trackURL($0) != nil }
        var queries = [alternate] + Self.names(track.artist).dropFirst().map { track.title + " " + $0 }
        if let album = track.album { queries.append(album + " " + lead) }
        var searched = Set([query])
        for other in queries where suitable(track, tracks) == nil && searched.insert(other).inserted {
            let extra = try await search(other, scope: .all)
            shelves += extra
            let known = Set(tracks.map(\.id))
            tracks += extra.flatMap(\.tracks).filter { Self.trackURL($0) != nil && !known.contains($0.id) }
        }
        var result = suitable(track, tracks)
        if let album = track.album, Self.normalize(result?.album ?? "") != Self.normalize(album),
           let release = shelves.flatMap(\.items).compactMap(\.collection).first(where: {
               $0.kind == .album && Self.normalize($0.title) == Self.normalize(album) && Self.normalize($0.subtitle) == Self.normalize(lead)
           }), let page = try? await collection(release), let exact = suitable(track, page.tracks) {
            result = exact
        }
        if result == nil, !track.hasSquareArtwork || track.album == nil {
            let possible = tracks.filter { Self.sameClipCredits(track, $0) && $0.duration != nil }
            for audioQuery in [query] + queries where result == nil && !possible.isEmpty {
                guard let songs = try? await InnerTubeClient().search(audioQuery, scope: .songs) else { continue }
                let canonical = songs.flatMap(\.tracks).filter { $0.id != track.id && $0.hasSquareArtwork && Self.sameClipCredits(track, $0) }
                let confirmed = possible.filter { candidate in canonical.contains { song in
                    guard Self.sameCredits(song, candidate), let a = song.duration, let b = candidate.duration else { return false }
                    return abs(a - b) <= 3
                }}
                if confirmed.count == 1 { result = confirmed[0] }
            }
        }
        if let result {
            if recordings.count >= 500, let first = recordings.keys.first { recordings.removeValue(forKey: first) }
            recordings[track.id] = result
        }
        return result
    }
    func youtubeRecording(_ track: Track) async throws -> Track? {
        if !track.id.hasPrefix("octave:") { return track }
        if let id = track.youtubeID, id.range(of: #"^[\w-]{11}$"#, options: .regularExpression) != nil {
            return Track(id: id, title: track.title, artist: track.artist, album: track.album, duration: track.duration, artworkURL: track.artworkURL)
        }
        let lead = Self.lead(track.artist)
        for query in [track.title + " " + track.artist, Self.credits(track).title + " " + lead] {
            let shelves = try await InnerTubeClient().search(query, scope: .songs)
            if let found = suitable(track, shelves.flatMap(\.tracks)) { return found }
        }
        return nil
    }
}

private enum OctaveWebPlayerCatalogError: LocalizedError {
    case invalidResponse
    var errorDescription: String? { "Le catalogue Octave a renvoyé une réponse illisible. Réessaie dans un instant." }
}
