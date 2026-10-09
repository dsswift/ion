import XCTest
@testable import IonRemote

/// A tapped Explorer file opens in the image viewer when it is an image the
/// phone can decode, and in the text editor otherwise.
final class FileExplorerDestinationTests: XCTestCase {

    private func entry(_ name: String, isDirectory: Bool = false) -> FsEntry {
        FsEntry(name: name, path: "/project/\(name)", isDirectory: isDirectory, size: 1, modifiedMs: 0, isHidden: false)
    }

    func testRasterImagesOpenInTheImageViewer() {
        for name in ["a.png", "a.jpg", "a.jpeg", "a.gif", "a.webp", "a.ico", "a.bmp", "a.tiff", "SHOUT.PNG"] {
            XCTAssertEqual(FileExplorerRowView.destination(for: entry(name)), .image, name)
        }
    }

    func testTextFilesOpenInTheEditor() {
        for name in ["a.swift", "README.md", "a.svg", "png", "Makefile"] {
            XCTAssertEqual(FileExplorerRowView.destination(for: entry(name)), .editor, name)
        }
    }

    func testADirectoryNamedLikeAnImageIsNotAnImage() {
        XCTAssertFalse(entry("shots.png", isDirectory: true).isImage)
    }
}
