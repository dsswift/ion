import XCTest
@testable import IonRemote

/// The automations section: listing decoding, each call's arguments
/// (`server/src/protocol/misc-actions.ts`), and the screen model's verbs.
@MainActor
final class AutomationsAdminTests: XCTestCase {

    private let caller = FakeActionCaller(scopes: nil)
    private var client: ServerAdminClient { ServerAdminClient(serverLabel: "Studio Mac", caller: caller) }
    private let ok = JSONValue.object(["ok": .bool(true)])

    private func answerLoad(locked: Bool = false) {
        var listing = IntegrationsFixtures.json(IntegrationsFixtures.listing)
        if locked, case .object(var fields) = listing { fields["locked"] = .bool(true); listing = .object(fields) }
        caller.answer(.automationListing, with: .success(listing))
        caller.answer(.automationHistory, with: .success(IntegrationsFixtures.json(IntegrationsFixtures.history)))
        caller.answer(.policyGetFull, with: .success(IntegrationsFixtures.json(#"{"customFields":{"ion-desktop":{"automation":{"authorizeAiActions":true}}}}"#)))
        caller.answer(.environmentProjectsList, with: .success(.array([])))
    }

    func testTheListingDecodesEverySourceAndTheLegacyActions() async throws {
        answerLoad()
        let listing = try await client.automationListing()
        XCTAssertEqual(listing.entries.map(\.source), [.user, .project, .builtIn])
        XCTAssertEqual(listing.entries[2].overriddenBy, .enterprise)
        XCTAssertEqual(AutomationDraft.steps(listing.entries[2].definition), [.action(AutomationAction(kind: "record"))])
        XCTAssertEqual(AutomationsAdminModel.isEnabled(listing.entries[1]), false, "a locally disabled project rule reads off")
    }

    func testEachCallSendsTheArgumentsTheHandlerReads() async throws {
        answerLoad()
        let copy = IntegrationsFixtures.json(IntegrationsFixtures.userRule)
        caller.answer(.automationDuplicate, with: .success(.object(["ok": .bool(true), "definition": copy])))
        caller.answer(.automationUpsert, with: .success(.object(["ok": .bool(true), "definition": copy])))
        caller.answer(.automationDelete, with: .success(ok))
        caller.answer(.automationSetProjectEnabled, with: .success(ok))
        let rule = try copy.decoded(as: AutomationDefinition.self)
        _ = try await client.automationListing(projectPath: "/repo")
        _ = try await client.automationListing(projectPath: "")
        _ = try await client.duplicateAutomation(id: "b1", projectPath: "/repo")
        _ = try await client.duplicateAutomation(id: "b1")
        try await client.upsertAutomation(rule)
        try await client.deleteAutomation(id: "user.a")
        try await client.setProjectAutomationEnabled(projectPath: "/repo", id: "p1", enabled: true)
        XCTAssertEqual(caller.calls, [
            .init(action: "automation.listing", args: [.string("/repo")]),
            .init(action: "automation.listing", args: []),
            .init(action: "automation.duplicate", args: [.object(["id": .string("b1"), "projectPath": .string("/repo")])]),
            .init(action: "automation.duplicate", args: [.object(["id": .string("b1")])]),
            .init(action: "automation.upsert", args: [copy]),
            .init(action: "automation.delete", args: [.string("user.a")]),
            .init(action: "automation.setProjectEnabled", args: [.object(["projectPath": .string("/repo"), "id": .string("p1"), "enabled": .bool(true)])]),
        ])
    }

    func testARefusedChangeThrowsTheServersReason() async {
        caller.answer(.automationDelete, with: .success(.object(["ok": .bool(false), "error": .string("invalid automation id")])))
        do {
            try await client.deleteAutomation(id: "")
            XCTFail("expected a refusal")
        } catch {
            XCTAssertEqual(error.localizedDescription, "invalid automation id")
        }
    }

    func testTheModelLoadsListingRunsAndPolicy() async {
        answerLoad()
        let model = AutomationsAdminModel(serverId: "s", serverLabel: "Studio Mac", client: client)
        XCTAssertNil(model.listing)
        XCTAssertNil(model.recentRuns)
        await model.load()
        XCTAssertEqual(model.listing?.entries.count, 3)
        XCTAssertEqual(model.recentRuns?.map(\.id), ["h0", "h1"], "newest first")
        XCTAssertEqual(model.aiActionsAuthorized, true)
        XCTAssertEqual(model.name(for: "user.a"), "My rule")
        XCTAssertEqual(model.name(for: "gone"), "gone")
    }

    func testTogglingAUserRuleSavesItFlippedAndAProjectRuleUsesItsOwnVerb() async throws {
        answerLoad()
        caller.answer(.automationUpsert, with: .success(ok))
        caller.answer(.automationSetProjectEnabled, with: .success(ok))
        let model = AutomationsAdminModel(serverId: "s", serverLabel: "Studio Mac", client: client)
        await model.setProjectPath("/repo")
        let entries = try XCTUnwrap(model.listing?.entries)
        await model.toggle(entries[0])
        let upsert = try XCTUnwrap(caller.calls.last { $0.action == "automation.upsert" })
        XCTAssertEqual(upsert.args.first?["enabled"], .bool(false))
        await model.toggle(entries[1])
        XCTAssertEqual(caller.calls.last { $0.action == "automation.setProjectEnabled" }?.args,
                       [.object(["projectPath": .string("/repo"), "id": .string("p1"), "enabled": .bool(true)])])
        XCTAssertFalse(model.canToggle(entries[2]), "a built-in rule has no switch")
        XCTAssertNil(model.operationError)
    }

    func testALockedListingOffersNoChanges() async throws {
        answerLoad(locked: true)
        let model = AutomationsAdminModel(serverId: "s", serverLabel: "Studio Mac", client: client)
        await model.load()
        let entries = try XCTUnwrap(model.listing?.entries)
        XCTAssertTrue(model.locked)
        XCTAssertFalse(model.canToggle(entries[0]))
        XCTAssertFalse(model.isEditable(entries[0]))
    }

    func testWithoutOperateScopeASaveIsRefusedBeforeItIsSent() async throws {
        let reader = FakeActionCaller(scopes: ["conversations:read"])
        let model = AutomationsAdminModel(serverId: "s", serverLabel: "Studio Mac", client: ServerAdminClient(serverLabel: "Studio Mac", caller: reader))
        let rule = try IntegrationsFixtures.json(IntegrationsFixtures.userRule).decoded(as: AutomationDefinition.self)
        let saved = await model.save(rule)
        XCTAssertFalse(saved)
        XCTAssertNotNil(model.operationError)
        XCTAssertFalse(reader.calls.contains { $0.action == "automation.upsert" })
    }

    func testTheEditorKeepsBranchesAndValidatesBeforeSave() throws {
        let rule = try IntegrationsFixtures.json(IntegrationsFixtures.userRule).decoded(as: AutomationDefinition.self)
        let editor = AutomationEditorModel(definition: rule, isNew: false)
        XCTAssertEqual(editor.title, "Edit My rule")
        XCTAssertEqual(editor.branchCount, 1)
        XCTAssertNil(editor.validationError)
        editor.addAction()
        editor.setActionKind("desktop:notification", at: 1)
        XCTAssertEqual(editor.validationError, "Show a desktop notification requires Title")
        editor.setConfig("title", to: .string("Done"), at: 1)
        XCTAssertNil(editor.validationError)
        editor.moveActions(from: [1], to: 0)
        XCTAssertEqual(editor.actions.map(\.kind), ["desktop:notification", "worktree:set-stage"])
        XCTAssertEqual(editor.branchCount, 1, "branches stay after the plain actions")
        let blank = AutomationEditorModel(definition: AutomationDraft.blank(), isNew: true)
        XCTAssertEqual(blank.validationError, "Select an event first.")
    }
}
