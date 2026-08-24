import UIKit

/// JPEG compression for images uploaded from the phone.
///
/// Shared by every upload entry point — the composer's attachment picker and
/// the Guided Questions per-answer picker — so an image attached from a
/// question is bounded exactly like one attached to a prompt. Extracted from
/// `ConversationView+Attachments` when the questions picker arrived, rather
/// than copied: two compressors would drift, and the second caller would
/// quietly ship a different size ceiling to the relay.
enum ImageCompression {

    /// Compress `data` to at most `maxBytes`, stepping quality down from 0.8.
    ///
    /// Returns the original bytes when they cannot be decoded as an image, and
    /// the lowest-quality encoding when even that exceeds the bound — an
    /// oversized upload the relay may reject is strictly better than silently
    /// dropping the operator's attachment.
    static func jpeg(data: Data, maxBytes: Int) -> Data {
        guard let uiImage = UIImage(data: data) else { return data }
        var quality: CGFloat = 0.8
        while quality > 0.1 {
            if let jpeg = uiImage.jpegData(compressionQuality: quality), jpeg.count <= maxBytes {
                return jpeg
            }
            quality -= 0.1
        }
        return uiImage.jpegData(compressionQuality: 0.1) ?? data
    }
}
