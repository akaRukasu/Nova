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
        for listed in urls {
            var url = listed
            // Titre sans pochette carrée : on cherche d'abord la vraie pochette HD.
            if listed.scheme == ArtworkResolver.scheme {
                guard let id = listed.pathComponents.last,
                      let found = await ArtworkResolver.shared.artwork(for: id) else { continue }
                let pixels = URLComponents(url: listed, resolvingAgainstBaseURL: false)?
                    .queryItems?.first { $0.name == "px" }?.value.flatMap(Int.init) ?? 544
                url = found.resizedArtwork(pixels: pixels)
            }
            guard let (data, response) = try? await session.data(from: url),
                  (response as? HTTPURLResponse)?.statusCode == 200,
                  let raw = UIImage(data: data),
                  raw.size.width > 130 // YouTube renvoie parfois une image vide de 120 px
            else { continue }
            // Miniatures vidéo de YouTube : bandes noires ou grises autour de la pochette, rognées.
            let source = url.host?.contains("ytimg") == true ? raw.trimmingUniformBorders() : raw
            // Décodage hors du fil principal : le défilement reste fluide.
            let image = await source.byPreparingForDisplay() ?? source
            cache.setObject(image, forKey: listed as NSURL)
            // Aussi sous l'adresse trouvée : la vue qui l'utilisera ensuite l'affiche aussitôt.
            if url != listed { cache.setObject(image, forKey: url as NSURL) }
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

extension UIImage {
    /// Retire les bandes unies sombres ou grises autour de l'image : les miniatures YouTube encadrent
    /// la pochette de bandes noires (haut, bas) puis grises (côtés). Une pochette sans bandes est inchangée.
    func trimmingUniformBorders() -> UIImage {
        guard let cgImage, let crop = Self.contentBounds(of: cgImage),
              crop.width >= CGFloat(cgImage.width) * 0.3, crop.height >= CGFloat(cgImage.height) * 0.3,
              crop.size != CGSize(width: cgImage.width, height: cgImage.height),
              let cropped = cgImage.cropping(to: crop) else { return self }
        return UIImage(cgImage: cropped, scale: scale, orientation: imageOrientation)
    }

    /// Rectangle utile. La couleur de référence de chaque bande est prise au milieu du bord concerné.
    private static func contentBounds(of image: CGImage) -> CGRect? {
        let width = image.width, height = image.height
        guard width > 20, height > 20,
              let context = CGContext(data: nil, width: width, height: height, bitsPerComponent: 8, bytesPerRow: width * 4,
                                      space: CGColorSpaceCreateDeviceRGB(),
                                      bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue),
              let data = context.data else { return nil }
        context.draw(image, in: CGRect(x: 0, y: 0, width: width, height: height))
        // La mémoire du contexte, comme cropping(to:), compte les lignes depuis le haut.
        let pixels = data.bindMemory(to: UInt8.self, capacity: width * height * 4)

        typealias RGB = (Int, Int, Int)
        func pixel(_ x: Int, _ y: Int) -> RGB {
            let index = (y * width + x) * 4
            return (Int(pixels[index]), Int(pixels[index + 1]), Int(pixels[index + 2]))
        }
        /// Seules les bandes sombres ou grises sont retirées, jamais le fond clair ou coloré d'une pochette.
        func usable(_ c: RGB) -> Bool {
            max(c.0, c.1, c.2) - min(c.0, c.1, c.2) < 24 && (c.0 + c.1 + c.2) / 3 < 130
        }
        func near(_ a: RGB, _ b: RGB) -> Bool {
            abs(a.0 - b.0) + abs(a.1 - b.1) + abs(a.2 - b.2) < 36
        }
        func rowIsBorder(_ y: Int, _ ref: RGB) -> Bool {
            var count = 0
            for x in stride(from: 0, to: width, by: 2) where near(pixel(x, y), ref) { count += 1 }
            return Double(count) / Double((width + 1) / 2) > 0.96
        }
        func columnIsBorder(_ x: Int, _ top: Int, _ bottom: Int, _ ref: RGB) -> Bool {
            var count = 0, total = 0
            for y in stride(from: top, to: bottom, by: 2) {
                total += 1
                if near(pixel(x, y), ref) { count += 1 }
            }
            return total > 0 && Double(count) / Double(total) > 0.96
        }

        var top = 0, bottom = height - 1
        let topRef = pixel(width / 2, 0)
        if usable(topRef) { while top < height / 2, rowIsBorder(top, topRef) { top += 1 } }
        let bottomRef = pixel(width / 2, height - 1)
        if usable(bottomRef) { while bottom > height / 2, rowIsBorder(bottom, bottomRef) { bottom -= 1 } }

        var left = 0, right = width - 1
        let leftRef = pixel(0, (top + bottom) / 2)
        if usable(leftRef) { while left < width / 2, columnIsBorder(left, top, bottom, leftRef) { left += 1 } }
        let rightRef = pixel(width - 1, (top + bottom) / 2)
        if usable(rightRef) { while right > width / 2, columnIsBorder(right, top, bottom, rightRef) { right -= 1 } }

        let rect = CGRect(x: left, y: top, width: right - left + 1, height: bottom - top + 1)
        return rect.width > 10 && rect.height > 10 ? rect : nil
    }
}
