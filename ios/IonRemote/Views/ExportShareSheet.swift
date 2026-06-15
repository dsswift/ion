import SwiftUI
import UIKit

/// UIKit share sheet wrapped for SwiftUI. Mirrors the private
/// ShareSheet inside AttachmentImagePreview.swift, exposed here so
/// `ConversationView` (and future call sites) can present a system
/// share sheet for any items array without duplicating the
/// UIViewControllerRepresentable boilerplate.
///
/// Intentionally permissive about item types — the array is `[Any]`
/// because UIActivityViewController accepts arbitrary objects (strings,
/// Data, URLs, UIImages). Callers know what they're sharing.
struct ExportShareSheet: UIViewControllerRepresentable {
    let items: [Any]

    func makeUIViewController(context: Context) -> UIActivityViewController {
        UIActivityViewController(activityItems: items, applicationActivities: nil)
    }

    func updateUIViewController(_ controller: UIActivityViewController, context: Context) {}
}
