import Foundation

/// Writes the bytes of a server file to a local copy the phone can preview or
/// export. Copies live under the temporary directory, one folder per file
/// content, so within one launch the same file opened twice reuses one copy,
/// and two files with the same name never overwrite each other.
enum RemoteFileCopy {
    /// The part of `name` that is safe as one path segment.
    static func safeName(_ name: String) -> String {
        let base = (name.replacingOccurrences(of: "\\", with: "/") as NSString).lastPathComponent
        let cleaned = String(base.unicodeScalars.map { scalar -> Character in
            if scalar.value < 0x20 || "<>:\"|?*".unicodeScalars.contains(scalar) { return "_" }
            return Character(scalar)
        }).trimmingCharacters(in: .whitespaces)
        guard !cleaned.isEmpty, cleaned != ".", cleaned != ".." else { return "file" }
        return String(cleaned.prefix(200))
    }

    /// Writes `data` as `name` under `root` and returns the copy's URL.
    static func write(_ data: Data, name: String, root: URL = FileManager.default.temporaryDirectory.appendingPathComponent("ion-file-links")) throws -> URL {
        var hasher = Hasher()
        hasher.combine(data)
        let folder = root.appendingPathComponent(String(UInt(bitPattern: hasher.finalize()), radix: 16), isDirectory: true)
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        let url = folder.appendingPathComponent(safeName(name))
        try data.write(to: url, options: .atomic)
        return url
    }
}
