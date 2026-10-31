import Foundation

/// Statistiques d'écoute d'un titre (pour les playlists intelligentes).
struct TrackStats: Codable, Hashable {
    var playCount = 0
    var lastPlayed: Date?
    var added: Date?
}

/// Playlist intelligente, comme dans iTunes : des règles, mises à jour en continu.
struct SmartPlaylist: Identifiable, Codable, Hashable {
    var id = UUID()
    var name: String
    var rules: [SmartRule] = [SmartRule()]
    /// `true` : tous les critères ; `false` : au moins un.
    var matchAll = true
    var limit: Int?
    var sort: SmartSort = .recentlyAdded
}

struct SmartRule: Identifiable, Codable, Hashable {
    var id = UUID()
    var field: SmartField = .artist
    var op: SmartOperator = .contains
    var text = ""
    var number: Double = 0
}

enum SmartField: String, Codable, CaseIterable, Identifiable {
    case title, artist, album, duration, playCount, lastPlayed, added, liked, downloaded

    var id: String { rawValue }

    var label: String {
        switch self {
        case .title: return "Titre"
        case .artist: return "Artiste"
        case .album: return "Album"
        case .duration: return "Durée (minutes)"
        case .playCount: return "Nombre d'écoutes"
        case .lastPlayed: return "Dernière écoute"
        case .added: return "Date d'ajout"
        case .liked: return "J'aime"
        case .downloaded: return "Téléchargé"
        }
    }

    enum Kind { case text, number, date, flag }

    var kind: Kind {
        switch self {
        case .title, .artist, .album: return .text
        case .duration, .playCount: return .number
        case .lastPlayed, .added: return .date
        case .liked, .downloaded: return .flag
        }
    }

    var operators: [SmartOperator] {
        switch kind {
        case .text: return [.contains, .notContains, .is, .isNot, .startsWith]
        case .number: return [.greater, .less, .is]
        case .date: return [.inLast, .notInLast]
        case .flag: return [.isTrue, .isFalse]
        }
    }
}

enum SmartOperator: String, Codable, CaseIterable, Identifiable {
    case contains, notContains, `is`, isNot, startsWith, greater, less, inLast, notInLast, isTrue, isFalse

    var id: String { rawValue }

    var label: String {
        switch self {
        case .contains: return "contient"
        case .notContains: return "ne contient pas"
        case .is: return "est"
        case .isNot: return "n'est pas"
        case .startsWith: return "commence par"
        case .greater: return "est supérieur à"
        case .less: return "est inférieur à"
        case .inLast: return "dans les derniers (jours)"
        case .notInLast: return "pas dans les derniers (jours)"
        case .isTrue: return "oui"
        case .isFalse: return "non"
        }
    }
}

enum SmartSort: String, Codable, CaseIterable, Identifiable {
    case random, mostPlayed, recentlyPlayed, recentlyAdded, title, artist

    var id: String { rawValue }

    var label: String {
        switch self {
        case .random: return "Aléatoire"
        case .mostPlayed: return "Les plus écoutés"
        case .recentlyPlayed: return "Écoutés récemment"
        case .recentlyAdded: return "Ajoutés récemment"
        case .title: return "Titre"
        case .artist: return "Artiste"
        }
    }
}

extension SmartPlaylist {
    /// Titres correspondant aux règles, parmi `pool`.
    func evaluate(pool: [Track], stats: [String: TrackStats], liked: Set<String>, downloaded: Set<String>) -> [Track] {
        let now = Date()
        func matches(_ track: Track, _ rule: SmartRule) -> Bool {
            let info = stats[track.id]
            switch rule.field.kind {
            case .text:
                let value: String
                switch rule.field {
                case .title: value = track.title
                case .artist: value = track.artist
                default: value = track.album ?? ""
                }
                let a = value.folding(options: [.caseInsensitive, .diacriticInsensitive], locale: nil)
                let b = rule.text.folding(options: [.caseInsensitive, .diacriticInsensitive], locale: nil)
                    .trimmingCharacters(in: .whitespaces)
                switch rule.op {
                case .contains: return b.isEmpty || a.contains(b)
                case .notContains: return b.isEmpty || !a.contains(b)
                case .is: return a == b
                case .isNot: return a != b
                case .startsWith: return a.hasPrefix(b)
                default: return true
                }
            case .number:
                let value: Double = rule.field == .duration
                    ? (track.duration ?? 0) / 60
                    : Double(info?.playCount ?? 0)
                switch rule.op {
                case .greater: return value > rule.number
                case .less: return value < rule.number
                case .is: return Int(value.rounded()) == Int(rule.number.rounded())
                default: return true
                }
            case .date:
                let date = rule.field == .lastPlayed ? info?.lastPlayed : info?.added
                let inWindow = date.map { now.timeIntervalSince($0) <= rule.number * 86_400 } ?? false
                return rule.op == .inLast ? inWindow : !inWindow
            case .flag:
                let value = rule.field == .liked ? liked.contains(track.id) : downloaded.contains(track.id)
                return rule.op == .isTrue ? value : !value
            }
        }

        var result = pool.filter { track in
            guard !rules.isEmpty else { return true }
            return matchAll ? rules.allSatisfy { matches(track, $0) } : rules.contains { matches(track, $0) }
        }
        switch sort {
        case .random: result.shuffle()
        case .mostPlayed: result.sort { (stats[$0.id]?.playCount ?? 0) > (stats[$1.id]?.playCount ?? 0) }
        case .recentlyPlayed: result.sort { (stats[$0.id]?.lastPlayed ?? .distantPast) > (stats[$1.id]?.lastPlayed ?? .distantPast) }
        case .recentlyAdded: result.sort { (stats[$0.id]?.added ?? .distantPast) > (stats[$1.id]?.added ?? .distantPast) }
        case .title: result.sort { $0.title.localizedCaseInsensitiveCompare($1.title) == .orderedAscending }
        case .artist: result.sort { $0.artist.localizedCaseInsensitiveCompare($1.artist) == .orderedAscending }
        }
        if let limit, limit > 0 { result = Array(result.prefix(limit)) }
        return result
    }
}
