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
    var sourceURL: URL?

    var isUpcoming: Bool {
        releaseDate.map { Calendar.current.startOfDay(for: $0) > Calendar.current.startOfDay(for: Date()) } ?? false
    }

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
        artists = Array(artists.prefix(100))
        var releases = try await albums(of: artists, since: since)
        releases += (try? await upcoming(artistNames: artists.map(\.1))) ?? []
        for index in releases.indices { releases[index].genre = genre.name }
        return combine(releases)
    }

    /// Sorties d'artistes nommés (artistes suivis ou les plus écoutés).
    static func releases(artistNames: [String], since: Date) async throws -> [Release] {
        var artists: [(Int, String)] = []
        let names = Array(Set(artistNames)).sorted()
        for offset in stride(from: 0, to: names.count, by: 6) {
            try Task.checkCancellation()
            try await withThrowingTaskGroup(of: (Int, String)?.self) { group in
                for name in names[offset..<min(offset + 6, names.count)] {
                    group.addTask {
                        var url = URLComponents(string: "https://api.deezer.com/search/artist")!
                        url.queryItems = [URLQueryItem(name: "q", value: name), URLQueryItem(name: "limit", value: "5")]
                        guard let address = url.url?.absoluteString,
                              let search = try? await get(address),
                              let matches = search["data"] as? [[String: Any]],
                              let artist = matches.first(where: { TrackMatcher.normalize($0["name"] as? String ?? "") == TrackMatcher.normalize(name) }),
                              let id = artist["id"] as? Int else { return nil }
                        return (id, artist["name"] as? String ?? name)
                    }
                }
                for try await found in group { if let found { artists.append(found) } }
            }
            try await Task.sleep(for: .milliseconds(700))
        }
        var seen = Set<Int>()
        artists = artists.filter { seen.insert($0.0).inserted }
        var releases = try await albums(of: artists, since: since)
        releases += (try? await upcoming(artistNames: artists.map(\.1))) ?? []
        return combine(releases)
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
                        var albums: [[String: Any]] = []
                        var address: String? = "https://api.deezer.com/artist/\(id)/albums?limit=100"
                        var visited = Set<String>()
                        while let page = address, visited.insert(page).inserted {
                            try Task.checkCancellation()
                            let json: [String: Any]
                            do { json = try await get(page) }
                            catch { try Task.checkCancellation(); break }
                            albums += (json["data"] as? [[String: Any]]) ?? []
                            let next = (json["next"] as? String).flatMap(URL.init(string:))
                            address = next?.host == "api.deezer.com" ? next?.absoluteString.replacingOccurrences(of: "http://", with: "https://") : nil
                        }
                        return albums.compactMap { item -> Release? in
                            guard var release = release(from: item, genre: nil),
                                  let date = release.releaseDate, date >= since
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
            try await Task.sleep(for: .milliseconds(700))
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
                       genre: genre, sourceURL: URL(string: "https://www.deezer.com/album/\(id)"))
    }

    static func combine(_ releases: [Release]) -> [Release] {
        var seen = Set<String>()
        return releases.filter { release in
            let key = [TrackMatcher.normalize(release.title), TrackMatcher.normalize(release.artist), release.releaseDate.map { dateFormatter.string(from: $0) } ?? String(release.id)].joined(separator: "|")
            return seen.insert(key).inserted
        }.sorted { ($0.releaseDate ?? .distantPast) > ($1.releaseDate ?? .distantPast) }
    }

    static func upcoming(artistNames: [String]) async throws -> [Release] {
        let names = Array(Set(artistNames)).sorted()
        let tomorrow = Calendar.current.date(byAdding: .day, value: 1, to: Date())!
        var result: [Release] = []
        for offset in stride(from: 0, to: names.count, by: 40) {
            let batch = Array(names[offset..<min(offset + 40, names.count)])
            let quoted = batch.map { name in
                "artist:\"" + name.replacingOccurrences(of: "\\", with: "\\\\").replacingOccurrences(of: "\"", with: "\\\"") + "\""
            }.joined(separator: " OR ")
            let query = "firstreleasedate:[\(dateFormatter.string(from: tomorrow)) TO *] AND (\(quoted))"
            var page = 0
            var total = 1
            while page < total {
                var url = URLComponents(string: "https://musicbrainz.org/ws/2/release-group")!
                url.queryItems = [URLQueryItem(name: "query", value: query), URLQueryItem(name: "fmt", value: "json"), URLQueryItem(name: "limit", value: "100"), URLQueryItem(name: "offset", value: String(page))]
                let data = try await ReleaseAnnouncements.shared.get(url.url!)
                let json = (try JSONSerialization.jsonObject(with: data)) as? [String: Any] ?? [:]
                let groups = json["release-groups"] as? [[String: Any]] ?? []
                for group in groups {
                    guard let id = group["id"] as? String, UUID(uuidString: id) != nil,
                          let title = group["title"] as? String,
                          let rawDate = group["first-release-date"] as? String, rawDate.count == 10,
                          let date = dateFormatter.date(from: rawDate), dateFormatter.string(from: date) == rawDate,
                          let credits = group["artist-credit"] as? [[String: Any]],
                          let number = Int(id.replacingOccurrences(of: "-", with: "").prefix(15), radix: 16) else { continue }
                    let artists = credits.compactMap { ($0["artist"] as? [String: Any])?["name"] as? String }
                    guard artists.contains(where: { artist in batch.contains { TrackMatcher.normalize($0) == TrackMatcher.normalize(artist) } }) else { continue }
                    let release = Release(id: -number, title: title, artist: artists.joined(separator: " & "),
                        coverURL: URL(string: "https://coverartarchive.org/release-group/\(id)/front-500"), releaseDate: date,
                        type: (group["primary-type"] as? String ?? "album").lowercased(),
                        sourceURL: URL(string: "https://musicbrainz.org/release-group/\(id)"))
                    if release.isUpcoming { result.append(release) }
                }
                guard !groups.isEmpty else { break }
                page += groups.count
                total = json["count"] as? Int ?? page
            }
        }
        return combine(result)
    }

    /// Requête à l'API publique de Deezer, avec nouvel essai quand le quota est atteint.
    static func get(_ address: String, attempt: Int = 0) async throws -> [String: Any] {
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

private actor ReleaseAnnouncements {
    static let shared = ReleaseAnnouncements()
    private var nextRequest = Date.distantPast

    func get(_ url: URL) async throws -> Data {
        let slot = max(Date(), nextRequest)
        nextRequest = slot.addingTimeInterval(1.1)
        let delay = slot.timeIntervalSinceNow
        if delay > 0 { try await Task.sleep(for: .seconds(delay)) }
        var request = URLRequest(url: url, timeoutInterval: 20)
        request.setValue("Nova/0.4.17 (https://github.com/akaRukasu/Nova)", forHTTPHeaderField: "User-Agent")
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        let (data, response) = try await URLSession.shared.data(for: request)
        guard (response as? HTTPURLResponse)?.statusCode == 200 else { throw URLError(.badServerResponse) }
        return data
    }
}

// MARK: - Concerts (Ticketmaster et OpenAgenda)

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
    var source: String = "Ticketmaster"

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
                       countryCode: String?, city: String? = nil) async throws -> [Concert] {
        let artist = artist.flatMap(cleanSearch)
        let city = city.flatMap(cleanSearch)
        async let agenda = try? openAgenda(artist: artist, latitude: latitude, longitude: longitude, radiusKm: radiusKm, country: countryCode, city: city)
        let found: [Concert]
        do {
            found = apiKey == nil ? [] : try await discovery(artist: artist, latitude: latitude, longitude: longitude,
                                                             radiusKm: radiusKm, countryCode: countryCode, city: city)
        } catch {
            if let extra = await agenda, !extra.isEmpty { return combine([], extra, artist: artist) }
            throw error
        }
        let extra = await agenda
        if apiKey == nil && extra == nil { throw URLError(.cannotLoadFromNetwork) }
        return combine(found, extra ?? [], artist: artist)
    }

    private static func discovery(artist: String?, latitude: Double?, longitude: Double?, radiusKm: Int,
                                  countryCode: String?, city: String?) async throws -> [Concert] {
        var query = [
            URLQueryItem(name: "classificationName", value: "music"),
            URLQueryItem(name: "sort", value: "date,asc"),
            URLQueryItem(name: "size", value: "100"),
            // Sans « * », l'API ne renvoie que les événements en anglais (presque rien en France).
            URLQueryItem(name: "locale", value: "*"),
        ]
        if let latitude, let longitude {
            query.append(URLQueryItem(name: "geoPoint", value: geohash(latitude: latitude, longitude: longitude)))
            query.append(URLQueryItem(name: "radius", value: "\(radiusKm)"))
            query.append(URLQueryItem(name: "unit", value: "km"))
        } else if let city, !city.isEmpty {
            // Ville sans coordonnées : Ticketmaster sait chercher par nom de ville.
            query.append(URLQueryItem(name: "city", value: city))
        } else if let countryCode, artist?.isEmpty ?? true {
            query.append(URLQueryItem(name: "countryCode", value: countryCode))
        }
        var variants = [query]
        if let artist {
            let attractionIDs = (try? await attractions(named: artist)) ?? []
            variants = [query.filter { $0.name != "classificationName" } + [URLQueryItem(name: "keyword", value: artist)]]
            variants += attractionIDs.map { query + [URLQueryItem(name: "attractionId", value: $0)] }
        }
        var result: [Concert] = []
        var failure: Error?
        var succeeded = false
        for variant in variants {
            for page in 0..<10 {
                do {
                    let json = try await get("events.json", query: variant + [URLQueryItem(name: "page", value: String(page))])
                    succeeded = true
                    let events = ((json["_embedded"] as? [String: Any])?["events"] as? [[String: Any]]) ?? []
                    result += events.compactMap(concert(from:))
                    let total = (json["page"] as? [String: Any])?["totalPages"] as? Int ?? 1
                    if page + 1 >= total { break }
                } catch {
                    failure = error
                    break
                }
            }
        }
        if !succeeded, let failure { throw failure }
        return result
    }

    private static func attractions(named name: String) async throws -> [String] {
        let json = try await get("attractions.json", query: [
            URLQueryItem(name: "keyword", value: name),
            URLQueryItem(name: "classificationName", value: "music"),
            URLQueryItem(name: "locale", value: "*"),
            URLQueryItem(name: "size", value: "10"),
        ])
        let attractions = ((json["_embedded"] as? [String: Any])?["attractions"] as? [[String: Any]]) ?? []
        let wanted = concertKey(name)
        let exact = attractions.filter {
            concertKey(($0["name"] as? String) ?? "") == wanted
        }
        return Array(exact.compactMap { $0["id"] as? String }.prefix(2))
    }

    private static func cleanSearch(_ text: String) -> String? {
        let value = String(text.trimmingCharacters(in: .whitespacesAndNewlines).prefix(120))
        return value.isEmpty ? nil : value
    }

    private static func concertKey(_ value: String) -> String {
        value.folding(options: [.caseInsensitive, .diacriticInsensitive], locale: nil)
            .split(whereSeparator: { !$0.isLetter && !$0.isNumber }).joined(separator: " ")
    }

    private static func safeLink(_ value: String?) -> URL? {
        guard let value, let url = URL(string: value), url.scheme == "https", url.host != nil,
              url.user == nil, url.password == nil else { return nil }
        return url
    }

    private static func inlineJSON(_ value: Any?) -> Any? {
        guard let text = value as? String else { return value }
        return try? JSONSerialization.jsonObject(with: Data(text.utf8))
    }

    private static func openAgenda(artist: String?, latitude: Double?, longitude: Double?, radiusKm: Int,
                                   country: String?, city: String?) async throws -> [Concert] {
        let endpoint = "https://public.opendatasoft.com/api/explore/v2.1/catalog/datasets/evenements-publics-openagenda/records"
        func phrase(_ value: String) -> String {
            "\"" + value.replacingOccurrences(of: #"["\\\p{Cc}]"#, with: " ", options: .regularExpression) + "\""
        }
        let today = dayFormatter.string(from: Date())
        var clauses = ["lastdate_begin >= date'\(today)'"]
        if let artist { clauses.append("search(title_fr, \(phrase(artist)))") }
        else {
            let genres = ["concert", "musique", "rock", "metal", "punk", "jazz", "rap", "hip-hop", "electro", "pop", "reggae", "soul"]
            let filters = [#"search(title_fr, "concert")"#] + genres.map { "search(keywords_fr, \(phrase($0)))" }
            clauses.append("(" + filters.joined(separator: " or ") + ")")
        }
        let location = latitude.flatMap { lat in longitude.map { (lat: lat, lon: $0) } }
        let radius = max(1, min(500, radiusKm))
        if let location, (-90...90).contains(location.lat), (-180...180).contains(location.lon) {
            // OpenAgenda ne reçoit qu'un centre arrondi. Le rayon exact est appliqué sur l'appareil.
            let lat = (location.lat * 10).rounded() / 10
            let lon = (location.lon * 10).rounded() / 10
            clauses.append("within_distance(location_coordinates, geom'POINT(\(lon) \(lat))', \(radius + 10) km)")
        } else if let city { clauses.append("location_city = \(phrase(city))") }
        else if artist == nil { clauses.append("location_countrycode = \(phrase(country ?? "FR"))") }

        let select = "uid,title_fr,firstdate_begin,lastdate_begin,timings,status,location_name,location_city,location_countrycode,location_coordinates,registration,canonicalurl,image"
        let iso = ISO8601DateFormatter()
        var concerts: [Concert] = []
        for offset in stride(from: 0, to: 1000, by: 100) {
            var components = URLComponents(string: endpoint)!
            components.queryItems = [.init(name: "where", value: clauses.joined(separator: " and ")),
                .init(name: "select", value: select), .init(name: "order_by", value: "lastdate_begin asc"),
                .init(name: "limit", value: "100"), .init(name: "offset", value: String(offset))]
            let response: (Data, URLResponse)
            do { response = try await URLSession.shared.data(for: URLRequest(url: components.url!, timeoutInterval: 10)) }
            catch { if concerts.isEmpty { throw error }; break }
            let code = (response.1 as? HTTPURLResponse)?.statusCode ?? 0
            if code != 200 {
                if concerts.isEmpty { throw ImportError.http(code, "OpenAgenda") }
                break
            }
            let page = (try JSONSerialization.jsonObject(with: response.0)) as? [String: Any] ?? [:]
            let events = page["results"] as? [[String: Any]] ?? []
            for event in events {
                guard let uid = event["uid"] as? String, let name = event["title_fr"] as? String,
                      !name.isEmpty, (inlineJSON(event["status"]) as? [String: Any])?["id"] as? Int != 3 else { continue }
                let coordinates = event["location_coordinates"] as? [String: Double]
                if let location, let lat = coordinates?["lat"], let lon = coordinates?["lon"] {
                    let radians = Double.pi / 180
                    let a = pow(sin((lat - location.lat) * radians / 2), 2)
                        + cos(lat * radians) * cos(location.lat * radians) * pow(sin((lon - location.lon) * radians / 2), 2)
                    if 12_742 * asin(sqrt(min(1, max(0, a)))) > Double(radius) { continue }
                }
                let registration = inlineJSON(event["registration"]) as? [[String: Any]] ?? []
                let url = registration.compactMap { safeLink($0["value"] as? String) }.first ?? safeLink(event["canonicalurl"] as? String)
                let timings = (inlineJSON(event["timings"]) as? [[String: Any]])?.compactMap { $0["begin"] as? String } ?? []
                let dates = timings.isEmpty ? [event["firstdate_begin"], event["lastdate_begin"]].compactMap { $0 as? String } : timings
                for value in Set(dates) {
                    guard let date = iso.date(from: value), dayFormatter.string(from: date) >= today else { continue }
                    concerts.append(Concert(id: "openagenda:" + uid + ":" + value, name: name, artists: artist.map { [$0] } ?? [name], date: date,
                        venue: event["location_name"] as? String ?? "", city: event["location_city"] as? String ?? "",
                        country: event["location_countrycode"] as? String ?? "", latitude: coordinates?["lat"], longitude: coordinates?["lon"],
                        ticketURL: url, imageURL: safeLink(event["image"] as? String), source: "OpenAgenda"))
                }
            }
            if events.isEmpty || offset + 100 >= (page["total_count"] as? Int ?? 0) { break }
        }
        return concerts
    }

    static func combine(_ ticketmaster: [Concert], _ openAgenda: [Concert], artist: String?) -> [Concert] {
        let wanted = concertKey(artist ?? "")
        var seen = Set<String>()
        var results: [Concert] = []
        for concert in ticketmaster + openAgenda where seen.insert(concert.id).inserted {
            let city = concertKey(concert.city), venue = concertKey(concert.venue), name = concertKey(concert.name)
            func withoutCity(_ title: String) -> String {
                let suffix = " a " + city
                return title.hasSuffix(suffix) ? String(title.dropLast(suffix.count)) : title
            }
            let duplicate = results.firstIndex { previous in
                guard previous.source != concert.source, !city.isEmpty, concertKey(previous.city) == city,
                      dayFormatter.string(from: previous.date) == dayFormatter.string(from: concert.date),
                      abs(previous.date.timeIntervalSince(concert.date)) <= 90 * 60 else { return false }
                let previousVenue = concertKey(previous.venue), previousName = concertKey(previous.name)
                let sameVenue = !venue.isEmpty && !previousVenue.isEmpty && (venue.contains(previousVenue) || previousVenue.contains(venue)
                    || venue.split(separator: " ").contains { $0.count > 4 && previousVenue.split(separator: " ").contains($0) })
                return sameVenue && (withoutCity(name) == withoutCity(previousName)
                    || (!wanted.isEmpty && name.contains(wanted) && previousName.contains(wanted)))
            }
            if let duplicate {
                if results[duplicate].ticketURL == nil { results[duplicate].ticketURL = concert.ticketURL }
                if results[duplicate].imageURL == nil { results[duplicate].imageURL = concert.imageURL }
            } else { results.append(concert) }
        }
        return results.sorted { $0.date < $1.date }
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
              let dates = event["dates"] as? [String: Any],
              (dates["status"] as? [String: Any])?["code"] as? String != "cancelled",
              let start = dates["start"] as? [String: Any],
              let day = start["localDate"] as? String,
              var date = dayFormatter.date(from: day) else { return nil }
        if let time = start["localTime"] as? String {
            let parts = time.split(separator: ":").compactMap { Int($0) }
            if parts.count >= 2 { date = date.addingTimeInterval(TimeInterval(parts[0] * 3600 + parts[1] * 60)) }
        }
        if let iso = start["dateTime"] as? String, let timestamp = ISO8601DateFormatter().date(from: iso) { date = timestamp }
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
