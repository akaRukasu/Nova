import Foundation

// Diagnostic lancé par GitHub Actions : appelle chaque fonction du client
// YouTube Music et affiche ce que Nova en comprend.

nonisolated(unsafe) var lastResponse: [String: Any] = [:]
InnerTubeClient.debugHook = { endpoint, body, data in
    let json = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] ?? [:]
    lastResponse = json
    print("    ↳ \(endpoint) \(body["browseId"] ?? body["query"] ?? body["videoId"] ?? "") : \(data.count) octets")
}

let client = InnerTubeClient()

/// Liste des renderers présents dans une réponse, pour comprendre sa structure.
func rendererSummary(_ object: Any) -> String {
    var counts: [String: Int] = [:]
    func walk(_ value: Any, depth: Int) {
        if let dict = value as? [String: Any] {
            for (key, child) in dict {
                if key.hasSuffix("Renderer") || key.hasSuffix("Model") || key.hasSuffix("ViewModel") { counts[key, default: 0] += 1 }
                walk(child, depth: depth + 1)
            }
        } else if let array = value as? [Any] {
            array.forEach { walk($0, depth: depth + 1) }
        }
    }
    walk(object, depth: 0)
    return counts.sorted { $0.value > $1.value }.prefix(40).map { "\($0.key)×\($0.value)" }.joined(separator: ", ")
}

func describe(_ item: MusicItem) -> String {
    switch item {
    case .track(let t):
        return "♪ \(t.title) — artiste=\"\(t.artist)\" artistID=\(t.artistID ?? "-") album=\(t.album ?? "-") albumID=\(t.albumID ?? "-") durée=\(t.duration.map { $0.clockString } ?? "-") art=\(t.artworkURL != nil)"
    case .collection(let c):
        return "▣ [\(c.kind)] \(c.title) — \"\(c.subtitle)\" id=\(c.id) art=\(c.artworkURL != nil)"
    }
}

func show(_ shelves: [Shelf], items: Int = 3) {
    print("  \(shelves.count) étagère(s)")
    for shelf in shelves {
        print("  [\(shelf.layout)] « \(shelf.title) » : \(shelf.items.count) élément(s), plus=\(shelf.more.map { "\($0.browseID) \($0.params ?? "")" } ?? "-"), suite=\(shelf.continuation != nil)")
        for item in shelf.items.prefix(items) { print("      " + describe(item)) }
    }
    if shelves.isEmpty { print("  RENDERERS : " + rendererSummary(lastResponse)) }
}

func header(_ header: PageHeader) {
    print("  en-tête : titre=\"\(header.title)\" sous-titre=\"\(header.subtitle)\" artiste=\(header.artist ?? "-") artistID=\(header.artistID ?? "-") second=\"\(header.secondSubtitle)\" description=\(header.description?.prefix(60) ?? "-") image=\(header.artworkURL?.absoluteString.prefix(80) ?? "-")")
}

func step(_ title: String, _ body: () async throws -> Void) async {
    print("\n=== \(title)")
    do { try await body() } catch {
        print("  ERREUR : \(error)")
        print("  RENDERERS : " + rendererSummary(lastResponse))
    }
}

var artist: MusicCollection?
var album: MusicCollection?
var playlist: MusicCollection?
var song: Track?
let query = ProcessInfo.processInfo.environment["NOVA_QUERY"] ?? "daft punk"

await step("Suggestions") {
    print("  " + (try await client.suggestions(String(query.prefix(6)))).joined(separator: " | "))
}

await step("Recherche « Tout »") {
    let shelves = try await client.search(query, scope: .all)
    show(shelves)
    print("  RENDERERS : " + rendererSummary(lastResponse))
    // Clés des sections de la recherche, dans l'ordre.
    if let list = JSONWalk.first("sectionListRenderer", in: lastResponse) as? [String: Any],
       let contents = list["contents"] as? [[String: Any]] {
        for section in contents {
            let key = section.keys.sorted().joined(separator: ",")
            let inner = (section.values.first as? [String: Any])?.keys.sorted().joined(separator: ",") ?? ""
            print("  section : \(key) → \(inner)")
            if let inner = section["itemSectionRenderer"] as? [String: Any],
               let contents = inner["contents"] as? [[String: Any]] {
                print("    contenu : " + contents.map { $0.keys.sorted().joined(separator: "+") }.joined(separator: ", "))
                if let first = contents.first,
                   let data = try? JSONSerialization.data(withJSONObject: first, options: [.sortedKeys]),
                   let text = String(data: data, encoding: .utf8) {
                    print("    " + text.prefix(2500))
                }
            }
            if let shelf = section["musicShelfRenderer"] as? [String: Any],
               let first = (shelf["contents"] as? [[String: Any]])?.first {
                print("    premier élément : \(first.keys.sorted())")
                if let data = try? JSONSerialization.data(withJSONObject: first, options: [.sortedKeys]),
                   let text = String(data: data, encoding: .utf8) {
                    print("    " + text.prefix(1500))
                }
            }
        }
    }
    if let card = JSONWalk.first("musicCardShelfRenderer", in: lastResponse) as? [String: Any],
       let item = (card["contents"] as? [[String: Any]])?.dropFirst().first,
       let data = try? JSONSerialization.data(withJSONObject: item, options: [.sortedKeys]),
       let text = String(data: data, encoding: .utf8) {
        print("  élément de la carte : " + text.prefix(2500))
    }
}

for scope in SearchScope.allCases where scope != .all {
    await step("Recherche « \(scope.rawValue) »") {
        let shelves = try await client.search(query, scope: scope)
        show(shelves, items: 4)
        let items = shelves.flatMap(\.items)
        for item in items {
            switch item {
            case .track(let t): if song == nil, scope == .songs { song = t }
            case .collection(let c):
                if c.kind == .artist, artist == nil { artist = c }
                if c.kind == .album, album == nil { album = c }
                if c.kind == .playlist, playlist == nil { playlist = c }
            }
        }
    }
}

var moreLink: BrowseLink?
await step("Accueil") {
    let page = try await client.home()
    show(page.shelves, items: 2)
    print("  suite de l'accueil : \(page.continuation != nil)")
    if let list = JSONWalk.first("sectionListRenderer", in: lastResponse) as? [String: Any],
       let data = try? JSONSerialization.data(withJSONObject: list["continuations"] ?? [], options: [.sortedKeys]),
       let text = String(data: data, encoding: .utf8) {
        print("  continuations : " + text.prefix(600))
    }
    if let token = page.continuation {
        for style in InnerTubeClient.ContinuationStyle.allCases {
            let json = try await client.continuation(token, browseID: "FEmusic_home", style: style)
            print("  style \(style) : \(InnerTubeParser.shelves(in: json).count) étagère(s) — " + rendererSummary(json).prefix(200))
        }
        let next = try await client.browseContinuation(token)
        print("  -- page suivante")
        show(next.shelves, items: 1)
    }
}

if let artist {
    await step("Artiste \(artist.title) (\(artist.id))") {
        let page = try await client.browse(BrowseLink(browseID: artist.id))
        header(page.header)
        show(page.shelves, items: 2)
        moreLink = page.shelves.first { $0.layout == .cards && $0.more != nil }?.more
        if album == nil {
            album = page.shelves.flatMap(\.items).compactMap { item -> MusicCollection? in
                if case .collection(let c) = item, c.kind == .album { return c } else { return nil }
            }.first
        }
    }
    await step("Tous les titres de l'artiste") {
        let tracks = try await client.allTracks(of: artist)
        print("  \(tracks.count) titre(s)")
        tracks.prefix(3).forEach { print("      " + describe(.track($0))) }
    }
}

if let moreLink {
    await step("« Tout afficher » \(moreLink.browseID)") {
        let page = try await client.browse(moreLink)
        show(page.shelves, items: 3)
    }
}

if let album {
    await step("Album \(album.title) (\(album.id))") {
        let content = try await client.collection(album.id)
        header(content.header)
        print("  \(content.tracks.count) titre(s), suite=\(content.continuation != nil)")
        content.tracks.prefix(3).forEach { print("      " + describe(.track($0))) }
        show(content.related, items: 1)
    }
}

if let playlist {
    await step("Playlist \(playlist.title) (\(playlist.id))") {
        let content = try await client.collection(playlist.id)
        header(content.header)
        print("  \(content.tracks.count) titre(s), suite=\(content.continuation != nil)")
        content.tracks.prefix(3).forEach { print("      " + describe(.track($0))) }
        let all = try await client.allTracks(of: playlist)
        print("  au total : \(all.count) titre(s)")
    }
}

if let song {
    await step("Radio de \(song.title)") {
        let radio = try await client.radio(for: song.id)
        print("  \(radio.count) titre(s)")
        radio.prefix(3).forEach { print("      " + describe(.track($0))) }
    }
    await step("Paroles de \(song.title)") {
        if let lyrics = try await client.lyrics(for: song.id) {
            print("  \(lyrics.text.count) caractères, source=\(lyrics.source ?? "-")")
            print("  " + lyrics.text.prefix(120).replacingOccurrences(of: "\n", with: " / "))
        } else {
            print("  aucune parole")
        }
    }
}

// MARK: - Import depuis les autres plateformes

let links = [
    "https://open.spotify.com/playlist/37i9dQZF1DXcBWIGoYBM5M",
    "https://open.spotify.com/album/2noRn2Aes5aoNVsU6iWThc",
    "https://www.deezer.com/fr/album/302127",
    "https://www.deezer.com/fr/playlist/1109890291",
    "https://music.apple.com/fr/album/discovery/697194953",
    "https://music.apple.com/us/playlist/todays-hits/pl.f4d106fed2bd41149aaacabb233eb5eb",
    "https://music.youtube.com/playlist?list=RDCLAK5uy_kf6c8Ga41e1bLKYCaulkiZ1NIVYJnr3Jk",
]
var toMatch: [ImportedTrack] = []
for link in links {
    await step("Import du lien \(link)") {
        let playlists = try await ImportSources.fromLink(link, client: client)
        for playlist in playlists {
            print("  « \(playlist.name) » (\(playlist.source)) : \(playlist.count) titre(s)")
            playlist.tracks.prefix(3).forEach { print("      \($0.label) | album=\($0.album ?? "-") durée=\($0.duration.map { $0.clockString } ?? "-")") }
            playlist.youTubeTracks?.prefix(2).forEach { print("      " + describe(.track($0))) }
            if toMatch.count < 8 { toMatch += playlist.tracks.prefix(4) }
        }
    }
}

await step("Lecture d'un CSV (Exportify / TuneMyMusic)") {
    let csv = """
    "Track Name","Artist Name(s)","Album Name","Duration (ms)","Playlist name"
    "Get Lucky (feat. Pharrell Williams and Nile Rodgers)","Daft Punk;Pharrell Williams;Nile Rodgers","Random Access Memories","369626","Mes favoris"
    "Alors on danse","Stromae","Cheese","206000","Mes favoris"
    "Nightcall","Kavinsky","OutRun","258000","Chill"
    """
    let playlists = try ImportSources.fromFile(Data(csv.utf8), fileName: "export.csv")
    for playlist in playlists {
        print("  « \(playlist.name) » : \(playlist.tracks.map(\.label).joined(separator: " | "))")
        toMatch += playlist.tracks
    }
    let text = "Daft Punk - One More Time\nStromae – Papaoutai\n"
    let lines = try ImportSources.fromFile(Data(text.utf8), fileName: "liste.txt")
    print("  TXT : " + lines.flatMap(\.tracks).map(\.label).joined(separator: " | "))
}

await step("Correspondance avec YouTube Music") {
    for track in toMatch {
        if let found = await TrackMatcher.match(track, client: client) {
            print("  ✓ \(track.label)  →  \(found.artist) — \(found.title) (\(found.id))")
        } else {
            print("  ✗ \(track.label)")
        }
    }
}

print("\nTerminé.")
