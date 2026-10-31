import Foundation

typealias JSONObject = [String: Any]

/// Transforme les réponses InnerTube en modèles Nova.
/// La structure du JSON change souvent : on s'appuie sur les noms des « renderers »
/// et sur les liens de navigation plutôt que sur des positions fixes.
enum InnerTubeParser {
    // MARK: - Texte et liens

    struct Run {
        let text: String
        var browseID: String?
        var pageType: String?
        var videoID: String?

        var kind: CollectionKind? { InnerTubeParser.kind(pageType: pageType, browseID: browseID) }
    }

    static func runs(_ object: Any?) -> [Run] {
        guard let dict = object as? JSONObject else { return [] }
        if let simple = dict["simpleText"] as? String { return [Run(text: simple)] }
        let raw = (dict["runs"] as? [JSONObject]) ?? []
        return raw.compactMap { run in
            guard let text = run["text"] as? String else { return nil }
            let navigation = run["navigationEndpoint"] as? JSONObject
            let browse = navigation?["browseEndpoint"] as? JSONObject
            return Run(text: text,
                       browseID: browse?["browseId"] as? String,
                       pageType: pageType(of: browse),
                       videoID: (navigation?["watchEndpoint"] as? JSONObject)?["videoId"] as? String)
        }
    }

    static func text(_ object: Any?) -> String {
        runs(object).map(\.text).joined()
    }

    static func pageType(of browse: JSONObject?) -> String? {
        let configs = browse?["browseEndpointContextSupportedConfigs"] as? JSONObject
        let music = configs?["browseEndpointContextMusicConfig"] as? JSONObject
        return music?["pageType"] as? String
    }

    static func kind(pageType: String?, browseID: String?) -> CollectionKind? {
        switch pageType ?? "" {
        case "MUSIC_PAGE_TYPE_ARTIST", "MUSIC_PAGE_TYPE_USER_CHANNEL", "MUSIC_PAGE_TYPE_LIBRARY_ARTIST":
            return .artist
        case "MUSIC_PAGE_TYPE_ALBUM", "MUSIC_PAGE_TYPE_AUDIOBOOK":
            return .album
        case "MUSIC_PAGE_TYPE_PLAYLIST":
            return .playlist
        case "":
            guard let id = browseID else { return nil }
            if id.hasPrefix("UC") { return .artist }
            if id.hasPrefix("MPREb") { return .album }
            if id.hasPrefix("VL") { return .playlist }
            return nil
        default:
            // Podcasts, épisodes… : non pris en charge.
            return nil
        }
    }

    /// Mots qui indiquent le type d'un résultat de recherche (« Titre • Artiste • … »).
    private static let typeLabels: Set<String> = [
        "Titre", "Titres", "Vidéo", "Vidéos", "Song", "Songs", "Video", "Videos", "Épisode", "Episode",
        "Single", "Album", "EP", "Playlist", "Artiste", "Artist", "Podcast", "Profil", "Profile",
    ]

    /// Résultats ignorés : podcasts, épisodes, profils.
    private static let skippedLabels: Set<String> = ["Podcast", "Épisode", "Episode", "Profil", "Profile"]

    /// « 98 M lectures », « 2,4 k vues »… : statistiques, pas des noms.
    static func isStatistic(_ text: String) -> Bool {
        text.range(of: #"(lecture|vue|view|play|auditeur|abonné|subscriber|listener|titre|track|song|écoute)s?(/mois)?$"#,
                   options: [.regularExpression, .caseInsensitive]) != nil
            && text.rangeOfCharacter(from: .decimalDigits) != nil
    }

    struct Meta {
        var artist: String?
        var artistID: String?
        var album: String?
        var albumID: String?
        var duration: TimeInterval?
        var other: [String] = []
    }

    /// Découpe « Artiste • Album • 3:45 » en champs, grâce aux liens de chaque morceau.
    static func meta(_ runs: [Run]) -> Meta {
        var segments: [[Run]] = [[]]
        for run in runs {
            let pieces = run.text.components(separatedBy: "•")
            for (offset, piece) in pieces.enumerated() {
                if offset > 0 { segments.append([]) }
                if pieces.count == 1 {
                    segments[segments.count - 1].append(run)
                } else if !piece.trimmingCharacters(in: .whitespaces).isEmpty {
                    segments[segments.count - 1].append(Run(text: piece, browseID: run.browseID,
                                                            pageType: run.pageType, videoID: run.videoID))
                }
            }
        }

        var meta = Meta()
        for segment in segments {
            let text = segment.map(\.text).joined().trimmingCharacters(in: .whitespaces)
            guard !text.isEmpty else { continue }
            if meta.artist == nil, let link = segment.first(where: { $0.kind == .artist }) {
                meta.artist = text
                meta.artistID = link.browseID
            } else if meta.album == nil, let link = segment.first(where: { $0.kind == .album }) {
                meta.album = text
                meta.albumID = link.browseID
            } else if meta.duration == nil, text.contains(":"), let duration = TimeInterval(clockString: text) {
                meta.duration = duration
            } else if !isStatistic(text) {
                meta.other.append(text)
            }
        }
        if meta.artist == nil, let guess = meta.other.firstIndex(where: { !typeLabels.contains($0) }) {
            meta.artist = meta.other.remove(at: guess)
        }
        return meta
    }

    private static func separator() -> Run { Run(text: " • ") }

    // MARK: - Images

    /// Plus grande miniature. `upscale` agrandit les images Google redimensionnables.
    static func thumbnail(_ object: Any?, upscale: Bool = true) -> URL? {
        guard let object,
              let thumbs = JSONWalk.first("thumbnails", in: object) as? [JSONObject],
              var raw = thumbs.last?["url"] as? String else { return nil }
        if raw.hasPrefix("//") { raw = "https:" + raw }
        if upscale {
            raw = raw.replacingOccurrences(of: #"=w\d+-h\d+"#, with: "=w544-h544", options: .regularExpression)
        }
        return URL(string: raw)
    }

    // MARK: - Éléments

    static func item(fromRenderer wrapper: JSONObject) -> MusicItem? {
        if let renderer = wrapper["musicResponsiveListItemRenderer"] as? JSONObject { return responsiveItem(renderer) }
        if let renderer = wrapper["musicTwoRowItemRenderer"] as? JSONObject { return twoRowItem(renderer) }
        return nil
    }

    /// Ligne de liste (résultats de recherche, titres d'un album ou d'une playlist…).
    static func responsiveItem(_ renderer: JSONObject) -> MusicItem? {
        let columns = (renderer["flexColumns"] as? [JSONObject]) ?? []
        let columnRuns = columns.map { column in
            runs((column["musicResponsiveListItemFlexColumnRenderer"] as? JSONObject)?["text"])
        }
        let title = (columnRuns.first ?? []).map(\.text).joined().trimmingCharacters(in: .whitespaces)
        guard !title.isEmpty else { return nil }

        var detail: [Run] = []
        for column in columnRuns.dropFirst() where !column.isEmpty {
            if !detail.isEmpty { detail.append(separator()) }
            detail += column
        }
        let fixed = ((renderer["fixedColumns"] as? [JSONObject]) ?? []).flatMap { column in
            runs((column["musicResponsiveListItemFixedColumnRenderer"] as? JSONObject)?["text"])
        }
        let artwork = thumbnail(renderer["thumbnail"])
        if let label = columnRuns.dropFirst().first?.first?.text, skippedLabels.contains(label) { return nil }

        if let browse = (renderer["navigationEndpoint"] as? JSONObject)?["browseEndpoint"] as? JSONObject,
           let id = browse["browseId"] as? String {
            guard let kind = kind(pageType: pageType(of: browse), browseID: id) else { return nil }
            return .collection(MusicCollection(id: id, kind: kind, title: title,
                                               subtitle: detail.map(\.text).joined(), artworkURL: artwork))
        }

        if (renderer["musicItemRendererDisplayPolicy"] as? String) == "MUSIC_ITEM_RENDERER_DISPLAY_POLICY_GREY_OUT" {
            return nil
        }
        let videoID = ((renderer["playlistItemData"] as? JSONObject)?["videoId"] as? String)
            ?? columnRuns.first?.compactMap(\.videoID).first
            ?? (JSONWalk.first("watchEndpoint", in: renderer["overlay"] ?? JSONObject()) as? JSONObject)?["videoId"] as? String
        guard let videoID else {
            // Playlist sans lien direct : on prend son identifiant dans le menu « Lecture aléatoire ».
            if let watch = JSONWalk.first("watchPlaylistEndpoint", in: renderer) as? JSONObject,
               let playlistID = watch["playlistId"] as? String, !playlistID.hasPrefix("RDAM") {
                return .collection(MusicCollection(id: "VL" + playlistID, kind: .playlist, title: title,
                                                   subtitle: detail.map(\.text).joined(), artworkURL: artwork))
            }
            return nil
        }

        let info = meta(fixed.isEmpty ? detail : detail + [separator()] + fixed)
        return .track(Track(id: videoID, title: title, artist: info.artist ?? "", album: info.album,
                            duration: info.duration, artworkURL: artwork,
                            artistID: info.artistID, albumID: info.albumID))
    }

    /// Carte (carrousels de l'accueil et des pages artiste).
    static func twoRowItem(_ renderer: JSONObject) -> MusicItem? {
        let title = text(renderer["title"]).trimmingCharacters(in: .whitespaces)
        guard !title.isEmpty else { return nil }
        return item(navigation: renderer["navigationEndpoint"] as? JSONObject,
                    title: title,
                    subtitleRuns: runs(renderer["subtitle"]),
                    artwork: thumbnail(renderer["thumbnailRenderer"]))
    }

    static func item(navigation: JSONObject?, title: String, subtitleRuns: [Run], artwork: URL?) -> MusicItem? {
        let subtitle = subtitleRuns.map(\.text).joined()
        if let browse = navigation?["browseEndpoint"] as? JSONObject, let id = browse["browseId"] as? String {
            guard let kind = kind(pageType: pageType(of: browse), browseID: id) else { return nil }
            return .collection(MusicCollection(id: id, kind: kind, title: title, subtitle: subtitle, artworkURL: artwork))
        }
        if let watch = navigation?["watchEndpoint"] as? JSONObject, let videoID = watch["videoId"] as? String {
            let info = meta(subtitleRuns)
            return .track(Track(id: videoID, title: title, artist: info.artist ?? "", album: info.album,
                                duration: info.duration, artworkURL: artwork,
                                artistID: info.artistID, albumID: info.albumID))
        }
        if let watch = navigation?["watchPlaylistEndpoint"] as? JSONObject,
           let playlistID = watch["playlistId"] as? String,
           ["PL", "OLAK", "RDCLAK", "VL"].contains(where: { playlistID.hasPrefix($0) }) {
            let id = playlistID.hasPrefix("VL") ? playlistID : "VL" + playlistID
            return .collection(MusicCollection(id: id, kind: .playlist, title: title, subtitle: subtitle, artworkURL: artwork))
        }
        return nil
    }

    // MARK: - Étagères

    private static let shelfKeys: Set<String> = [
        "musicShelfRenderer", "musicPlaylistShelfRenderer", "musicCarouselShelfRenderer",
        "gridRenderer", "musicCardShelfRenderer",
    ]

    /// Toutes les étagères d'une réponse, dans l'ordre de la page.
    static func shelves(in object: Any) -> [Shelf] {
        var found: [Shelf] = []
        collectShelves(object, into: &found)
        return found.filter { !$0.items.isEmpty || $0.id.hasPrefix("flat") }
    }

    private static func collectShelves(_ object: Any, into found: inout [Shelf]) {
        if let array = object as? [Any] {
            for value in array { collectShelves(value, into: &found) }
            return
        }
        guard let dict = object as? JSONObject else { return }

        if let shelf = dict["musicShelfRenderer"] as? JSONObject {
            found.append(listShelf(shelf, id: found.count, title: text(shelf["title"]),
                                   more: link(shelf["bottomEndpoint"])))
        }
        if let shelf = dict["musicPlaylistShelfRenderer"] as? JSONObject {
            found.append(listShelf(shelf, id: found.count, title: "", more: nil))
        }
        if let shelf = dict["musicCarouselShelfRenderer"] as? JSONObject {
            let header = (shelf["header"] as? JSONObject)?["musicCarouselShelfBasicHeaderRenderer"] as? JSONObject
            let items = unique(((shelf["contents"] as? [JSONObject]) ?? []).compactMap(item(fromRenderer:)))
            let usesRows = ((shelf["contents"] as? [JSONObject])?.first?["musicResponsiveListItemRenderer"]) != nil
            let more = link(((header?["moreContentButton"] as? JSONObject)?["buttonRenderer"] as? JSONObject)?["navigationEndpoint"])
                ?? link(header?["title"].flatMap { JSONWalk.first("navigationEndpoint", in: $0) })
            found.append(Shelf(id: "\(found.count)", title: text(header?["title"]), items: items,
                               layout: usesRows ? .grid : .cards, more: more))
        }
        if let grid = dict["gridRenderer"] as? JSONObject {
            let header = (grid["header"] as? JSONObject)?["gridHeaderRenderer"] as? JSONObject
            let items = unique(((grid["items"] as? [JSONObject]) ?? []).compactMap(item(fromRenderer:)))
            found.append(Shelf(id: "\(found.count)", title: text(header?["title"]), items: items, layout: .cards))
        }
        if let card = dict["musicCardShelfRenderer"] as? JSONObject {
            found.append(topResultShelf(card, id: found.count))
        }
        // Recherche « Tout » (2026) : une section par résultat, sans étagère.
        var skipped = shelfKeys
        if let section = dict["itemSectionRenderer"] as? JSONObject,
           let contents = section["contents"] as? [JSONObject],
           contents.contains(where: { $0["musicResponsiveListItemRenderer"] != nil }) {
            let items = contents.compactMap(item(fromRenderer:))
            if let last = found.last, last.id.hasPrefix("flat") {
                found[found.count - 1].items += items
            } else {
                found.append(Shelf(id: "flat\(found.count)", title: "", items: items, layout: .list))
            }
            skipped.insert("itemSectionRenderer")
        }

        for key in dict.keys.sorted() where !skipped.contains(key) {
            collectShelves(dict[key]!, into: &found)
        }
    }

    private static func listShelf(_ shelf: JSONObject, id: Int, title: String, more: BrowseLink?) -> Shelf {
        let contents = (shelf["contents"] as? [JSONObject]) ?? []
        let items = contents.compactMap(item(fromRenderer:))
        let token = contents.last.flatMap { $0["continuationItemRenderer"] }.flatMap(continuationToken(in:))
            ?? shelf["continuations"].flatMap(continuationToken(in:))
        return Shelf(id: "\(id)", title: title, items: items, layout: .list, more: more, continuation: token)
    }

    /// « Meilleur résultat » de la recherche.
    private static func topResultShelf(_ card: JSONObject, id: Int) -> Shelf {
        var items: [MusicItem] = []
        let titleRuns = ((card["title"] as? JSONObject)?["runs"] as? [JSONObject]) ?? []
        let navigation = (titleRuns.first?["navigationEndpoint"] as? JSONObject) ?? (card["onTap"] as? JSONObject)
        if let main = item(navigation: navigation, title: text(card["title"]),
                           subtitleRuns: runs(card["subtitle"]), artwork: thumbnail(card["thumbnail"])) {
            items.append(main)
        }
        var extra = ((card["contents"] as? [JSONObject]) ?? []).compactMap(item(fromRenderer:))
        if case .collection(let artist)? = items.first, artist.kind == .artist {
            extra = extra.map { item in
                guard case .track(var track) = item, track.artist.isEmpty else { return item }
                track.artist = artist.title
                track.artistID = artist.id
                return .track(track)
            }
        }
        items += extra
        let header = (card["header"] as? JSONObject)?["musicCardShelfHeaderBasicRenderer"] as? JSONObject
        let title = text(header?["title"])
        return Shelf(id: "\(id)", title: title.isEmpty ? "Meilleur résultat" : title,
                     items: unique(items), layout: .list)
    }

    static func link(_ object: Any?) -> BrowseLink? {
        guard let dict = object as? JSONObject,
              let browse = (dict["browseEndpoint"] as? JSONObject) ?? (JSONWalk.first("browseEndpoint", in: dict) as? JSONObject),
              let id = browse["browseId"] as? String else { return nil }
        return BrowseLink(browseID: id, params: browse["params"] as? String)
    }

    static func unique(_ items: [MusicItem]) -> [MusicItem] {
        var seen = Set<String>()
        return items.filter { seen.insert($0.id).inserted }
    }

    // MARK: - Continuations

    static func continuationToken(in object: Any) -> String? {
        if let command = JSONWalk.first("continuationCommand", in: object) as? JSONObject,
           let token = command["token"] as? String { return token }
        if let data = JSONWalk.first("nextContinuationData", in: object) as? JSONObject,
           let token = data["continuation"] as? String { return token }
        return nil
    }

    /// Jeton pour charger la suite d'une page à sections (accueil).
    static func sectionContinuation(in json: JSONObject) -> String? {
        let list = (JSONWalk.first("sectionListContinuation", in: json) as? JSONObject)
            ?? (JSONWalk.first("sectionListRenderer", in: json) as? JSONObject)
        return list?["continuations"].flatMap(continuationToken(in:))
    }

    // MARK: - En-têtes

    static func header(in json: JSONObject) -> PageHeader {
        let keys = ["musicImmersiveHeaderRenderer", "musicVisualHeaderRenderer",
                    "musicResponsiveHeaderRenderer", "musicDetailHeaderRenderer"]
        guard let key = keys.first(where: { JSONWalk.first($0, in: json) != nil }),
              let renderer = JSONWalk.first(key, in: json) as? JSONObject else {
            return PageHeader()
        }

        var header = PageHeader()
        header.title = text(renderer["title"])
        let subtitleRuns = runs(renderer["subtitle"])
        header.subtitle = subtitleRuns.map(\.text).joined()
        header.secondSubtitle = text(renderer["secondSubtitle"])

        let strapline = runs(renderer["straplineTextOne"])
        if !strapline.isEmpty {
            header.artist = strapline.map(\.text).joined()
            header.artistID = strapline.first(where: { $0.kind == .artist })?.browseID
        } else if key == "musicDetailHeaderRenderer" {
            let info = meta(subtitleRuns)
            header.artist = info.artist
            header.artistID = info.artistID
        }

        if let description = renderer["description"] {
            var value = text(description)
            if value.isEmpty, let shelf = JSONWalk.first("musicDescriptionShelfRenderer", in: description) as? JSONObject {
                value = text(shelf["description"])
            }
            header.description = value.isEmpty ? nil : value
        }

        if key == "musicImmersiveHeaderRenderer" || key == "musicVisualHeaderRenderer" {
            // Bannière large de l'artiste : on garde la taille d'origine.
            header.artworkURL = thumbnail(renderer["thumbnail"], upscale: false)
                ?? thumbnail(renderer["foregroundThumbnail"])
        } else {
            header.artworkURL = thumbnail(renderer["thumbnail"])
        }
        return header
    }
}

/// Parcours générique du JSON d'InnerTube.
enum JSONWalk {
    /// Tous les objets rangés sous `key`, dans l'ordre des tableaux.
    static func collect(_ key: String, in object: Any) -> [JSONObject] {
        var found: [JSONObject] = []
        walk(object) { dict in
            if let value = dict[key] as? JSONObject { found.append(value) }
        }
        return found
    }

    /// Première valeur trouvée sous `key`.
    static func first(_ key: String, in object: Any) -> Any? {
        if let dict = object as? JSONObject {
            if let value = dict[key] { return value }
            for name in dict.keys.sorted() {
                if let hit = first(key, in: dict[name]!) { return hit }
            }
        } else if let array = object as? [Any] {
            for value in array { if let hit = first(key, in: value) { return hit } }
        }
        return nil
    }

    private static func walk(_ object: Any, _ visit: (JSONObject) -> Void) {
        if let dict = object as? JSONObject {
            visit(dict)
            // Clés triées pour un ordre stable entre deux appels.
            for key in dict.keys.sorted() { walk(dict[key]!, visit) }
        } else if let array = object as? [Any] {
            for value in array { walk(value, visit) }
        }
    }
}
