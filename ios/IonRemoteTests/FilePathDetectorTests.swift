import XCTest
@testable import IonRemote

final class FilePathDetectorTests: XCTestCase {
    // MARK: - Positives

    func testDetectsRelativePathWithSlash() {
        let ref = FilePathDetector.detect("src/a.ts")
        XCTAssertEqual(ref, FilePathRef(path: "src/a.ts", line: nil, column: nil))
    }

    func testDetectsPathWithLineNumber() {
        let ref = FilePathDetector.detect("index.css:124")
        XCTAssertEqual(ref, FilePathRef(path: "index.css", line: 124, column: nil))
    }

    func testDetectsPathWithLineAndColumn() {
        let ref = FilePathDetector.detect("pkg/main.go:10:4")
        XCTAssertEqual(ref, FilePathRef(path: "pkg/main.go", line: 10, column: 4))
    }

    func testDetectsAbsoluteAndHomeRelativePaths() {
        XCTAssertEqual(FilePathDetector.detect("/etc/hosts.conf")?.path, "/etc/hosts.conf")
        XCTAssertEqual(FilePathDetector.detect("~/notes/todo.md")?.path, "~/notes/todo.md")
    }

    // MARK: - Negatives

    func testRejectsProse() {
        XCTAssertNil(FilePathDetector.detect("hello"))
        XCTAssertNil(FilePathDetector.detect("two words here"))
        XCTAssertNil(FilePathDetector.detect(""))
    }

    func testRejectsUrls() {
        XCTAssertNil(FilePathDetector.detect("https://x.com"))
        XCTAssertNil(FilePathDetector.detect("http://example.com/a.ts"))
    }

    func testRejectsBareNamesWithUnknownExtensions() {
        // Without a slash, only known code/text extensions count — prose
        // like "e.g." or "v1.2" must not become chips.
        XCTAssertNil(FilePathDetector.detect("e.g."))
        XCTAssertNil(FilePathDetector.detect("v1.2"))
        XCTAssertNotNil(FilePathDetector.detect("main.go"))
    }

    // MARK: - URL round-trip

    func testUrlRoundTripPreservesRelativePaths() throws {
        let ref = try XCTUnwrap(FilePathDetector.detect("src/a.ts:12"))
        let url = try XCTUnwrap(FilePathDetector.url(for: ref))
        XCTAssertEqual(url.scheme, "ion-file")
        XCTAssertEqual(FilePathDetector.path(from: url), "src/a.ts")
    }

    func testUrlRoundTripPreservesAbsolutePaths() throws {
        let ref = try XCTUnwrap(FilePathDetector.detect("/opt/app/config.yaml"))
        let url = try XCTUnwrap(FilePathDetector.url(for: ref))
        XCTAssertEqual(FilePathDetector.path(from: url), "/opt/app/config.yaml")
    }

    func testPathFromRejectsForeignSchemes() {
        XCTAssertNil(FilePathDetector.path(from: URL(string: "https://example.com/x")!))
    }
}
