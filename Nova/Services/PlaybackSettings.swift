import Foundation

/// Réglages lus par les services (hors interface), stockés dans UserDefaults.
enum PlaybackSettings {
    private static var defaults: UserDefaults { .standard }

    static var preferHighQuality: Bool {
        defaults.object(forKey: "audioQualityHigh") as? Bool ?? true
    }

    static var autoplayRadio: Bool {
        defaults.object(forKey: "autoplayRadio") as? Bool ?? true
    }

    static var cacheOnCellular: Bool {
        defaults.object(forKey: "cacheOnCellular") as? Bool ?? true
    }

    static var downloadOnCellular: Bool {
        defaults.object(forKey: "downloadOnCellular") as? Bool ?? false
    }

    static var cacheLimitBytes: Int64 {
        Int64(defaults.object(forKey: "cacheLimitMB") as? Int ?? 1500) * 1_000_000
    }

    static var recordHistory: Bool {
        defaults.object(forKey: "recordHistory") as? Bool ?? true
    }

    /// Transition entre deux titres, comme AutoMix et le fondu enchaîné d'Apple Music.
    enum Transition: String, CaseIterable, Identifiable {
        case off, crossfade, automix
        var id: String { rawValue }

        var label: String {
            switch self {
            case .off: "Désactivées"
            case .crossfade: "Fondu enchaîné"
            case .automix: "AutoMix (DJ)"
            }
        }

        /// Volumes (titre suivant, titre qui se termine) à l'instant `t` de la transition (0 → 1).
        func volumes(at t: Double) -> (incoming: Double, outgoing: Double) {
            func smooth(_ x: Double) -> Double { let x = min(max(x, 0), 1); return x * x * (3 - 2 * x) }
            switch self {
            case .off:
                return (1, 0)
            case .crossfade:
                // Puissance constante : pas de creux de volume au milieu.
                return (sin(t * .pi / 2), cos(t * .pi / 2))
            case .automix:
                // Façon DJ : le titre suivant monte pendant que l'autre tient, puis celui-ci s'efface.
                return (smooth(t / 0.55), 1 - smooth((t - 0.35) / 0.65))
            }
        }
    }

    static var transition: Transition {
        Transition(rawValue: defaults.string(forKey: "transitionStyle") ?? "") ?? .automix
    }

    static var crossfadeSeconds: Double {
        defaults.object(forKey: "crossfadeSeconds") as? Double ?? 6
    }

    /// Durée de la transition (`nil` : pas de transition).
    static var transitionDuration: TimeInterval? {
        switch transition {
        case .off: nil
        case .crossfade: crossfadeSeconds
        case .automix: 10
        }
    }

    /// Pays du contenu (classements, accueil, sorties).
    static var region: String {
        defaults.string(forKey: "contentRegion") ?? "FR"
    }

    static var language: String {
        defaults.string(forKey: "contentLanguage") ?? "fr"
    }
}
