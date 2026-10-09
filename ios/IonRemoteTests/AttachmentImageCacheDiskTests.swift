import XCTest
@testable import IonRemote

/// An image must survive the in-memory cache being emptied, whatever its key
/// looks like. A second cache over the same directory has no memory of the
/// first, so it can only answer from disk.
final class AttachmentImageCacheDiskTests: XCTestCase {

    private var directory: URL!

    override func setUp() {
        directory = FileManager.default.temporaryDirectory
            .appendingPathComponent("attachment-cache-\(UUID().uuidString)", isDirectory: true)
    }

    override func tearDownWithError() throws {
        try FileManager.default.removeItem(at: directory)
    }

    func testAnAbsolutePathKeyIsReadBackFromDisk() {
        let key = "/Users/example/.ion/user-attachments/0123abcd.jpeg"
        let bytes = Data([1, 2, 3, 4])
        AttachmentImageCache(directory: directory).store(data: bytes, forKey: key)

        XCTAssertEqual(AttachmentImageCache(directory: directory).data(forKey: key), bytes)
    }

    func testRekeyedBytesAreReadBackFromDisk() {
        let bytes = Data([9, 8, 7])
        let first = AttachmentImageCache(directory: directory)
        first.store(data: bytes, forKey: "placeholder-1")
        first.rekey(from: "placeholder-1", to: "/Users/example/.ion/user-attachments/final.jpeg")

        XCTAssertEqual(
            AttachmentImageCache(directory: directory).data(forKey: "/Users/example/.ion/user-attachments/final.jpeg"),
            bytes
        )
    }

    func testFilesStoredUnderARawKeyAreRemoved() throws {
        _ = AttachmentImageCache(directory: directory)
        let stale = directory.appendingPathComponent("placeholder-from-an-older-build")
        try Data([1]).write(to: stale)

        _ = AttachmentImageCache(directory: directory)
        XCTAssertFalse(FileManager.default.fileExists(atPath: stale.path))
    }
}
