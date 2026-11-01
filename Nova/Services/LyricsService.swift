import Foundation

/// Paroles d'un titre : synchronisées depuis LRCLIB (base libre et gratuite de paroles horodatées),
/// sinon le texte simple de YouTube Music.
enum LyricsService {
    static func lyrics(for track: Track, duration: TimeInterval?, client: InnerTubeClient) async -> Lyrics? {
        async let synced = lrclib(for: track, duration: duration)
        async let plain = try? client.lyrics(for: track.id)
        let fromLRCLIB = await synced
        if let fromLRCLIB, fromLRCLIB.isSynced { return fromLRCLIB }
        if let youtube = await plain { return youtube }
        return fromLRCLIB
    }

    // MARK: LRCLIB

    private struct Entry: Decodable {
        var trackName: String?
        var artistName: String?
        var duration: Double?
        var instrumental: Bool?
        var plainLyrics: String?
        var syncedLyrics: String?
    }

    static func lrclib(for track: Track, duration: TimeInterval?) async -> Lyrics? {
        let title = TrackMatcher.stripExtras(track.title)
        let artist = TrackMatcher.mainArtist(track.artist)
        guard !title.isEmpty else { return nil }

        // 1. Correspondance exacte (titre, artiste, album, durée).
        var exact = [URLQueryItem(name: "track_name", value: title), URLQueryItem(name: "artist_name", value: artist)]
        if let album = track.album, !album.isEmpty { exact.append(URLQueryItem(name: "album_name", value: album)) }
        if let duration, duration > 0 { exact.append(URLQueryItem(name: "duration", value: String(Int(duration.rounded())))) }
        if let entry: Entry = await get("get", exact), entry.syncedLyrics?.isEmpty == false {
            return lyrics(from: entry)
        }

        // 2. Recherche : meilleur résultat synchronisé, à la durée la plus proche.
        guard let results: [Entry] = await get("search", [URLQueryItem(name: "track_name", value: title),
                                                          URLQueryItem(name: "artist_name", value: artist)]) else { return nil }
        let wantedTitle = TrackMatcher.normalize(title)
        let candidates = results.filter { entry in
            guard entry.instrumental != true else { return false }
            let name = TrackMatcher.normalize(TrackMatcher.stripExtras(entry.trackName ?? ""))
            return name == wantedTitle || name.contains(wantedTitle) || wantedTitle.contains(name)
        }
        func gap(_ entry: Entry) -> Double {
            guard let duration, duration > 0, let other = entry.duration else { return 5 }
            return abs(other - duration)
        }
        let synced = candidates.filter { $0.syncedLyrics?.isEmpty == false && gap($0) < 8 }
        if let best = synced.min(by: { gap($0) < gap($1) }) { return lyrics(from: best) }
        if let plain = candidates.first(where: { $0.plainLyrics?.isEmpty == false }) { return lyrics(from: plain) }
        return nil
    }

    private static func lyrics(from entry: Entry) -> Lyrics? {
        let lines = entry.syncedLyrics.map(parseLRC) ?? []
        let text = entry.plainLyrics ?? lines.map(\.text).joined(separator: "\n")
        guard !text.isEmpty || !lines.isEmpty else { return nil }
        return Lyrics(text: text, source: "Paroles : LRCLIB", lines: lines.isEmpty ? nil : lines)
    }

    /// Format LRC : « [01:23.45] texte », plusieurs horodatages possibles par ligne.
    static func parseLRC(_ raw: String) -> [LyricLine] {
        let pattern = try! NSRegularExpression(pattern: #"\[(\d+):(\d+(?:[.:]\d+)?)\]"#)
        var lines: [LyricLine] = []
        for row in raw.components(separatedBy: .newlines) {
            let range = NSRange(row.startIndex..., in: row)
            let matches = pattern.matches(in: row, range: range)
            guard let last = matches.last, let textRange = Range(NSRange(location: last.range.upperBound,
                                                                           length: range.length - last.range.upperBound), in: row)
            else { continue }
            let text = row[textRange].trimmingCharacters(in: .whitespaces)
            for match in matches {
                guard let minutes = Range(match.range(at: 1), in: row).flatMap({ Double(row[$0]) }),
                      let seconds = Range(match.range(at: 2), in: row)
                        .flatMap({ Double(row[$0].replacingOccurrences(of: ":", with: ".")) }) else { continue }
                lines.append(LyricLine(time: minutes * 60 + seconds, text: text))
            }
        }
        return lines.sorted { $0.time < $1.time }
    }

    private static func get<T: Decodable>(_ endpoint: String, _ query: [URLQueryItem]) async -> T? {
        var components = URLComponents(string: "https://lrclib.net/api/\(endpoint)")!
        components.queryItems = query
        guard let url = components.url else { return nil }
        var request = URLRequest(url: url, timeoutInterval: 10)
        // LRCLIB demande que chaque application s'identifie.
        request.setValue("Nova (https://github.com/akaRukasu/Nova)", forHTTPHeaderField: "User-Agent")
        guard let (data, response) = try? await URLSession.shared.data(for: request),
              (response as? HTTPURLResponse)?.statusCode == 200 else { return nil }
        return try? JSONDecoder().decode(T.self, from: data)
    }
}
