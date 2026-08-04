import Foundation

// MARK: - FileIcon

/// Extension → SF Symbol map shared by the file explorer (`FsEntry.iconName`)
/// and inline file-path chips in markdown (`MarkdownFormatter`). One map so
/// both surfaces show the same icon for the same file type.
enum FileIcon {
    /// SF Symbol for a lowercased file extension (no dot).
    static func symbol(forExtension ext: String) -> String {
        switch ext {
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

    /// SF Symbol for a file name or path (extension extracted, lowercased).
    static func symbol(forPath path: String) -> String {
        symbol(forExtension: (path as NSString).pathExtension.lowercased())
    }
}
