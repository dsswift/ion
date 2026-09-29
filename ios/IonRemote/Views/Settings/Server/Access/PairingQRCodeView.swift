import SwiftUI

/// A pairing link drawn as a QR code on white, so any camera reads it in
/// either appearance.
struct PairingQRCodeView: View {
    let text: String
    var side: CGFloat = 220

    var body: some View {
        if let image = QRCodeImage.make(from: text) {
            Image(uiImage: image)
                .interpolation(.none)
                .resizable()
                .scaledToFit()
                .frame(width: side, height: side)
                .padding(IonSpace.compactGap)
                .background(RoundedRectangle(cornerRadius: 12).fill(.white))
                .accessibilityLabel("QR code of the pairing link")
        } else {
            Label("The QR code could not be drawn. Use the code instead.", systemImage: "exclamationmark.triangle")
                .font(.footnote)
        }
    }
}
