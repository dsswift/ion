import XCTest
@testable import IonRemote

/// Phase 7 of the #256 iOS unification: the no-divergence guard.
///
/// The unification collapsed the plain-tab loose dictionaries and the
/// engine-tab parallel maps into one per-tab ConversationInstanceInfo. This
/// guard asserts the removed top-level symbols cannot silently regrow on
/// SessionViewModel — if a future change re-introduces `messages`,
/// `liveText`, `engineWorkingMessages`, `engineConversationLoaded`,
/// `thinkingInProgress`, or `engineDraftInputByKey` as stored properties, the
/// source-level check here fails, flagging the divergence before it ships.
///
/// (A reflection-based check can't see the absence of a property, so this
/// guards the declaration site in source — the same approach the merged-view
/// guard test uses.)
final class UnifiedConversationDivergenceGuardTests: XCTestCase {

    private func sessionViewModelSource() throws -> String {
        // .../ios/IonRemoteTests/<thisfile> -> .../ios/IonRemote/ViewModels/SessionViewModel.swift
        let url = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .appendingPathComponent("IonRemote/ViewModels/SessionViewModel.swift")
        return try String(contentsOf: url, encoding: .utf8)
    }

    func testRemovedDivergentStoresDoNotReappear() throws {
        let src = try sessionViewModelSource()
        let forbidden = [
            "var messages: [String: [Message]]",
            "var liveText: [String: String]",
            "var engineWorkingMessages: [String: String]",
            "var engineConversationLoaded: Set<String>",
            "var thinkingInProgress: [String: String]",
            "var engineDraftInputByKey: [String: String]",
        ]
        for decl in forbidden {
            XCTAssertFalse(src.contains(decl),
                "Divergent store re-introduced: `\(decl)`. Post-#256 conversation state lives on the single per-tab ConversationInstanceInfo (see SessionViewModel+Conversation.swift).")
        }
    }

    func testUnifiedAccessorsExist() throws {
        // The single store is reached through these accessors — their presence
        // is the positive half of the contract.
        let url = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .appendingPathComponent("IonRemote/ViewModels/SessionViewModel+Conversation.swift")
        let src = try String(contentsOf: url, encoding: .utf8)
        for accessor in ["func conversationMessages", "func ensureMainInstance"] {
            XCTAssertTrue(src.contains(accessor),
                "Unified accessor missing: \(accessor)")
        }
    }

    func testVestigialCompoundKeyHelpersDoNotReappear() throws {
        // The compound-key indirection helpers were inlined to bare tabId during
        // the post-#256 cleanup. They must not silently regrow — a reintroduced
        // `engineCompoundKey` / `resolveEngineKey` / `resolveInstanceId` would
        // re-open the dormant divergence the cleanup closed. (parseEngineSessionKey
        // is deliberately retained for legacy cached-key tolerance and is NOT
        // listed here.)
        let dir = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .appendingPathComponent("IonRemote")
        let files = FileManager.default.enumerator(at: dir, includingPropertiesForKeys: nil)?
            .compactMap { $0 as? URL }
            .filter { $0.pathExtension == "swift" } ?? []
        for fn in ["func engineCompoundKey", "func resolveEngineKey", "func resolveInstanceId"] {
            for file in files {
                let src = (try? String(contentsOf: file, encoding: .utf8)) ?? ""
                XCTAssertFalse(src.contains(fn),
                    "Vestigial compound-key helper reintroduced (`\(fn)`) in \(file.lastPathComponent). Engine session state is keyed by bare tabId with a single instance — use the unified accessors instead.")
            }
        }
    }

    /// A conversation's rows are the server's transcript, and exactly one
    /// file writes them. A handler that appends or edits a row from an
    /// engine event would bring back the second transcript builder the
    /// phone used to have, and with it every way the two drifted apart.
    func testOnlyTheTranscriptFileWritesConversationRows() throws {
        let dir = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .appendingPathComponent("IonRemote")
        let files = FileManager.default.enumerator(at: dir, includingPropertiesForKeys: nil)?
            .compactMap { $0 as? URL }
            .filter { $0.pathExtension == "swift" && $0.lastPathComponent != "SessionViewModel+Transcript.swift" } ?? []
        XCTAssertFalse(files.isEmpty)
        var writes: [String] = []
        for owner in ["inst.", "$0.", "instance.", "prior.", "[0]."] {
            for op in ["messages.append(", "messages = ", "messages += ", "messages.insert(", "messages.remove", "messages.replaceSubrange("] {
                writes.append(owner + op)
            }
        }
        for file in files {
            let src = try String(contentsOf: file, encoding: .utf8)
            for write in writes where src.contains(write) {
                XCTFail("\(file.lastPathComponent) writes conversation rows (`\(write)`). Rows come only from the server's transcript: SessionViewModel+Transcript.swift.")
            }
        }
    }
}
