import Foundation

// MARK: - Sorties (API publique de Deezer, classée par genre)

struct ReleaseGenre: Identifiable, Codable, Hashable {
    let id: Int
    var name: String
    var pictureURL: URL?
}

struct Release: Identifiable, Codable, Hashable {
    let id: Int
    var title: String
    var artist: String
    var coverURL: URL?
    var releaseDate: Date?
    /// « album », « single », « ep »…
    var type: String
    var genre: String?

    var typeLabel: String {
        switch type.lowercased() {
        case "single": return "Single"
        case "ep": return "EP"
        case "compile": return "Compilation"
        default: return "Album"
        }
    }
}

enum ReleasesService {
    private static let dateFormatter: DateFormatter = {
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.dateFormat = "yyyy-MM-dd"
        return formatter
    }()

    /// Genres proposés par Deezer (sans « Tous »).
    static func genres() async throws -> [ReleaseGenre] {
        let json = try await get("https://api.deezer.com/genre")
        return ((json["data"] as? [[String: Any]]) ?? []).compactMap { item in
            guard let id = item["id"] as? Int, id != 0, let name = item["name"] as? String else { return nil }
            return ReleaseGenre(id: id, name: name, pictureURL: (item["picture_xl"] as? String).flatMap(URL.init(string:)))
        }
    }

    /// Sorties récentes des artistes phares d'un genre (l'API n'a pas de liste « nouveautés » par genre).
    static func releases(genre: ReleaseGenre, since: Date) async throws -> [Release] {
        // Les classements d'albums et de titres sont filtrés par genre (celui des artistes ne l'est pas) :
        // on en tire les artistes du genre.
        var artists: [(Int, String)] = []
        var seen = Set<Int>()
        for chart in ["albums", "tracks"] {
            let json = try await get("https://api.deezer.com/chart/\(genre.id)/\(chart)?limit=100")
            for item in (json["data"] as? [[String: Any]]) ?? [] {
                guard let artist = item["artist"] as? [String: Any],
                      let id = artist["id"] as? Int, let name = artist["name"] as? String,
                      seen.insert(id).inserted else { continue }
                artists.append((id, name))
            }
        }
        artists = Array(artists.prefix(60))
        var releases = try await albums(of: artists, since: since)
        for index in releases.indices { releases[index].genre = genre.name }
        return releases
    }

    /// Sorties d'artistes nommés (artistes suivis ou les plus écoutés).
    static func releases(artistNames: [String], since: Date) async throws -> [Release] {
        var artists: [(Int, String)] = []
        try await withThrowingTaskGroup(of: (Int, String)?.self) { group in
            for name in artistNames.prefix(40) {
                group.addTask {
                    guard let query = name.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed),
                          let search = try? await get("https://api.deezer.com/search/artist?q=\(query)&limit=1"),
                          let artist = (search["data"] as? [[String: Any]])?.first,
                          let id = artist["id"] as? Int else { return nil }
                    return (id, artist["name"] as? String ?? name)
                }
            }
            for try await found in group { if let found { artists.append(found) } }
        }
        return try await albums(of: artists, since: since)
    }

    /// Sorties d'un artiste depuis `since`.
    static func artistReleases(name: String, since: Date) async throws -> [Release] {
        try await releases(artistNames: [name], since: since)
    }

    /// Albums et singles récents, six artistes à la fois (limite de l'API : 50 requêtes / 5 s).
    private static func albums(of artists: [(Int, String)], since: Date) async throws -> [Release] {
        var result: [Release] = []
        var seen = Set<Int>()
        for chunk in stride(from: 0, to: artists.count, by: 6).map({ Array(artists[$0..<min($0 + 6, artists.count)]) }) {
            try await withThrowingTaskGroup(of: [Release].self) { group in
                for (id, name) in chunk {
                    group.addTask {
                        guard let json = try? await get("https://api.deezer.com/artist/\(id)/albums?limit=15") else { return [] }
                        return ((json["data"] as? [[String: Any]]) ?? []).compactMap { item -> Release? in
                            guard var release = release(from: item, genre: nil),
                                  let date = release.releaseDate, date >= since, date <= Date().addingTimeInterval(86_400 * 7)
                            else { return nil }
                            release.artist = name
                            return release
                        }
                    }
                }
                for try await batch in group {
                    for release in batch where seen.insert(release.id).inserted { result.append(release) }
                }
            }
            // Limite de l'API : 50 requêtes par 5 secondes.
            try? await Task.sleep(for: .milliseconds(700))
        }
        return result.sorted { ($0.releaseDate ?? .distantPast) > ($1.releaseDate ?? .distantPast) }
    }

    private static func release(from item: [String: Any], genre: String?) -> Release? {
        guard let id = item["id"] as? Int, let title = item["title"] as? String else { return nil }
        let artist = (item["artist"] as? [String: Any])?["name"] as? String ?? ""
        let cover = (item["cover_xl"] as? String) ?? (item["cover_big"] as? String)
        return Release(id: id, title: title, artist: artist,
                       coverURL: cover.flatMap(URL.init(string:)),
                       releaseDate: (item["release_date"] as? String).flatMap(dateFormatter.date(from:)),
                       type: item["record_type"] as? String ?? "album",
                       genre: genre)
    }

    private static func get(_ address: String, attempt: Int = 0) async throws -> [String: Any] {
        guard let url = URL(string: address) else { throw ImportError.nothingFound }
        let (data, response) = try await URLSession.shared.data(from: url)
        let status = (response as? HTTPURLResponse)?.statusCode ?? 0
        guard status == 200 else { throw ImportError.http(status, "Deezer") }
        let json = (try JSONSerialization.jsonObject(with: data) as? [String: Any]) ?? [:]
        // « Quota limit exceeded » : on attend un peu et on réessaie.
        if let error = json["error"] as? [String: Any], (error["code"] as? Int) == 4, attempt < 3 {
            try await Task.sleep(for: .milliseconds(1500))
            return try await get(address, attempt: attempt + 1)
        }
        return json
    }
}

// MARK: - Concerts (API Discovery de Ticketmaster, avec la clé gratuite de l'utilisateur)

struct Concert: Identifiable, Codable, Hashable {
    let id: String
    var name: String
    var artists: [String]
    var date: Date
    var venue: String
    var city: String
    var country: String
    var latitude: Double?
    var longitude: Double?
    var ticketURL: URL?
    var imageURL: URL?

    var place: String { [venue, city].filter { !$0.isEmpty }.joined(separator: " · ") }
}

enum ConcertsError: LocalizedError {
    case missingKey
    case invalidKey

    var errorDescription: String? {
        switch self {
        case .missingKey:
            return "Ajoute ta clé Ticketmaster dans Réglages › Concerts pour chercher des concerts."
        case .invalidKey:
            return "Ticketmaster refuse la clé. Vérifie que tu as copié la « Consumer Key » (et non le « Consumer Secret ») dans Réglages › Concerts."
        }
    }
}

enum ConcertsService {
    /// Clé personnelle de l'API Ticketmaster (gratuite sur developer.ticketmaster.com).
    static var apiKey: String? {
        let key = UserDefaults.standard.string(forKey: "ticketmasterKey")?.trimmingCharacters(in: .whitespaces)
        return (key?.isEmpty ?? true) ? nil : key
    }

    private static let dayFormatter: DateFormatter = {
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.dateFormat = "yyyy-MM-dd"
        return formatter
    }()

    /// Concerts à venir d'un artiste, et/ou autour d'une position.
    static func search(artist: String?, latitude: Double?, longitude: Double?, radiusKm: Int,
                       countryCode: String?) async throws -> [Concert] {
        var query = [
            URLQueryItem(name: "classificationName", value: "music"),
            URLQueryItem(name: "sort", value: "date,asc"),
            URLQueryItem(name: "size", value: "100"),
            // Sans « * », l'API ne renvoie que les événements en anglais (presque rien en France).
            URLQueryItem(name: "locale", value: "*"),
        ]
        if let artist, !artist.isEmpty {
            // On identifie l'artiste dans le catalogue pour éviter les homonymes et les correspondances floues.
            if let attractionID = try await attraction(named: artist) {
                query.append(URLQueryItem(name: "attractionId", value: attractionID))
            } else {
                query.append(URLQueryItem(name: "keyword", value: artist))
            }
        }
        if let latitude, let longitude {
            query.append(URLQueryItem(name: "geoPoint", value: geohash(latitude: latitude, longitude: longitude)))
            query.append(URLQueryItem(name: "radius", value: "\(radiusKm)"))
            query.append(URLQueryItem(name: "unit", value: "km"))
        } else if let countryCode, artist?.isEmpty ?? true {
            query.append(URLQueryItem(name: "countryCode", value: countryCode))
        }
        let json = try await get("events.json", query: query)
        let events = ((json["_embedded"] as? [String: Any])?["events"] as? [[String: Any]]) ?? []
        return events.compactMap(concert(from:))
    }

    /// Identifiant Ticketmaster de l'artiste dont le nom correspond le mieux.
    private static func attraction(named name: String) async throws -> String? {
        let json = try await get("attractions.json", query: [
            URLQueryItem(name: "keyword", value: name),
            URLQueryItem(name: "classificationName", value: "music"),
            URLQueryItem(name: "locale", value: "*"),
            URLQueryItem(name: "size", value: "10"),
        ])
        let attractions = ((json["_embedded"] as? [String: Any])?["attractions"] as? [[String: Any]]) ?? []
        let wanted = name.folding(options: [.caseInsensitive, .diacriticInsensitive], locale: nil)
        let exact = attractions.first {
            (($0["name"] as? String) ?? "").folding(options: [.caseInsensitive, .diacriticInsensitive], locale: nil) == wanted
        }
        return (exact ?? attractions.first)?["id"] as? String
    }

    private static func get(_ path: String, query: [URLQueryItem]) async throws -> [String: Any] {
        guard let key = apiKey else { throw ConcertsError.missingKey }
        var components = URLComponents(string: "https://app.ticketmaster.com/discovery/v2/\(path)")!
        components.queryItems = [URLQueryItem(name: "apikey", value: key)] + query
        var attempt = 0
        while true {
            let (data, response) = try await URLSession.shared.data(from: components.url!)
            let status = (response as? HTTPURLResponse)?.statusCode ?? 0
            switch status {
            case 200:
                return (try JSONSerialization.jsonObject(with: data) as? [String: Any]) ?? [:]
            case 401, 403:
                throw ConcertsError.invalidKey
            case 429 where attempt < 3:
                // Limite de 5 requêtes par seconde de la clé gratuite.
                attempt += 1
                try await Task.sleep(for: .milliseconds(600 * attempt))
            default:
                throw ImportError.http(status, "Ticketmaster")
            }
        }
    }

    /// Geohash (précision 9) attendu par le paramètre `geoPoint`.
    static func geohash(latitude: Double, longitude: Double, precision: Int = 9) -> String {
        let base32 = Array("0123456789bcdefghjkmnpqrstuvwxyz")
        var latRange = (-90.0, 90.0), lonRange = (-180.0, 180.0)
        var hash = "", bit = 0, value = 0, even = true
        while hash.count < precision {
            if even {
                let mid = (lonRange.0 + lonRange.1) / 2
                if longitude >= mid { value = value << 1 | 1; lonRange.0 = mid } else { value <<= 1; lonRange.1 = mid }
            } else {
                let mid = (latRange.0 + latRange.1) / 2
                if latitude >= mid { value = value << 1 | 1; latRange.0 = mid } else { value <<= 1; latRange.1 = mid }
            }
            even.toggle()
            bit += 1
            if bit == 5 {
                hash.append(base32[value])
                bit = 0
                value = 0
            }
        }
        return hash
    }

    private static func concert(from event: [String: Any]) -> Concert? {
        guard let id = event["id"] as? String, let name = event["name"] as? String,
              let start = (event["dates"] as? [String: Any])?["start"] as? [String: Any],
              let day = start["localDate"] as? String,
              var date = dayFormatter.date(from: day) else { return nil }
        if let time = start["localTime"] as? String {
            let parts = time.split(separator: ":").compactMap { Int($0) }
            if parts.count >= 2 { date = date.addingTimeInterval(TimeInterval(parts[0] * 3600 + parts[1] * 60)) }
        }
        let embedded = event["_embedded"] as? [String: Any] ?? [:]
        let venue = (embedded["venues"] as? [[String: Any]])?.first ?? [:]
        let location = venue["location"] as? [String: Any] ?? [:]
        let artists = ((embedded["attractions"] as? [[String: Any]]) ?? []).compactMap { $0["name"] as? String }
        let image = ((event["images"] as? [[String: Any]]) ?? [])
            .max { ($0["width"] as? Int ?? 0) < ($1["width"] as? Int ?? 0) }?["url"] as? String
        return Concert(id: id, name: name, artists: artists.isEmpty ? [name] : artists, date: date,
                       venue: venue["name"] as? String ?? "",
                       city: (venue["city"] as? [String: Any])?["name"] as? String ?? "",
                       country: (venue["country"] as? [String: Any])?["name"] as? String ?? "",
                       latitude: Double(location["latitude"] as? String ?? ""),
                       longitude: Double(location["longitude"] as? String ?? ""),
                       ticketURL: (event["url"] as? String).flatMap(URL.init(string:)),
                       imageURL: image.flatMap(URL.init(string:)))
    }
}
