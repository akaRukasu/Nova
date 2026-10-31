import Foundation

/// Télécharge un fichier audio YouTube par morceaux de 10 Mo :
/// les serveurs de Google brident les téléchargements d'un seul bloc.
enum ChunkedDownloader {
    private static let chunkSize: Int64 = 10_000_000

    static func download(_ url: URL, to destination: URL) async throws {
        let partial = destination.appendingPathExtension("part")
        let manager = FileManager.default
        try? manager.removeItem(at: partial)
        guard manager.createFile(atPath: partial.path, contents: nil) else { throw NovaError.noPlayableStream }

        do {
            let handle = try FileHandle(forWritingTo: partial)
            defer { try? handle.close() }

            var offset: Int64 = 0
            var total: Int64?
            while true {
                try Task.checkCancellation()
                var request = URLRequest(url: url)
                request.timeoutInterval = 30
                request.setValue("bytes=\(offset)-\(offset + chunkSize - 1)", forHTTPHeaderField: "Range")
                request.setValue(InnerTubeClient.userAgent, forHTTPHeaderField: "User-Agent")
                let (data, response) = try await URLSession.shared.data(for: request)
                let status = (response as? HTTPURLResponse)?.statusCode ?? 0

                if status == 200 {
                    // Le serveur a ignoré la plage : on a reçu le fichier entier.
                    try handle.write(contentsOf: data)
                    offset += Int64(data.count)
                    break
                }
                guard status == 206 else { throw NovaError.badResponse(status) }
                try handle.write(contentsOf: data)
                offset += Int64(data.count)

                if total == nil,
                   let range = (response as? HTTPURLResponse)?.value(forHTTPHeaderField: "Content-Range"),
                   let slash = range.lastIndex(of: "/") {
                    total = Int64(range[range.index(after: slash)...])
                }
                if let total {
                    if offset >= total { break }
                } else if Int64(data.count) < chunkSize {
                    break
                }
                if data.isEmpty { break }
            }
            guard offset > 0 else { throw NovaError.noPlayableStream }
        } catch {
            try? manager.removeItem(at: partial)
            throw error
        }

        try? manager.removeItem(at: destination)
        try manager.moveItem(at: partial, to: destination)
    }
}
