import Foundation

/// Retrouve la vraie pochette carrée (HD) d'un titre qui n'a qu'une miniature vidéo :
/// pochette du titre dans YouTube Music, de sa version audio (clips) ou de son album.
/// Les réponses sont gardées sur le disque : chaque titre n'est cherché qu'une fois.
actor ArtworkResolver {
    static let shared = ArtworkResolver()

    /// Adresse spéciale à mettre devant les miniatures : `ImageLoader` la résout ici.
    static let scheme = "nova-artwork"

    static func placeholderURL(for videoID: String) -> URL? {
        URL(string: "\(scheme)://track/\(videoID)")
    }

    private let client = InnerTubeClient()
    /// Identifiant → adresse de la pochette ("" : le titre n'en a pas, c'est un vrai clip).
    private var known: [String: String] = [:]
    private var pending: [String: Task<URL?, Never>] = [:]
    private var running = 0
    private var waiters: [CheckedContinuation<Void, Never>] = []
    private var saveScheduled = false

    private let fileURL = FileManager.default
        .urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
        .appendingPathComponent("Nova", isDirectory: true)
        .appendingPathComponent("artworks.json")

    init() {
        if let data = try? Data(contentsOf: fileURL),
           let saved = try? JSONDecoder().decode([String: String].self, from: data) {
            known = saved
        }
    }

    /// Pochette carrée connue sans requête réseau (`nil` : pas encore cherchée ou introuvable).
    func cachedArtwork(for videoID: String) -> URL? {
        known[videoID].flatMap { $0.isEmpty ? nil : URL(string: $0) }
    }

    /// Vrai quand on sait que le titre n'a pas de pochette carrée (clip seul).
    func isVideoOnly(_ videoID: String) -> Bool {
        known[videoID] == ""
    }

    func artwork(for videoID: String) async -> URL? {
        if let value = known[videoID] { return value.isEmpty ? nil : URL(string: value) }
        if let task = pending[videoID] { return await task.value }
        let task = Task { await self.lookup(videoID) }
        pending[videoID] = task
        let url = await task.value
        pending[videoID] = nil
        return url
    }

    private func lookup(_ videoID: String) async -> URL? {
        await acquire()
        defer { release() }
        do {
            let url = try await client.squareArtwork(for: videoID)
            // Une absence de réponse n'est retenue que si YouTube Music a bien répondu.
            known[videoID] = url?.absoluteString ?? ""
            scheduleSave()
            return url
        } catch {
            return nil
        }
    }

    // MARK: Quatre recherches à la fois au plus

    private func acquire() async {
        if running < 4 { running += 1; return }
        await withCheckedContinuation { waiters.append($0) }
    }

    private func release() {
        if waiters.isEmpty { running -= 1 } else { waiters.removeFirst().resume() }
    }

    private func scheduleSave() {
        guard !saveScheduled else { return }
        saveScheduled = true
        Task {
            try? await Task.sleep(for: .seconds(2))
            self.save()
        }
    }

    private func save() {
        saveScheduled = false
        try? FileManager.default.createDirectory(at: fileURL.deletingLastPathComponent(), withIntermediateDirectories: true)
        try? JSONEncoder().encode(known).write(to: fileURL, options: .atomic)
    }
}

extension InnerTubeClient {
    /// Pochette carrée d'un titre : la sienne, celle de sa version audio, celle de son album,
    /// ou celle du même titre trouvé par la recherche. `nil` : c'est un clip sans équivalent.
    func squareArtwork(for videoID: String) async throws -> URL? {
        let json = try await post("next", body: [
            "videoId": videoID,
            "playlistId": "RDAMVM\(videoID)",
            "isAudioOnly": true,
            "enablePersistentPlaylistPanel": true,
        ])
        func square(_ item: JSONObject) -> URL? {
            guard let url = Parser.thumbnail(item["thumbnail"]), url.host?.contains("googleusercontent") == true
            else { return nil }
            return url
        }

        // Clip : YouTube Music lui associe sa version audio (« counterpart »), avec la pochette de l'album.
        for wrapper in JSONWalk.collect("playlistPanelVideoWrapperRenderer", in: json) {
            guard let primary = JSONWalk.first("playlistPanelVideoRenderer", in: wrapper["primaryRenderer"] ?? JSONObject()) as? JSONObject,
                  primary["videoId"] as? String == videoID else { continue }
            if let url = square(primary) { return url }
            for counterpart in JSONWalk.collect("playlistPanelVideoRenderer", in: wrapper["counterpart"] ?? [Any]()) {
                if let url = square(counterpart) { return url }
            }
        }

        let panel = JSONWalk.collect("playlistPanelVideoRenderer", in: json)
        guard let item = panel.first(where: { $0["videoId"] as? String == videoID }) else { return nil }
        if let url = square(item) { return url }

        let info = Parser.meta(Parser.runs(item["longBylineText"]))
        if let albumID = info.albumID,
           let url = (try? await collection(albumID))?.header.artworkURL,
           url.host?.contains("googleusercontent") == true {
            return url
        }

        // Dernier essai : le même titre, du même artiste, parmi les titres de la recherche.
        guard let artist = info.artist, !artist.isEmpty else { return nil }
        let title = Self.songTitle(Parser.text(item["title"]), artist: artist)
        guard !title.isEmpty,
              let shelves = try? await search("\(title) \(artist)", scope: .songs) else { return nil }
        let wantedTitle = Self.artworkKey(title), wantedArtist = Self.artworkKey(artist)
        let match = shelves.flatMap(\.tracks).first { candidate in
            candidate.hasSquareArtwork
                && Self.artworkKey(candidate.title) == wantedTitle
                && Self.artworkKey(candidate.artist).contains(wantedArtist)
        }
        return match?.artworkURL
    }

    /// Titre d'un clip ramené au titre du morceau : « Artiste - Titre (Official Video) feat. X » → « Titre ».
    private static func songTitle(_ raw: String, artist: String) -> String {
        var title = raw.replacingOccurrences(of: #"\s*[\(\[][^\)\]]*[\)\]]"#, with: "", options: .regularExpression)
        title = title.replacingOccurrences(of: #"(?i)\s+(feat\.?|ft\.?|featuring|avec)\s+.*$"#, with: "",
                                           options: .regularExpression)
        for separator in [" - ", " – ", " — ", " | "] {
            let parts = title.components(separatedBy: separator)
            guard parts.count >= 2 else { continue }
            // L'artiste est d'un côté du tiret, le titre de l'autre.
            if artworkKey(parts[0]).contains(artworkKey(artist)) || artworkKey(artist).contains(artworkKey(parts[0])) {
                title = parts.dropFirst().joined(separator: separator)
            } else if artworkKey(parts.last!).contains(artworkKey(artist)) {
                title = parts.dropLast().joined(separator: separator)
            }
            break
        }
        return title.trimmingCharacters(in: .whitespaces)
    }

    /// Titre ou artiste simplifié : sans accents, ni mentions entre parenthèses, ni ponctuation.
    private static func artworkKey(_ text: String) -> String {
        var value = text.folding(options: [.caseInsensitive, .diacriticInsensitive], locale: nil)
        value = value.replacingOccurrences(of: #"\s*[\(\[][^\)\]]*[\)\]]"#, with: "", options: .regularExpression)
        value = value.replacingOccurrences(of: #"(?i)\b(official|clip|video|lyrics?|audio|visualizer)\b"#, with: "",
                                           options: .regularExpression)
        return value.unicodeScalars.filter { CharacterSet.alphanumerics.contains($0) }.map(String.init).joined()
    }
}
