import CoreImage
import CoreImage.CIFilterBuiltins
import UIKit

/// A QR code of some text, drawn with CoreImage, sharp at any size.
enum QRCodeImage {

    /// The code for `text`, each module `scale` points wide. Nil when
    /// CoreImage could not draw it.
    static func make(from text: String, scale: CGFloat = 10) -> UIImage? {
        let filter = CIFilter.qrCodeGenerator()
        filter.message = Data(text.utf8)
        filter.correctionLevel = "M"
        guard let output = filter.outputImage?.transformed(by: CGAffineTransform(scaleX: scale, y: scale)),
              let cgImage = CIContext().createCGImage(output, from: output.extent) else {
            DiagnosticLog.log("qr code: CoreImage drew nothing", tag: "admin.access", level: .error, fields: [
                "length": String(text.count)
            ])
            return nil
        }
        return UIImage(cgImage: cgImage)
    }
}
