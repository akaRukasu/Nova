import AVFoundation
import CryptoKit
import Foundation

actor LocalAudioLibrary {
    static let shared = LocalAudioLibrary()
    nonisolated private static var directory: URL {
        FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("Nova/LocalAudio", isDirectory: true)
    }

    nonisolated static func url(for track: Track) -> URL? {
        guard track.id.hasPrefix("local:"), let filename = track.localFileName,
              filename.range(of: #"^[a-f0-9]{64}\.[a-z0-9]{1,8}$"#, options: .regularExpression) != nil,
              filename.hasPrefix(String(track.id.dropFirst(6)) + ".") else { return nil }
        let file = directory.appendingPathComponent(filename)
        return FileManager.default.fileExists(atPath: file.path) ? file : nil
    }

    func importFiles(_ urls: [URL]) async -> (tracks: [Track], errors: [String]) {
        var tracks: [Track] = []
        var errors: [String] = []
        for source in urls {
            let access = source.startAccessingSecurityScopedResource()
            defer { if access { source.stopAccessingSecurityScopedResource() } }
            do {
                try FileManager.default.createDirectory(at: Self.directory, withIntermediateDirectories: true)
                guard let input = InputStream(url: source) else { throw CocoaError(.fileReadUnknown) }
                input.open()
                defer { input.close() }
                var digest = SHA256()
                var buffer = [UInt8](repeating: 0, count: 65_536)
                while true {
                    let count = input.read(&buffer, maxLength: buffer.count)
                    if count == 0 { break }
                    if count < 0 { throw input.streamError ?? CocoaError(.fileReadUnknown) }
                    digest.update(data: Data(buffer.prefix(count)))
                }
                let hash = digest.finalize().map { String(format: "%02x", $0) }.joined()
                let suffix = source.pathExtension.lowercased()
                guard suffix.range(of: #"^[a-z0-9]{1,8}$"#, options: .regularExpression) != nil else {
                    throw NSError(domain: "LocalAudio", code: 1, userInfo: [NSLocalizedDescriptionKey: "Extension audio non reconnue."])
                }
                let filename = hash + "." + suffix
                let destination = Self.directory.appendingPathComponent(filename)
                let asset = AVURLAsset(url: source)
                guard try await asset.load(.isPlayable) else {
                    throw NSError(domain: "LocalAudio", code: 2, userInfo: [NSLocalizedDescriptionKey: "Format audio non pris en charge par cet appareil."])
                }
                let duration = try await asset.load(.duration).seconds
                let metadata = try await asset.load(.commonMetadata)
                var title: String?, artist: String?, album: String?, artwork: URL?
                for item in metadata {
                    switch item.commonKey {
                    case .commonKeyTitle: title = try? await item.load(.stringValue)
                    case .commonKeyArtist: artist = try? await item.load(.stringValue)
                    case .commonKeyAlbumName: album = try? await item.load(.stringValue)
                    case .commonKeyArtwork:
                        if let image = try? await item.load(.dataValue), image.count <= 10_000_000 {
                            let file = Self.directory.appendingPathComponent(hash + ".jpg")
                            try image.write(to: file, options: .atomic)
                            artwork = file
                        }
                    default: break
                    }
                }
                if !FileManager.default.fileExists(atPath: destination.path) {
                    let temporary = Self.directory.appendingPathComponent(UUID().uuidString + "." + suffix)
                    do {
                        try FileManager.default.copyItem(at: source, to: temporary)
                        try FileManager.default.moveItem(at: temporary, to: destination)
                    } catch {
                        try? FileManager.default.removeItem(at: temporary)
                        throw error
                    }
                }
                let parts = source.deletingPathExtension().lastPathComponent.components(separatedBy: " - ")
                let track = Track(id: "local:" + hash,
                                  title: title ?? (parts.count > 1 ? parts.dropFirst().joined(separator: " - ") : parts[0]),
                                  artist: artist ?? (parts.count > 1 ? parts[0] : "Artiste inconnu"),
                                  album: album, duration: duration.isFinite ? duration : nil, artworkURL: artwork,
                                  localFileName: filename)
                if !tracks.contains(where: { $0.id == track.id }) { tracks.append(track) }
            } catch {
                errors.append(source.lastPathComponent + " — " + error.localizedDescription)
            }
        }
        return (tracks, errors)
    }
}

