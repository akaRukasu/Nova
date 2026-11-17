import Foundation

struct OctaveBackup: Decodable, Sendable {
    struct Playlist: Decodable, Sendable {
        var id: String?
        var name: String?
        var createdAt: Date?
        var tracks: [OctaveCatalog.Entry]?
    }

    struct State: Decodable, Sendable {
        var playlists: [Playlist]
        var savedAlbums: [OctaveCatalog.Entry]?
        var followedArtists: [OctaveCatalog.Entry]?
    }

    struct Library: Decodable, Sendable { var state: State }
    var library: Library

    private enum CodingKeys: String, CodingKey { case data }
    private enum DataKeys: String, CodingKey { case library = "octave:library" }

    init(from decoder: Decoder) throws {
        let root = try decoder.container(keyedBy: CodingKeys.self)
        let contents = try root.nestedContainer(keyedBy: DataKeys.self, forKey: .data)
        library = try contents.decode(Library.self, forKey: .library)
    }

    static func read(_ data: Data) throws -> State {
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .millisecondsSince1970
        return try decoder.decode(Self.self, from: data).library.state
    }
}
