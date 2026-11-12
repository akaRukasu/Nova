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
        var tracks: [Entry]?
        var albums: [Entry]?
        var artists: [Entry]?
        var playlists: [Entry]?
        var album: Entry?
        var playlist: Entry?
        var artist: Entry?
        var top: [Entry]?
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
        return try JSONDecoder().decode(Catalog.self, from: data)
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
        let result = try await request("search/page", query: [.init(name: "query", value: query), .init(name: "limit", value: "30")])
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
        result.tracks = result.top
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
        value.components(separatedBy: ",").first ?? value
    }
    nonisolated static func sameRecording(_ wanted: Track, _ candidate: Track) -> Bool {
        normalize(wanted.title) == normalize(candidate.title)
            && normalize(lead(wanted.artist)) == normalize(lead(candidate.artist))
    }
    private func suitable(_ wanted: Track, _ tracks: [Track]) -> Track? {
        let exact = tracks.filter {
            guard Self.sameRecording(wanted, $0) else { return false }
            if let a = wanted.duration, let b = $0.duration { return abs(a - b) <= 8 }
            return true
        }
        if let album = wanted.album, let match = exact.first(where: { Self.normalize($0.album ?? "") == Self.normalize(album) }) { return match }
        return exact.first
    }
    func recording(_ track: Track) async throws -> Track? {
        if Self.trackURL(track) != nil { return track }
        if let known = recordings[track.id] { return known }
        let query = track.title + " " + Self.lead(track.artist)
        let tracks = try await search(query, scope: .songs).flatMap(\.tracks).filter { Self.trackURL($0) != nil }
        var result = suitable(track, tracks)
        if result == nil, !track.hasSquareArtwork {
            let possible = tracks.filter { Self.sameRecording(track, $0) && $0.duration != nil }
            if !possible.isEmpty, let songs = try? await InnerTubeClient().search(query, scope: .songs) {
                let canonical = songs.flatMap(\.tracks).filter { $0.hasSquareArtwork && Self.sameRecording(track, $0) }
                let confirmed = possible.filter { candidate in canonical.contains { song in
                    guard let a = song.duration, let b = candidate.duration else { return false }
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
        let shelves = try await InnerTubeClient().search(track.title + " " + Self.lead(track.artist), scope: .songs)
        return suitable(track, shelves.flatMap(\.tracks))
    }
}
