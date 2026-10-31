import SwiftUI
import UIKit

/// Charge la première image disponible d'une liste d'URL, avec un cache mémoire.
enum ImageLoader {
    private static let cache: NSCache<NSURL, UIImage> = {
        let cache = NSCache<NSURL, UIImage>()
        cache.countLimit = 300
        return cache
    }()

    static func cached(_ urls: [URL]) -> UIImage? {
        for url in urls { if let image = cache.object(forKey: url as NSURL) { return image } }
        return nil
    }

    static func load(_ urls: [URL]) async -> UIImage? {
        if let hit = cached(urls) { return hit }
        for url in urls {
            guard let (data, response) = try? await URLSession.shared.data(from: url),
                  (response as? HTTPURLResponse)?.statusCode == 200,
                  let image = UIImage(data: data),
                  image.size.width > 130 // YouTube renvoie parfois une image vide de 120 px
            else { continue }
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
        ZStack {
            if let image {
                Image(uiImage: image)
                    .resizable()
                    .aspectRatio(contentMode: .fill)
                    .transition(.opacity)
            } else {
                Rectangle()
                    .fill(.quaternary)
                    .overlay {
                        Image(systemName: "music.note")
                            .font(.title3)
                            .foregroundStyle(.secondary)
                    }
            }
        }
        .task(id: urls) {
            if let hit = ImageLoader.cached(urls) { image = hit; return }
            image = nil
            let loaded = await ImageLoader.load(urls)
            withAnimation(.easeOut(duration: 0.2)) { image = loaded }
        }
    }
}
