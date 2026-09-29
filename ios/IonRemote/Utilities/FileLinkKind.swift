import Foundation
import UniformTypeIdentifiers

/// What the phone can do with a file, judged from its name.
enum FileLinkKind: Equatable {
    /// Text Ion shows in its own file viewer (source, Markdown, JSON, logs).
    case text
    /// A file Quick Look can show: images, PDF, Office documents, media.
    case quickLook
    /// Anything else. It can still be downloaded.
    case other

    /// Extensions Quick Look previews that do not declare a conforming type everywhere.
    private static let documentExtensions: Set<String> = [
        "doc", "docx", "xls", "xlsx", "ppt", "pptx", "key", "pages", "numbers", "rtf", "csv", "usdz",
    ]

    static func of(_ path: String) -> FileLinkKind {
        let ext = (path as NSString).pathExtension.lowercased()
        if documentExtensions.contains(ext) { return .quickLook }
        guard let type = UTType(filenameExtension: ext) else {
            // No registered type: a dotfile, a log, a made-up extension. Ion's viewer reads it as text.
            return .text
        }
        if type.conforms(to: .image) || type.conforms(to: .pdf) || type.conforms(to: .audiovisualContent) {
            return .quickLook
        }
        if type.conforms(to: .text) || type.conforms(to: .sourceCode) || type.conforms(to: .json) || type.conforms(to: .xml) {
            return .text
        }
        return type.isDynamic ? .text : .other
    }

    /// Whether "Preview" belongs on the file's long-press menu.
    var canPreview: Bool { self != .other }
}
