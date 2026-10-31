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

    /// Pays du contenu (classements, accueil, sorties).
    static var region: String {
        defaults.string(forKey: "contentRegion") ?? "FR"
    }

    static var language: String {
        defaults.string(forKey: "contentLanguage") ?? "fr"
    }
}
