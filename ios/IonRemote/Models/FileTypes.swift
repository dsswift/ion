import Foundation

// MARK: - File explorer data types for remote file browser

/// A single entry in a directory listing.
struct FsEntry: Codable, Identifiable, Sendable {
    let name: String
    let path: String
    let isDirectory: Bool
    let size: Int
    let modifiedMs: Double

    var id: String { path }

    /// Human-readable file size.
    var formattedSize: String {
        if isDirectory { return "" }
        if size < 1024 { return "\(size) B" }
        if size < 1024 * 1024 { return "\(size / 1024) KB" }
        return String(format: "%.1f MB", Double(size) / (1024 * 1024))
    }

    /// File extension (lowercased, no dot).
    var fileExtension: String {
        let ext = (name as NSString).pathExtension.lowercased()
        return ext
    }

    /// SF Symbol name based on file extension.
    var iconName: String {
        if isDirectory { return "folder.fill" }
        switch fileExtension {
        case "swift", "ts", "tsx", "js", "jsx", "go", "py", "rb", "rs", "c", "cpp", "h", "java", "kt":
            return "chevron.left.forwardslash.chevron.right"
        case "json", "yaml", "yml", "toml", "xml", "plist":
            return "gearshape"
        case "md", "txt", "rtf", "doc", "docx":
            return "doc.text"
        case "png", "jpg", "jpeg", "gif", "svg", "webp", "ico":
            return "photo"
        case "pdf":
            return "doc.richtext"
        case "zip", "tar", "gz", "bz2", "7z", "rar":
            return "doc.zipper"
        case "sh", "bash", "zsh", "fish":
            return "terminal"
        case "css", "scss", "less":
            return "paintbrush"
        case "html", "htm":
            return "globe"
        default:
            return "doc"
        }
    }
}

/// Response payload for fs_dir_listing.
struct FsDirListingResponse: Codable, Sendable {
    let directory: String
    let entries: [FsEntry]
    let error: String?
}

/// Response payload for fs_file_content.
struct FsFileContentResponse: Codable, Sendable, Equatable {
    let filePath: String
    let content: String?
    let error: String?
}

/// Response payload for fs_write_result.
struct FsWriteResultResponse: Codable, Sendable, Equatable {
    let filePath: String
    let ok: Bool
    let error: String?
}

/// Response payload for fs_rename_result. Carries both paths so the
/// view-model can refresh the parent directory of `newPath` (and
/// optionally `oldPath` if the rename moved between parents in some
/// future extension — today the desktop handler only ever changes
/// the basename, so the parents will match). Equatable conformance
/// mirrors `FsWriteResultResponse` so SwiftUI's `.onChange(of:)`
/// fires reliably when the same path produces successive results.
struct FsRenameResultResponse: Codable, Sendable, Equatable {
    let oldPath: String
    let newPath: String
    let ok: Bool
    let error: String?
}

/// An attachment entry from the desktop's full message history scan.
struct TabAttachmentEntry: Codable, Sendable {
    let type: String   // "image", "file", or "plan"
    let name: String
    let path: String
}
