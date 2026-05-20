import UIKit

/// Caches compressed image data for attachment previews.
/// In-memory NSCache backed by a disk cache in Caches/ion-attachments/.
final class AttachmentImageCache: @unchecked Sendable {
    static let shared = AttachmentImageCache()

    private let memory = NSCache<NSString, NSData>()
    private let diskDir: URL

    private init() {
        memory.countLimit = 20
        let caches = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask).first!
        diskDir = caches.appendingPathComponent("ion-attachments", isDirectory: true)
        try? FileManager.default.createDirectory(at: diskDir, withIntermediateDirectories: true)
    }

    private func diskURL(forKey key: String) -> URL {
        diskDir.appendingPathComponent(key)
    }

    func store(data: Data, forKey key: String) {
        memory.setObject(data as NSData, forKey: key as NSString)
        try? data.write(to: diskURL(forKey: key), options: .atomic)
    }

    func data(forKey key: String) -> Data? {
        if let cached = memory.object(forKey: key as NSString) {
            return cached as Data
        }
        let url = diskURL(forKey: key)
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
        try? FileManager.default.removeItem(at: diskDir)
        try? FileManager.default.createDirectory(at: diskDir, withIntermediateDirectories: true)
    }
}
