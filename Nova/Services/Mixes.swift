import Foundation
import SwiftUI

/// Mix personnalisés, renouvelés chaque jour, comme sur Apple Music.
enum MixKind: Hashable, Codable, Identifiable {
    /// Tes titres préférés : les plus écoutés et les likés.
    case favorites
    /// Des titres que tu ne connais pas encore, proches de ce que tu écoutes.
    case discovery
    /// Des titres aimés que tu n'as pas écoutés depuis longtemps.
    case rediscovery
    /// Tes titres les plus écoutés de l'année.
    case replay
    /// Station d'un artiste que tu écoutes beaucoup.
    case artist(String)

    var id: String {
        switch self {
        case .favorites: return "favorites"
        case .discovery: return "discovery"
        case .rediscovery: return "rediscovery"
        case .replay: return "replay"
        case .artist(let name): return "artist:" + name
        }
    }

    var title: String {
        switch self {
        case .favorites: return "Mix favoris"
        case .discovery: return "Mix découverte"
        case .rediscovery: return "Mix redécouverte"
        case .replay: return "Replay \(Calendar.current.component(.year, from: Date()))"
        case .artist(let name): return "Station \(name)"
        }
    }

    var subtitle: String {
        switch self {
        case .favorites: return "Tes titres préférés, renouvelés chaque jour"
        case .discovery: return "Des nouveautés pour toi, d'après tes écoutes"
        case .rediscovery: return "Des titres que tu aimais, à réécouter"
        case .replay: return "Tes titres les plus écoutés de l'année"
        case .artist(let name): return "\(name) et des artistes proches"
        }
    }

    var colors: [Color] {
        switch self {
        case .favorites: return [Color(red: 0.98, green: 0.18, blue: 0.33), Color(red: 0.62, green: 0.05, blue: 0.28)]
        case .discovery: return [Color(red: 0.20, green: 0.55, blue: 1.0), Color(red: 0.36, green: 0.16, blue: 0.80)]
        case .rediscovery: return [Color(red: 1.0, green: 0.62, blue: 0.15), Color(red: 0.88, green: 0.24, blue: 0.20)]
        case .replay: return [Color(red: 0.12, green: 0.12, blue: 0.16), Color(red: 0.45, green: 0.08, blue: 0.20)]
        case .artist: return [Color(red: 0.10, green: 0.70, blue: 0.62), Color(red: 0.05, green: 0.30, blue: 0.45)]
        }
    }
}

/// Fabrique les mix à partir de la bibliothèque, des statistiques d'écoute et des radios YouTube Music.
@MainActor
enum MixBuilder {
    private static let size = 50

    /// Mix disponibles pour cet utilisateur.
    static func kinds(library: LibraryStore) -> [MixKind] {
        var kinds: [MixKind] = []
        if pool(library).count >= 5 { kinds.append(.favorites) }
        if !seeds(library).isEmpty { kinds.append(.discovery) }
        if rediscoveryTracks(library).count >= 8 { kinds.append(.rediscovery) }
        if replayTracks(library).count >= 5 { kinds.append(.replay) }
        kinds += topArtists(library).prefix(4).map { MixKind.artist($0) }
        return kinds
    }

    /// Pochettes pour la carte du mix (sans attendre le réseau).
    static func preview(_ kind: MixKind, library: LibraryStore) -> [Track] {
        switch kind {
        case .favorites: return Array(favoritesTracks(library).prefix(4))
        case .discovery: return Array(seeds(library).prefix(4))
        case .rediscovery: return Array(rediscoveryTracks(library).prefix(4))
        case .replay: return Array(replayTracks(library).prefix(4))
        case .artist(let name): return Array(pool(library).filter { mainArtist($0) == name }.prefix(4))
        }
    }

    static func tracks(for kind: MixKind, library: LibraryStore) async -> [Track] {
        switch kind {
        case .favorites:
            return favoritesTracks(library)
        case .rediscovery:
            return rediscoveryTracks(library)
        case .replay:
            return replayTracks(library)
        case .discovery:
            // Radios des titres les plus écoutés, sans ce que tu connais déjà.
            let known = Set(pool(library).map(\.id))
            let knownKeys = Set(pool(library).map(LibraryStore.dedupeKey))
            var lists: [[Track]] = []
            for seed in seeds(library).prefix(5) {
                let radio = await cachedRadio(seed.id)
                lists.append(radio.filter { !known.contains($0.id) && !knownKeys.contains(LibraryStore.dedupeKey($0)) })
            }
            return Array(dailyShuffle(interleave(lists), salt: kind.id).prefix(size))
        case .artist(let name):
            let tracks = pool(library).filter { mainArtist($0) == name }
            let top = tracks.max { (library.stats[$0.id]?.playCount ?? 0) < (library.stats[$1.id]?.playCount ?? 0) }
            guard let seed = top ?? tracks.first else { return [] }
            return Array(await cachedRadio(seed.id).prefix(size))
        }
    }

    // MARK: Ingrédients

    /// Tous les titres connus : bibliothèque et historique.
    private static func pool(_ library: LibraryStore) -> [Track] {
        var seen = Set<String>()
        return (library.songs + library.recents).filter { seen.insert($0.id).inserted }
    }

    private static func score(_ track: Track, _ library: LibraryStore) -> Double {
        let info = library.stats[track.id]
        var score = Double(info?.playCount ?? 0) * 2
        if library.isLiked(track.id) { score += 6 }
        if let last = info?.lastPlayed, Date().timeIntervalSince(last) < 14 * 86_400 { score += 3 }
        return score
    }

    private static func favoritesTracks(_ library: LibraryStore) -> [Track] {
        let ranked = pool(library).sorted { score($0, library) > score($1, library) }
        return Array(dailyShuffle(Array(ranked.prefix(size * 2)), salt: "favorites").prefix(size))
    }

    private static func rediscoveryTracks(_ library: LibraryStore) -> [Track] {
        let limit = Date().addingTimeInterval(-45 * 86_400)
        let candidates = pool(library).filter { track in
            guard library.isLiked(track.id) || (library.stats[track.id]?.playCount ?? 0) >= 2 else { return false }
            return (library.stats[track.id]?.lastPlayed ?? .distantPast) < limit
        }
        return Array(dailyShuffle(candidates, salt: "rediscovery").prefix(size))
    }

    private static func replayTracks(_ library: LibraryStore) -> [Track] {
        let year = Calendar.current.component(.year, from: Date())
        return pool(library)
            .filter { track in
                guard let info = library.stats[track.id], info.playCount > 0, let last = info.lastPlayed else { return false }
                return Calendar.current.component(.year, from: last) == year
            }
            .sorted { (library.stats[$0.id]?.playCount ?? 0) > (library.stats[$1.id]?.playCount ?? 0) }
            .prefix(size)
            .map { $0 }
    }

    /// Titres de départ : les plus écoutés, un par artiste.
    private static func seeds(_ library: LibraryStore) -> [Track] {
        var seenArtists = Set<String>()
        return pool(library)
            .sorted { score($0, library) > score($1, library) }
            .filter { seenArtists.insert(mainArtist($0)).inserted }
            .prefix(8)
            .map { $0 }
    }

    static func topArtists(_ library: LibraryStore) -> [String] {
        var counts: [String: Double] = [:]
        for track in pool(library) {
            let artist = mainArtist(track)
            guard !artist.isEmpty else { continue }
            counts[artist, default: 0] += 1 + score(track, library)
        }
        return counts.sorted { $0.value > $1.value }.map(\.key)
    }

    static func mainArtist(_ track: Track) -> String {
        let first = track.artist.components(separatedBy: CharacterSet(charactersIn: ",&")).first ?? track.artist
        return (first.components(separatedBy: " et ").first ?? first).trimmingCharacters(in: .whitespaces)
    }

    private static func cachedRadio(_ videoID: String) async -> [Track] {
        var tracks: [Track] = []
        let client = InnerTubeClient()
        try? await loadCached("radio-\(videoID)", freshFor: 86_400,
                              fetch: { try await client.radio(for: videoID) }) { tracks = $0 }
        return tracks
    }

    private static func interleave(_ lists: [[Track]]) -> [Track] {
        var result: [Track] = []
        var seen = Set<String>()
        let longest = lists.map(\.count).max() ?? 0
        for index in 0..<longest {
            for list in lists where index < list.count && seen.insert(list[index].id).inserted {
                result.append(list[index])
            }
        }
        return result
    }

    /// Mélange stable pour la journée : le mix ne change pas à chaque ouverture, mais chaque jour.
    private static func dailyShuffle(_ tracks: [Track], salt: String) -> [Track] {
        let day = UInt64(Date().timeIntervalSince1970 / 86_400)
        var seed = day &* 0x9E3779B97F4A7C15
        for byte in salt.utf8 { seed = (seed ^ UInt64(byte)) &* 0x100000001B3 }
        var generator = SeededGenerator(state: seed)
        return tracks.shuffled(using: &generator)
    }
}

/// Générateur pseudo-aléatoire déterministe (SplitMix64).
struct SeededGenerator: RandomNumberGenerator {
    var state: UInt64

    mutating func next() -> UInt64 {
        state &+= 0x9E3779B97F4A7C15
        var z = state
        z = (z ^ (z >> 30)) &* 0xBF58476D1CE4E5B9
        z = (z ^ (z >> 27)) &* 0x94D049BB133111EB
        return z ^ (z >> 31)
    }
}
