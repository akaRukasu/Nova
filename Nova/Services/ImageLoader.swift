import SwiftUI
import UIKit

/// Charge la première image disponible d'une liste d'URL, avec un cache mémoire.
enum ImageLoader {
    private static let cache: NSCache<NSURL, UIImage> = {
        let cache = NSCache<NSURL, UIImage>()
        cache.countLimit = 300
        return cache
    }()

    /// Session avec un cache disque de 300 Mo : les pochettes ne sont téléchargées qu'une fois.
    private static let session: URLSession = {
        let configuration = URLSessionConfiguration.default
        configuration.urlCache = URLCache(memoryCapacity: 40_000_000, diskCapacity: 300_000_000,
                                          directory: FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask)[0]
                                            .appendingPathComponent("Images", isDirectory: true))
        configuration.requestCachePolicy = .returnCacheDataElseLoad
        configuration.httpMaximumConnectionsPerHost = 6
        return URLSession(configuration: configuration)
    }()

    static func cached(_ urls: [URL]) -> UIImage? {
        for url in urls { if let image = cache.object(forKey: url as NSURL) { return image } }
        return nil
    }

    static func load(_ urls: [URL]) async -> UIImage? {
        if let hit = cached(urls) { return hit }
        for url in urls {
            guard let (data, response) = try? await session.data(from: url),
                  (response as? HTTPURLResponse)?.statusCode == 200,
                  let raw = UIImage(data: data),
                  raw.size.width > 130 // YouTube renvoie parfois une image vide de 120 px
            else { continue }
            // Décodage hors du fil principal : le défilement reste fluide.
            let image = await raw.byPreparingForDisplay() ?? raw
            cache.setObject(image, forKey: url as NSURL)
            return image
        }
        return nil
    }
}

/// Image distante qui essaie plusieurs URL dans l'ordre.
struct RemoteImage: View {
    let urls: [URL]
    @State private var image: UIImage?

    var body: some View {
        // Le rectangle prend exactement la place proposée ; l'image le remplit sans jamais
        // l'agrandir, puis elle est rognée. Sans ça, une image « fill » élargit tout l'écran.
        Rectangle()
            .fill(.quaternary)
            .overlay {
                if let image {
                    Image(uiImage: image)
                        .resizable()
                        .aspectRatio(contentMode: .fill)
                        .transition(.opacity)
                } else {
                    Image(systemName: "music.note")
                        .font(.title3)
                        .foregroundStyle(.secondary)
                }
            }
            .clipped()
        .task(id: urls) {
            if let hit = ImageLoader.cached(urls) { image = hit; return }
            image = nil
            let loaded = await ImageLoader.load(urls)
            withAnimation(.easeOut(duration: 0.2)) { image = loaded }
        }
    }
}
