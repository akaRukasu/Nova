import Foundation

final class ReleasePagesProtocol: URLProtocol, @unchecked Sendable {
    override class func canInit(with request: URLRequest) -> Bool {
        guard let url = request.url else { return false }
        let query = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems
        if url.host == "musicbrainz.org" { return query?.contains { $0.value?.contains("Nova Release QA & Duo") == true } == true }
        guard url.host == "api.deezer.com" else { return false }
        return url.path == "/artist/-4242/albums" || query?.first(where: { $0.name == "q" })?.value == "Nova Release QA & Duo"
    }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func stopLoading() {}
    override func startLoading() {
        let url = request.url!
        let artist: [String: Any] = ["id": -4242, "name": "Nova Release QA & Duo"]
        let json: [String: Any]
        if url.host == "musicbrainz.org" {
            let future = String(ISO8601DateFormatter().string(from: Date().addingTimeInterval(40 * 86_400)).prefix(10))
            let credits: [[String: Any]] = [["artist": ["name": "Nova Release QA & Duo"]]]
            json = ["count": 2, "release-groups": [
                ["id": "11111111-2222-3333-4444-555555555555", "title": "Album annoncé", "first-release-date": future, "primary-type": "Album", "artist-credit": credits],
                ["id": "22222222-2222-3333-4444-555555555555", "title": "Date encore incomplète", "first-release-date": "2099-12", "primary-type": "Album", "artist-credit": credits]
            ]]
        } else if url.path == "/search/artist" {
            json = ["data": [["id": -1, "name": "Autre artiste"], artist]]
        } else if url.query?.contains("index=100") == true {
            let today = ISO8601DateFormatter().string(from: Date()).prefix(10)
            json = ["data": [["id": -4242, "title": "Sortie récente en deuxième page", "artist": artist,
                              "release_date": String(today), "record_type": "single"]]]
        } else {
            let old: [[String: Any]] = (0..<100).map { ["id": $0, "title": "Ancienne sortie", "release_date": "2000-01-01"] }
            json = ["data": old, "next": "https://api.deezer.com/artist/-4242/albums?limit=100&index=100"]
        }
        let data = try! JSONSerialization.data(withJSONObject: json)
        client?.urlProtocol(self, didReceive: HTTPURLResponse(url: url, statusCode: 200, httpVersion: nil, headerFields: nil)!, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: data)
        client?.urlProtocolDidFinishLoading(self)
    }
}

func require(_ value: @autoclosure () -> Bool, _ message: String) throws {
    if !value() { throw NSError(domain: "NovaOctaveRegression", code: 1, userInfo: [NSLocalizedDescriptionKey: message]) }
}

do {
    URLProtocol.registerClass(ReleasePagesProtocol.self)
    let recentReleases = try await ReleasesService.releases(artistNames: ["Nova Release QA & Duo"], since: Date().addingTimeInterval(-30 * 86_400))
    try require(recentReleases.count == 2 && recentReleases.contains { $0.id == -4242 && $0.type == "single" }, "Les sorties récentes doivent être cherchées après les 100 premiers disques et chez le bon artiste")
    try require(recentReleases.filter(\.isUpcoming).count == 1 && recentReleases.first?.title == "Album annoncé", "Les sorties annoncées après sept jours doivent apparaître avec une date complète")
    URLProtocol.unregisterClass(ReleasePagesProtocol.self)
    print("Sorties OK — artiste exact, caractère &, pagination complète et singles récents")
    let restoredLibrary = await LibraryStore()
    let backupData = try Data(contentsOf: URL(fileURLWithPath: "Tools/Fixtures/pc-library-backup.json"))
    _ = try await restoredLibrary.restoreData(backupData)
    _ = try await restoredLibrary.restoreData(backupData)
    let restoredPlaylists = await restoredLibrary.playlists.filter { $0.name == "Restauration PC QA" }
    try require(restoredPlaylists.count == 1 && restoredPlaylists[0].tracks.count == 2, "La sauvegarde PC doit se restaurer deux fois sans doublon")
    let restoredDate = restoredPlaylists[0].createdAt.timeIntervalSince1970
    try require(abs(restoredDate - 1789999995) < 0.001, "La restauration conserve la date d’ajout du PC")
    let restoredCount = await restoredLibrary.stats["pc-backup-song"]?.playCount
    let annualCount = await restoredLibrary.listeningYears["2026"]?["pc-backup-song"]?.plays
    try require(restoredCount == 7 && annualCount == 7, "La restauration garde les statistiques et le récap annuel sans multiplier les écoutes")
    let restoredSmart = await restoredLibrary.smartPlaylists.first { $0.name == "Favoris sauvegardés QA" }
    try require(restoredSmart?.rules.first?.op == .isTrue, "Les règles de playlists intelligentes du PC restent lisibles")
    print("Restauration PC vers iPhone OK — dates, playlists, favoris, historique et récap annuel sans doublons")
    let playlistOnly = Track(id: "delete-playlist-only", title: "Titre à retirer", artist: "Artiste QA")
    _ = await restoredLibrary.importIntoPlaylist(name: "Suppression QA", tracks: [playlistOnly])
    let staleLibrary = await restoredLibrary.exportData()!
    let playlistMembership = await restoredLibrary.isInLibrary(playlistOnly.id)
    try require(playlistMembership, "Un titre présent uniquement dans une playlist appartient à la bibliothèque")
    await restoredLibrary.removeFromLibrary(playlistOnly)
    _ = try await restoredLibrary.restoreData(staleLibrary)
    let absent = await restoredLibrary.isInLibrary(playlistOnly.id)
    try require(!absent, "Une ancienne sauvegarde ne doit pas ressusciter un titre retiré")
    await restoredLibrary.addToLibrary(playlistOnly)
    _ = try await restoredLibrary.restoreData(staleLibrary)
    let readded = await restoredLibrary.isInLibrary(playlistOnly.id)
    try require(readded, "Un réajout explicite doit rester présent après synchronisation")
    print("Suppression depuis une playlist, sauvegarde obsolète et réajout confirmés")

    let octaveBackup = Data(#"""
    {"app":"octave","type":"library-backup","version":2,"data":{"octave:library":{"state":{"playlists":[
      {"id":"one","name":"Import Octave QA","createdAt":1794000000000,"tracks":[{"id":"42","title":"Studio","artist":{"name":"Artiste QA"},"duration":180,"album":{"id":91,"title":"Album QA"}}]},
      {"id":"two","name":"import Octave QA","createdAt":1794100000000,"tracks":[{"id":"42","title":"Studio","artist":{"name":"Artiste QA"},"album":{"id":91,"title":"Album QA"}},{"id":43,"title":"Studio (Live)","artist":{"name":"Artiste QA"},"album":{"id":93,"title":"Album live"}}]}
    ]}}}}
    """#.utf8)
    let octaveState = try OctaveBackup.read(octaveBackup)
    _ = await restoredLibrary.importOctaveBackup(octaveState)
    _ = await restoredLibrary.importOctaveBackup(octaveState)
    let merged = await restoredLibrary.playlists.filter { $0.name == "Import Octave QA" }
    try require(merged.count == 1 && merged[0].tracks.map(\.id) == ["octave:42", "octave:43"], "Les deux imports Octave gardent les versions distinctes sans doublon")
    try require(merged[0].tracks[0].albumID == "octave:91", "L’identifiant de l’album Octave doit rester disponible pour la lecture")

    let concertDate = ISO8601DateFormatter().date(from: "2027-01-23T19:30:00Z")!
    let tmConcert = Concert(id: "ticketmaster:1", name: "ULTRA VOMIT", artists: ["Ultra Vomit"], date: concertDate,
                            venue: "Salle polyvalente de l’Auzelou", city: "Tulle", country: "France")
    let oaConcert = Concert(id: "openagenda:1", name: "Ultra Vomit à Tulle", artists: ["Ultra Vomit"], date: concertDate,
                            venue: "Salle de l'Auzelou", city: "Tulle", country: "FR", ticketURL: URL(string: "https://shotgun.live/events/ultra-vomit-a-tulle"), source: "OpenAgenda")
    let concertList = ConcertsService.combine([tmConcert], [oaConcert], artist: nil)
    try require(concertList.count == 1 && concertList.first?.ticketURL == oaConcert.ticketURL, "La date de Tulle doit garder une seule fiche avec un lien")

    let catalog = OctaveCatalog.shared
    for query in ["Backseat Personality Disorder", "Aware", "Joseph Falling In Reverse", "Cross Off Mark Morton"] {
        let shelves = try await catalog.search(query, scope: .all)
        try require(!shelves.isEmpty, "Aucun résultat pour \(query)")
        print("Recherche Octave OK — \(query), \(shelves.flatMap(\.tracks).count) titres")
    }
    let teeAudio = Track(id: "QFp7phPYUvQ", title: "From The D To The A (avec Lil Yachty)",
                         artist: "Tee Grizzley", duration: 159)
    let teeTitle = #"Tee Grizzley - "From The D To The A ft. Lil Yachty" [Official Video]"#
    let teeVideo = Track(id: "-S0aea777jM", title: teeTitle, artist: "Tee Grizzley", duration: 170)
    let teeComparable = Track(id: "clip", title: teeTitle, artist: "Tee Grizzley", duration: 159)
    try require(OctaveCatalog.sameRecording(teeComparable, teeAudio), "Le préfixe de l’artiste et les guillemets du clip doivent être reconnus")
    let unrelated = Track(id: "other", title: teeAudio.title, artist: "City Girls", duration: 159)
    try require(!OctaveCatalog.sameRecording(teeComparable, unrelated), "Un autre artiste doit rester distinct")
    let teeSelected = try await catalog.recording(teeVideo)
    try require(teeSelected?.id == "octave:144393532", "Le clip de Tee Grizzley doit retrouver son édition audio")
    print("Titre de clip, artiste, invité et durée de la piste audio confirmés")

    let additional = [
        (Track(id: "octave:played-old", title: "Let's Get This Party Started", artist: "Korn · Autoplay", album: "Issues", duration: 221.24), "octave:15175513"),
        (Track(id: "LiCDZYfAMdo", title: "...Baby One More Time", artist: "First To Eleven", duration: 245), "octave:3189424121"),
        (Track(id: "TmQ5erMKsQU", title: "DA Uzi - Vrai N (Clip officiel)", artist: "DA Uzi", duration: 120), "octave:4359983131"),
        (Track(id: "RUG55VN7SAI", title: "Step Up - Linkin Park", artist: "Linkin Park", duration: 237), "octave:1100610192"),
        (Track(id: "pJbysSbUg74", title: "LVZ - Brisé (CLIP OFFICIEL)", artist: "LVZ", duration: 189), "octave:1231490422"),
        (Track(id: "dGYxT1QReQs", title: "Toosie Slide (Official Explicit Audio)", artist: "Drake", duration: 249), "octave:919708552")
    ]
    for (track, expectedID) in additional {
        let recording = try await catalog.recording(track)
        try require(recording?.id == expectedID, "Échec de correspondance pour " + track.title)
    }
    print("Clips avec annotation vidéo, nom d’artiste et réédition d’EP confirmés")

    let requested = Track(id: "EjlpiC2cGd0", title: "Backseat", artist: "Personality Disorder", duration: 126)
    let selected = try await catalog.recording(requested)
    try require(selected?.id == "octave:4312686782", "Backseat doit retrouver la version originale")
    if let id = selected?.albumID {
        let page = try await catalog.collection(MusicCollection(id: id, kind: .album, title: "Backseat"))
        try require(page.tracks.contains { $0.id == selected?.id }, "L’album doit contenir Backseat")
    }
    _ = try await catalog.suggestions("Aware")
    _ = try await catalog.charts()
    _ = try await catalog.artist("octave:92")
    print("Résolution Backseat, album, suggestions, classements et artiste OK")

    let json = #"{"top":{"type":"track","id":"4312686782"},"tracks":[{"id":"4312686782","title":"Backseat","artist":{"id":188682561,"name":"Personality Disorder"},"album":{"id":"1107423722","title":"Backseat"},"duration":126}]}"#
    let data = try JSONDecoder().decode(OctaveCatalog.Catalog.self, from: Data(json.utf8))
    try require(data.tracks?.first?.title == "Backseat", "Une fiche top ne doit pas empêcher la recherche")
    let artist = try JSONDecoder().decode(OctaveCatalog.Catalog.self,
        from: Data(#"{"top":[{"id":123,"title":"Test"}]}"#.utf8))
    try require(artist.top?.tracks?.first?.title == "Test", "La liste top d’artiste doit rester lisible")

    let library = await LibraryStore()
    guard var canonical = teeSelected else { throw NSError(domain: "Regression", code: 1) }
    canonical.youtubeID = teeVideo.id
    _ = await library.importIntoPlaylist(name: "Correspondance import QA", tracks: [teeVideo])
    let correction = await library.importIntoPlaylist(name: "Correspondance import QA", tracks: [canonical])
    let correctedPlaylist = await library.playlists.first { $0.name == "Correspondance import QA" }
    try require(correction.added == 0 && correctedPlaylist?.tracks.count == 1
                && correctedPlaylist?.tracks.first?.id == canonical.id, "Une correction d’import doit remplacer la source précédente sans doublon")

    let original = LibraryStore.HistorySnapshot.Entry(track: .init(requested), playedAt: 1000)
    let fresh = LibraryStore.HistorySnapshot(version: 1, entries: [original])
    await library.mergeHistory(fresh)
    let saved = await library.listeningHistory()
    try require(saved.entries.contains { $0.track.id == requested.id }, "Historique reçu du PC")
    await library.mergeHistory(fresh)
    let repeated = await library.listeningHistory()
    try require(repeated.entries.filter { $0.track.id == requested.id }.count == 1, "Échange répété sans doublon")
    let removed = LibraryStore.HistorySnapshot(version: 1, removed: [requested.id: 2000], entries: [])
    await library.mergeHistory(removed)
    await library.mergeHistory(fresh)
    let cleaned = await library.listeningHistory()
    try require(!cleaned.entries.contains { $0.track.id == requested.id }, "Une suppression ne doit pas réapparaître")
    print("Historique aller-retour, échange répété et suppression OK")
} catch {
    fputs("Échec du test Octave — \(error)\n", stderr)
    exit(1)
}
