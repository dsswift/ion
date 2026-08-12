import SwiftUI
import UIKit

/// sRGB compositing and contrast primitives for theme-token decisions.
func srgbToLinear(_ component: CGFloat) -> CGFloat {
    let value = max(0, min(1, component))
    return value <= 0.04045
        ? value / 12.92
        : pow((value + 0.055) / 1.055, 2.4)
}

func relativeLuminance(_ color: Color) -> CGFloat {
    var red: CGFloat = 0
    var green: CGFloat = 0
    var blue: CGFloat = 0
    var alpha: CGFloat = 0
    guard UIColor(color).getRed(&red, green: &green, blue: &blue, alpha: &alpha) else {
        return 0
    }
    return 0.2126 * srgbToLinear(red)
        + 0.7152 * srgbToLinear(green)
        + 0.0722 * srgbToLinear(blue)
}

func composite(_ source: Color, over destination: Color) -> Color {
    var sourceRed: CGFloat = 0
    var sourceGreen: CGFloat = 0
    var sourceBlue: CGFloat = 0
    var sourceAlpha: CGFloat = 0
    var destinationRed: CGFloat = 0
    var destinationGreen: CGFloat = 0
    var destinationBlue: CGFloat = 0
    var destinationAlpha: CGFloat = 0
    guard UIColor(source).getRed(&sourceRed, green: &sourceGreen, blue: &sourceBlue, alpha: &sourceAlpha),
          UIColor(destination).getRed(&destinationRed, green: &destinationGreen, blue: &destinationBlue, alpha: &destinationAlpha) else {
        return destination
    }

    let outputAlpha = sourceAlpha + destinationAlpha * (1 - sourceAlpha)
    guard outputAlpha > 0 else { return .clear }
    return Color(
        red: (sourceRed * sourceAlpha + destinationRed * destinationAlpha * (1 - sourceAlpha)) / outputAlpha,
        green: (sourceGreen * sourceAlpha + destinationGreen * destinationAlpha * (1 - sourceAlpha)) / outputAlpha,
        blue: (sourceBlue * sourceAlpha + destinationBlue * destinationAlpha * (1 - sourceAlpha)) / outputAlpha,
        opacity: outputAlpha
    )
}

func contrastRatio(_ first: Color, _ second: Color) -> CGFloat {
    let lighter = max(relativeLuminance(first), relativeLuminance(second))
    let darker = min(relativeLuminance(first), relativeLuminance(second))
    return (lighter + 0.05) / (darker + 0.05)
}
