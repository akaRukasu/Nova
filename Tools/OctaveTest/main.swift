import Foundation

func require(_ value: @autoclosure () -> Bool, _ message: String) throws {
    if !value() { throw NSError(domain: "NovaOctaveRegression", code: 1, userInfo: [NSLocalizedDescriptionKey: message]) }
}

do {
    let catalog = OctaveCatalog.shared
    for query in ["Backseat Personality Disorder", "Aware", "Joseph Falling In Reverse", "Cross Off Mark Morton"] {
        let shelves = try await catalog.search(query, scope: .all)
        try require(!shelves.isEmpty, "Aucun résultat pour \(query)")
        print("Recherche Octave OK — \(query), \(shelves.flatMap(\.tracks).count) titres")
    }
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
