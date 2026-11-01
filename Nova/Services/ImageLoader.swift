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
            // Miniatures vidéo de YouTube : bandes noires ou grises autour de la pochette, rognées.
            let source = url.host?.contains("ytimg") == true ? raw.trimmingUniformBorders() : raw
            // Décodage hors du fil principal : le défilement reste fluide.
            let image = await source.byPreparingForDisplay() ?? source
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

extension UIImage {
    /// Retire les bandes unies (noires, grises…) autour de l'image, en plusieurs passes :
    /// les miniatures YouTube ont souvent des bandes noires en haut et en bas, puis grises sur les côtés.
    func trimmingUniformBorders() -> UIImage {
        guard let cgImage else { return self }
        var crop = CGRect(x: 0, y: 0, width: cgImage.width, height: cgImage.height)
        for _ in 0..<3 {
            guard let current = cgImage.cropping(to: crop),
                  let inner = Self.contentBounds(of: current), inner.size != crop.size else { break }
            crop = CGRect(x: crop.minX + inner.minX, y: crop.minY + inner.minY, width: inner.width, height: inner.height)
        }
        // Rien à rogner, ou rognage absurde (image presque unie) : on garde l'original.
        guard crop.width >= CGFloat(cgImage.width) * 0.3, crop.height >= CGFloat(cgImage.height) * 0.3,
              crop.size != CGSize(width: cgImage.width, height: cgImage.height),
              let cropped = cgImage.cropping(to: crop.integral) else { return self }
        return UIImage(cgImage: cropped, scale: scale, orientation: imageOrientation)
    }

    /// Rectangle utile : on retire les lignes et colonnes de bord quasi identiques à la couleur du coin.
    private static func contentBounds(of image: CGImage) -> CGRect? {
        let width = image.width, height = image.height
        guard width > 20, height > 20,
              let context = CGContext(data: nil, width: width, height: height, bitsPerComponent: 8, bytesPerRow: width * 4,
                                      space: CGColorSpaceCreateDeviceRGB(),
                                      bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue),
              let data = context.data else { return nil }
        context.draw(image, in: CGRect(x: 0, y: 0, width: width, height: height))
        let pixels = data.bindMemory(to: UInt8.self, capacity: width * height * 4)

        func pixel(_ x: Int, _ y: Int) -> (Int, Int, Int) {
            let index = (y * width + x) * 4
            return (Int(pixels[index]), Int(pixels[index + 1]), Int(pixels[index + 2]))
        }
        let border = pixel(1, 1)
        // Seules les bandes sombres ou grises (pas le fond clair ou coloré d'une pochette) sont retirées.
        let saturation = max(border.0, border.1, border.2) - min(border.0, border.1, border.2)
        let brightness = (border.0 + border.1 + border.2) / 3
        guard saturation < 24, brightness < 130 else { return nil }
        func matches(_ x: Int, _ y: Int) -> Bool {
            let (r, g, b) = pixel(x, y)
            return abs(r - border.0) + abs(g - border.1) + abs(b - border.2) < 36
        }
        func rowIsBorder(_ y: Int) -> Bool {
            var count = 0
            for x in stride(from: 0, to: width, by: 2) where matches(x, y) { count += 1 }
            return Double(count) / Double((width + 1) / 2) > 0.96
        }
        func columnIsBorder(_ x: Int, from top: Int, to bottom: Int) -> Bool {
            var count = 0, total = 0
            for y in stride(from: top, to: bottom, by: 2) {
                total += 1
                if matches(x, y) { count += 1 }
            }
            return total > 0 && Double(count) / Double(total) > 0.96
        }

        var top = 0, bottom = height - 1
        while top < height / 2, rowIsBorder(top) { top += 1 }
        while bottom > height / 2, rowIsBorder(bottom) { bottom -= 1 }
        var left = 0, right = width - 1
        while left < width / 2, columnIsBorder(left, from: top, to: bottom) { left += 1 }
        while right > width / 2, columnIsBorder(right, from: top, to: bottom) { right -= 1 }
        // La mémoire du contexte et cropping(to:) comptent tous deux les lignes depuis le haut.
        let rect = CGRect(x: left, y: top, width: right - left + 1, height: bottom - top + 1)
        return rect.width > 10 && rect.height > 10 ? rect : nil
    }
}
