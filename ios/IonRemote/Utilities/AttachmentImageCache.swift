import CryptoKit
import UIKit

/// Caches compressed image data for attachment previews.
/// In-memory NSCache backed by a disk cache in Caches/ion-attachments/.
final class AttachmentImageCache: @unchecked Sendable {
    static let shared = AttachmentImageCache()

    private let memory = NSCache<NSString, NSData>()
    private let diskDir: URL

    private convenience init() {
        let caches = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask).first!
        self.init(directory: caches.appendingPathComponent("ion-attachments", isDirectory: true))
    }

    /// A cache over `directory`. The app uses `shared`; a test names its own directory.
    init(directory: URL) {
        memory.countLimit = 20
        diskDir = directory
        createDiskDir()
        removeFilesNotNamedByDigest()
    }

    private func createDiskDir() {
        do {
            try FileManager.default.createDirectory(at: diskDir, withIntermediateDirectories: true)
        } catch {
            DiagnosticLog.log("attachment cache directory create failed", tag: "cache.attachments", level: .error, fields: [
                "error": error.localizedDescription
            ])
        }
    }

    /// The file name a key is stored under: the SHA-256 of the key, in hex.
    /// A key is often an absolute path on the desktop, so it cannot name a
    /// file in this directory itself.
    static func diskFileName(forKey key: String) -> String {
        SHA256.hash(data: Data(key.utf8)).map { String(format: "%02x", $0) }.joined()
    }

    private func diskURL(forKey key: String) -> URL {
        diskDir.appendingPathComponent(Self.diskFileName(forKey: key))
    }

    /// Deletes files an earlier build stored under the raw key. Nothing reads them now.
    private func removeFilesNotNamedByDigest() {
        let names: [String]
        do {
            names = try FileManager.default.contentsOfDirectory(atPath: diskDir.path)
        } catch {
            DiagnosticLog.log("attachment cache listing failed", tag: "cache.attachments", level: .warn, fields: [
                "error": error.localizedDescription
            ])
            return
        }
        let hex = CharacterSet(charactersIn: "0123456789abcdef")
        var removed = 0
        for name in names where name.count != 64 || !name.unicodeScalars.allSatisfy(hex.contains) {
            do {
                try FileManager.default.removeItem(at: diskDir.appendingPathComponent(name))
                removed += 1
            } catch {
                DiagnosticLog.log("attachment cache stale file remove failed", tag: "cache.attachments", level: .warn, fields: [
                    "error": error.localizedDescription
                ])
            }
        }
        if removed > 0 {
            DiagnosticLog.log("attachment cache stale files removed", tag: "cache.attachments", fields: [
                "count": String(removed)
            ])
        }
    }

    func store(data: Data, forKey key: String) {
        memory.setObject(data as NSData, forKey: key as NSString)
        do {
            try data.write(to: diskURL(forKey: key), options: .atomic)
        } catch {
            DiagnosticLog.log("attachment cache disk write failed", tag: "cache.attachments", level: .warn, fields: [
                "key": key,
                "bytes": String(data.count),
                "error": error.localizedDescription
            ])
        }
    }

    func data(forKey key: String) -> Data? {
        if let cached = memory.object(forKey: key as NSString) {
            return cached as Data
        }
        let url = diskURL(forKey: key)
        // A disk cache miss returns nil and the caller fetches from the desktop.
        // swiftlint:disable:next silent_try_optional
        guard let diskData = try? Data(contentsOf: url) else { return nil }
        memory.setObject(diskData as NSData, forKey: key as NSString)
        return diskData
    }

    func image(forKey key: String) -> UIImage? {
        guard let d = data(forKey: key) else { return nil }
        return UIImage(data: d)
    }

    func rekey(from oldKey: String, to newKey: String) {
        guard let d = data(forKey: oldKey) else { return }
        store(data: d, forKey: newKey)
    }

    func clearAll() {
        memory.removeAllObjects()
        do {
            try FileManager.default.removeItem(at: diskDir)
        } catch CocoaError.fileNoSuchFile {
            // The disk cache directory is already gone; recreate it below.
        } catch {
            DiagnosticLog.log("attachment cache clear failed", tag: "cache.attachments", level: .warn, fields: [
                "error": error.localizedDescription
            ])
        }
        createDiskDir()
    }
}
