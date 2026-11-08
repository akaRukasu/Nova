import SwiftUI

/// Tri d'une liste de titres (playlist, titres likés, playlist YouTube…), mémorisé pour chaque liste.
enum TrackSort: String, CaseIterable, Identifiable {
    case manual, title, artist, album, duration, mostPlayed, recentlyPlayed, recentlyAdded

    var id: String { rawValue }

    func label(manual: String) -> String {
        switch self {
        case .manual: manual
        case .title: "Titre"
        case .artist: "Artiste"
        case .album: "Album"
        case .duration: "Durée"
        case .mostPlayed: "Les plus écoutés"
        case .recentlyPlayed: "Écoutés récemment"
        case .recentlyAdded: "Ajoutés récemment"
        }
    }

    var icon: String {
        switch self {
        case .manual: "list.number"
        case .title: "textformat"
        case .artist: "music.mic"
        case .album: "square.stack"
        case .duration: "clock"
        case .mostPlayed: "flame"
        case .recentlyPlayed: "clock.arrow.circlepath"
        case .recentlyAdded: "calendar.badge.plus"
        }
    }

    /// Positions des titres dans l'ordre affiché (stable : à égalité, l'ordre de la liste est gardé).
    func order(_ tracks: [Track], stats: [String: TrackStats], reversed: Bool) -> [Int] {
        var positions = Array(tracks.indices)
        func text(_ a: String?, _ b: String?, _ i: Int, _ j: Int) -> Bool {
            switch (a?.isEmpty == false ? a : nil, b?.isEmpty == false ? b : nil) {
            case let (x?, y?):
                let result = x.localizedStandardCompare(y)
                return result == .orderedSame ? i < j : result == .orderedAscending
            case (_?, nil): return true
            case (nil, _?): return false
            default: return i < j
            }
        }
        func descending<T: Comparable>(_ a: T, _ b: T, _ i: Int, _ j: Int) -> Bool { a == b ? i < j : a > b }
        switch self {
        case .manual:
            break
        case .title:
            positions.sort { text(tracks[$0].title, tracks[$1].title, $0, $1) }
        case .artist:
            positions.sort {
                let a = tracks[$0], b = tracks[$1]
                return a.artist.localizedStandardCompare(b.artist) == .orderedSame
                    ? text(a.album, b.album, $0, $1) : text(a.artist, b.artist, $0, $1)
            }
        case .album:
            positions.sort {
                let a = tracks[$0], b = tracks[$1]
                return (a.album ?? "") == (b.album ?? "") ? $0 < $1 : text(a.album, b.album, $0, $1)
            }
        case .duration:
            positions.sort { (tracks[$0].duration ?? .infinity, $0) < (tracks[$1].duration ?? .infinity, $1) }
        case .mostPlayed:
            positions.sort { descending(stats[tracks[$0].id]?.playCount ?? 0, stats[tracks[$1].id]?.playCount ?? 0, $0, $1) }
        case .recentlyPlayed:
            positions.sort { descending(stats[tracks[$0].id]?.lastPlayed ?? .distantPast, stats[tracks[$1].id]?.lastPlayed ?? .distantPast, $0, $1) }
        case .recentlyAdded:
            // Date d'ajout à la bibliothèque ; à égalité, le dernier ajouté à la liste d'abord.
            positions.sort {
                let a = stats[tracks[$0].id]?.added ?? .distantPast, b = stats[tracks[$1].id]?.added ?? .distantPast
                return a == b ? $0 > $1 : a > b
            }
        }
        return reversed ? positions.reversed() : positions
    }
}

/// Tri choisi pour une liste, gardé d'une ouverture à l'autre.
struct SortState: DynamicProperty {
    @AppStorage private var raw: String

    init(key: String) {
        _raw = AppStorage(wrappedValue: TrackSort.manual.rawValue, "sort.\(key)")
    }

    var sort: TrackSort { TrackSort(rawValue: raw.split(separator: "|").first.map(String.init) ?? "") ?? .manual }
    var reversed: Bool { raw.hasSuffix("|rev") }
    var isManual: Bool { sort == .manual && !reversed }

    func set(_ sort: TrackSort, reversed: Bool) {
        raw = sort.rawValue + (reversed ? "|rev" : "")
    }
}

/// Bouton « Trier » (barre du haut).
struct SortMenu: View {
    let state: SortState
    var manualLabel = "Ordre de la playlist"
    var options: [TrackSort] = TrackSort.allCases

    var body: some View {
        Menu {
            Picker("Trier par", selection: Binding(get: { state.sort }, set: { state.set($0, reversed: state.reversed) })) {
                ForEach(options) { option in
                    Label(option.label(manual: manualLabel), systemImage: option.icon).tag(option)
                }
            }
            Divider()
            Toggle(isOn: Binding(get: { state.reversed }, set: { state.set(state.sort, reversed: $0) })) {
                Label("Ordre inversé", systemImage: "arrow.up.arrow.down")
            }
        } label: {
            Image(systemName: state.isManual ? "arrow.up.arrow.down" : "arrow.up.arrow.down.circle.fill")
        }
        .accessibilityLabel("Trier")
    }
}
