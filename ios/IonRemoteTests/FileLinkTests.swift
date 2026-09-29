import XCTest
@testable import IonRemote

/// A file path in a message: what the phone can preview, how it is drawn so a
/// long press gets its own menu, and what a tap, Preview, or Download does
/// with a path that lives on the server.
final class FileLinkTests: XCTestCase {

    // MARK: - Kind

    func testPreviewableFilesAndTheRest() {
        XCTAssertEqual(FileLinkKind.of("docs/plan.md"), .text)
        XCTAssertEqual(FileLinkKind.of("/a/config.json"), .text)
        XCTAssertEqual(FileLinkKind.of("Makefile"), .text)
        XCTAssertEqual(FileLinkKind.of("/a/shot.png"), .quickLook)
        XCTAssertEqual(FileLinkKind.of("/a/spec.pdf"), .quickLook)
        XCTAssertEqual(FileLinkKind.of("/a/Report.docx"), .quickLook)
        XCTAssertEqual(FileLinkKind.of("/a/tier-review.xlsx"), .quickLook)
        XCTAssertEqual(FileLinkKind.of("/a/archive.zip"), .other)
        XCTAssertFalse(FileLinkKind.of("/a/archive.zip").canPreview)
    }

    // MARK: - Prose detection

    @MainActor
    func testPathsAndAddressesInProseBecomeLinks() {
        let text = MarkdownFormatter.renderProseText("Updated ~/.ion/notes.md and /srv/app/main.go, see https://example.com/docs.")
        let links = text.runs.compactMap { run in run.link.map { (String(text[run.range].characters), $0) } }
        XCTAssertEqual(links.map(\.0), ["~/.ion/notes.md", "/srv/app/main.go", "https://example.com/docs"])
        XCTAssertEqual(FilePathDetector.path(from: links[0].1), "~/.ion/notes.md")
        XCTAssertEqual(FilePathDetector.path(from: links[1].1), "/srv/app/main.go")
        XCTAssertEqual(links[2].1.absoluteString, "https://example.com/docs")
        // Nothing is lost: the sentence reads the same.
        XCTAssertEqual(String(text.characters), "Updated ~/.ion/notes.md and /srv/app/main.go, see https://example.com/docs.")
    }

    @MainActor
    func testProseWithoutPathsStaysPlain() {
        XCTAssertFalse(LinkableTextRenderer.hasLinks(MarkdownFormatter.renderProseText("and/or a plain sentence")))
    }

    // MARK: - UIKit rendering

    @MainActor
    func testRendererKeepsLinksAndInlineStyling() {
        guard case .paragraph(let text)? = MarkdownFormatter.parse("**Done** with `src/app.ts` and *more*").first else {
            return XCTFail("expected a paragraph")
        }
        XCTAssertTrue(LinkableTextRenderer.hasLinks(text))
        let rendered = LinkableTextRenderer.render(text, style: .init())
        let ns = rendered.string as NSString
        let bold = rendered.attribute(.font, at: ns.range(of: "Done").location, effectiveRange: nil) as? UIFont
        XCTAssertTrue(bold?.fontDescriptor.symbolicTraits.contains(.traitBold) == true)
        let codeAt = ns.range(of: "src/app.ts").location
        XCTAssertNotNil(rendered.attribute(.link, at: codeAt, effectiveRange: nil))
        let code = rendered.attribute(.font, at: codeAt, effectiveRange: nil) as? UIFont
        XCTAssertTrue(code?.fontDescriptor.symbolicTraits.contains(.traitMonoSpace) == true)
        let italic = rendered.attribute(.font, at: ns.range(of: "more").location, effectiveRange: nil) as? UIFont
        XCTAssertTrue(italic?.fontDescriptor.symbolicTraits.contains(.traitItalic) == true)
    }

    // MARK: - Local copy

    func testCopyNameNeverLeavesItsFolder() throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("file-link-tests-\(UUID().uuidString)")
        defer { XCTAssertNoThrow(try FileManager.default.removeItem(at: root)) }
        XCTAssertEqual(RemoteFileCopy.safeName("../../etc/passwd"), "passwd")
        XCTAssertEqual(RemoteFileCopy.safeName(".."), "file")
        let copy = try RemoteFileCopy.write(Data("x".utf8), name: "../escape.txt", root: root)
        XCTAssertTrue(copy.path.hasPrefix(root.path))
        XCTAssertEqual(try Data(contentsOf: copy), Data("x".utf8))
    }

    // MARK: - Outcome

    private let caller = FakeActionCaller(scopes: nil)
    private var client: ServerAdminClient { ServerAdminClient(serverLabel: "Studio Mac", caller: caller) }

    private func target(_ path: String, size: Int = 4, exists: Bool = true) -> JSONValue {
        .object(["path": .string(path), "exists": .bool(exists), "isDirectory": .bool(false), "size": .int(size)])
    }

    @MainActor
    func testTextFileOpensInIonsViewerAtTheServersPath() async {
        caller.answer(.fsResolveLink, with: .success(target("/home/remote/.ion/notes.md")))
        let outcome = await SessionViewModel().fileLinkOutcome(client: client, tabId: "tab-1", path: "~/.ion/notes.md", cwd: "/srv/app", request: .open)
        XCTAssertEqual(outcome, .showText(path: "/home/remote/.ion/notes.md"))
        XCTAssertEqual(caller.calls, [.init(action: "fs.resolveLink", args: [.object(["tabId": .string("tab-1"), "path": .string("~/.ion/notes.md"), "cwd": .string("/srv/app")])])])
    }

    @MainActor
    func testDownloadFetchesTheBytesAndOffersThemToFiles() async throws {
        caller.answer(.fsResolveLink, with: .success(target("/srv/app/Report.docx")))
        caller.answer(.fsReadFileData, with: .success(.object(["base64": .string("UEsDBA=="), "size": .int(4)])))
        let outcome = await SessionViewModel().fileLinkOutcome(client: client, tabId: "tab-1", path: "Report.docx", cwd: "/srv/app", request: .download)
        guard case .export(let url) = outcome else { return XCTFail("expected an export, got \(outcome)") }
        XCTAssertEqual(url.lastPathComponent, "Report.docx")
        XCTAssertEqual(try Data(contentsOf: url), Data(base64Encoded: "UEsDBA=="))
        XCTAssertEqual(caller.calls.last, .init(action: "fs.readFileData", args: [.object(["tabId": .string("tab-1"), "filePath": .string("/srv/app/Report.docx")])]))
    }

    @MainActor
    func testTapPreviewsWhatQuickLookShowsAndDownloadsTheRest() async {
        caller.answer(.fsResolveLink, with: .success(target("/srv/app/shot.png")))
        caller.answer(.fsReadFileData, with: .success(.object(["base64": .string("iVBORw=="), "size": .int(4)])))
        let preview = await SessionViewModel().fileLinkOutcome(client: client, tabId: "tab-1", path: "shot.png", cwd: "/srv/app", request: .open)
        guard case .quickLook = preview else { return XCTFail("expected Quick Look, got \(preview)") }

        caller.answer(.fsResolveLink, with: .success(target("/srv/app/archive.zip")))
        let download = await SessionViewModel().fileLinkOutcome(client: client, tabId: "tab-1", path: "archive.zip", cwd: "/srv/app", request: .open)
        guard case .export = download else { return XCTFail("expected an export, got \(download)") }
    }

    @MainActor
    func testMissingAndOversizeFilesFetchNothing() async {
        caller.answer(.fsResolveLink, with: .success(target("/srv/app/gone.md", exists: false)))
        let missing = await SessionViewModel().fileLinkOutcome(client: client, tabId: "tab-1", path: "gone.md", cwd: "/srv/app", request: .preview)
        caller.answer(.fsResolveLink, with: .success(target("/srv/app/huge.pdf", size: ServerAdminClient.maxFileDataBytes + 1)))
        let huge = await SessionViewModel().fileLinkOutcome(client: client, tabId: "tab-1", path: "huge.pdf", cwd: "/srv/app", request: .download)
        XCTAssertEqual(missing, .none)
        XCTAssertEqual(huge, .none)
        XCTAssertFalse(caller.calls.contains { $0.action == "fs.readFileData" })
    }
}
