import SwiftUI

/// Résout les références manquantes des titres importés avant d'ouvrir le catalogue complet.
struct TrackCatalogView: View {
    let track: Track
    let kind: CollectionKind
    @State private var destination: MusicCollection?
    @State private var alternatives: [MusicCollection] = []
    @State private var loading = true
    @State private var attempt = 0

    var body: some View {
        Group {
            if let destination {
                if kind == .artist { ArtistView(artist: destination) }
                else { CollectionView(collection: destination) }
            } else if loading {
                ProgressView("Recherche dans le catalogue…").frame(maxWidth: .infinity, maxHeight: .infinity)
            } else {
                List {
                    if alternatives.isEmpty {
                        ContentUnavailableView("Aucune correspondance confirmée", systemImage: "magnifyingglass",
                                               description: Text("Réessaie pour rechercher cet artiste ou cet album dans les catalogues."))
                    }
                    ForEach(alternatives) { collection in
                        NavigationLink(value: Route.collection(collection)) {
                            Label(collection.title + (collection.subtitle.isEmpty ? "" : " · " + collection.subtitle),
                                  systemImage: kind == .artist ? "music.mic" : "square.stack")
                        }
                    }
                    Button("Réessayer") { attempt += 1 }
                }
                .navigationTitle(kind == .artist ? track.artist : (track.album ?? track.title))
            }
        }
        .task(id: attempt) { await resolve() }
    }

    private func resolve() async {
        loading = true
        defer { loading = false }
        let known = kind == .artist ? track.artistCollection : track.albumCollection
        if let known { destination = known; return }
        var lookup = track
        // L'identifiant local décrit le fichier, pas le catalogue.
        if lookup.id.hasPrefix("local:") { lookup.id = "catalog-lookup" }
        if let matched = try? await OctaveCatalog.shared.recording(lookup),
           let found = kind == .artist ? matched.artistCollection : matched.albumCollection {
            destination = found
            return
        }
        let query = kind == .artist ? track.artist : [track.album ?? track.title, track.artist].joined(separator: " ")
        let scope: SearchScope = kind == .artist ? .artists : .albums
        let octave = (try? await OctaveCatalog.shared.search(query, scope: scope)) ?? []
        let youtube = (try? await InnerTubeClient().search(query, scope: scope)) ?? []
        var seen = Set<String>()
        alternatives = (octave + youtube).flatMap(\.items).compactMap { item in
            guard case .collection(let collection) = item, collection.kind == kind,
                  seen.insert(collection.id).inserted else { return nil }
            return collection
        }
        let title = ArtistNames.key(kind == .artist ? track.artist : (track.album ?? ""))
        let matches = alternatives.filter {
            ArtistNames.key($0.title) == title && (kind == .artist || ArtistNames.key($0.subtitle).contains(ArtistNames.key(track.artist)))
        }
        if matches.count == 1 { destination = matches[0] }
    }
}
