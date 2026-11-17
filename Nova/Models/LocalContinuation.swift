import Foundation

enum LocalContinuation {
    static func tracks(after seed: Track, library: [Track], queue: [Track], limit: Int = 20) -> [Track] {
        func key(_ value: String?) -> String {
            (value ?? "").precomposedStringWithCompatibilityMapping.lowercased()
                .trimmingCharacters(in: .whitespacesAndNewlines)
        }
        let artist = key(seed.artist), album = key(seed.album)
        func rank(_ track: Track) -> Int {
            (!artist.isEmpty && key(track.artist) == artist ? 4 + (!album.isEmpty && key(track.album) == album ? 4 : 0) : 0)
                + (track.id.hasPrefix("local:") ? 1 : 0)
        }
        var known = Set(queue.flatMap { [$0.id, $0.youtubeID].compactMap { $0 } })
        let candidates = library.enumerated().filter { _, track in
            guard !known.contains(track.id), track.youtubeID.map({ !known.contains($0) }) ?? true else { return false }
            known.insert(track.id)
            if let id = track.youtubeID { known.insert(id) }
            return true
        }
        return candidates.sorted {
            let a = rank($0.element), b = rank($1.element)
            return a == b ? $0.offset < $1.offset : a > b
        }.prefix(max(0, limit)).map(\.element)
    }
}
