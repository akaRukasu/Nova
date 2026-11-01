import CoreImage
import SwiftUI
import UIKit

/// Teintes dominantes d'une pochette (haut et bas), pour colorer le lecteur.
enum ArtworkPalette {
    private static let context = CIContext(options: [.workingColorSpace: NSNull()])

    static func colors(of image: UIImage) async -> [Color] {
        await Task.detached(priority: .utility) {
            guard let input = CIImage(image: image) else { return [] }
            let extent = input.extent
            let top = CGRect(x: extent.minX, y: extent.midY, width: extent.width, height: extent.height / 2)
            let bottom = CGRect(x: extent.minX, y: extent.minY, width: extent.width, height: extent.height / 2)
            return [top, bottom].compactMap { average(of: input, in: $0) }
        }.value
    }

    private static func average(of image: CIImage, in rect: CGRect) -> Color? {
        guard let filter = CIFilter(name: "CIAreaAverage",
                                    parameters: [kCIInputImageKey: image, kCIInputExtentKey: CIVector(cgRect: rect)]),
              let output = filter.outputImage else { return nil }
        var pixel = [UInt8](repeating: 0, count: 4)
        context.render(output, toBitmap: &pixel, rowBytes: 4,
                       bounds: CGRect(x: 0, y: 0, width: 1, height: 1), format: .RGBA8, colorSpace: nil)
        // Couleur assombrie et un peu saturée : le texte blanc reste lisible.
        let color = UIColor(red: CGFloat(pixel[0]) / 255, green: CGFloat(pixel[1]) / 255,
                            blue: CGFloat(pixel[2]) / 255, alpha: 1)
        var hue: CGFloat = 0, saturation: CGFloat = 0, brightness: CGFloat = 0, alpha: CGFloat = 0
        color.getHue(&hue, saturation: &saturation, brightness: &brightness, alpha: &alpha)
        return Color(hue: hue, saturation: min(1, saturation * 1.2), brightness: min(0.55, brightness * 0.8))
    }
}
