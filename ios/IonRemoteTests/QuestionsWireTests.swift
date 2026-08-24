import XCTest
@testable import IonRemote

/// Wire codec + store behavior tests for Guided Questions:
///   - desktop_questions_state decodes to .questionsState with the full
///     workflow shape (lockstep with the desktop's protocol-questions.ts)
///   - RemoteCommand questionsPatch/questionsAction/questionsRefresh encode
///     the desktop_ TypeKeys with the nested revisioned payloads
///   - QuestionsStore revision rules (newer replaces, older ignored),
///     snapshot merge, and tab/pairing lifecycle cleanup
///   - the shared display resolver matches the desktop rule (pinned there by
///     questions-schema.test.ts)
final class QuestionsWireTests: XCTestCase {

    // MARK: - Fixtures

    private func workflowJSON(revision: Int = 3, phase: String = "collecting") -> String {
        """
        {
          "workflowId": "wf-1",
          "requestId": "tool-gate-1-1",
          "sessionKey": "tab-1",
          "phase": "\(phase)",
          "request": {
            "title": "Scope check",
            "description": "What we found so far",
            "questions": [
              {
                "id": "q1",
                "prompt": "Which storage backend?",
                "mode": "single",
                "display": "radio",
                "options": [
                  { "id": "a", "label": "SQLite", "description": "simple" },
                  { "id": "b", "label": "Postgres" }
                ]
              },
              { "id": "q2", "prompt": "Anything else?", "mode": "text" }
            ]
          },
          "draft": [
            { "questionId": "q1", "selectedOptionIds": ["a"] },
            { "questionId": "q2", "selectedOptionIds": [], "customText": "notes" }
          ],
          "history": [],
          "revision": \(revision),
          "startedAt": 1784000000000
        }
        """
    }

    private func stateEventJSON(revision: Int = 3) -> Data {
        Data("""
        {
          "type": "desktop_questions_state",
          "tabId": "tab-1",
          "state": {
            "workflows": [\(workflowJSON(revision: revision))],
            "lastActionResult": { "actionId": "a1", "accepted": true }
          }
        }
        """.utf8)
    }

    // MARK: - Event decode

    func testQuestionsStateDecodes() throws {
        let event = try JSONDecoder().decode(RemoteEvent.self, from: stateEventJSON())
        guard case let .questionsState(tabId, state) = event else {
            return XCTFail("expected .questionsState, got \(event)")
        }
        XCTAssertEqual(tabId, "tab-1")
        XCTAssertEqual(state.workflows.count, 1)
        let workflow = try XCTUnwrap(state.workflows.first)
        XCTAssertEqual(workflow.workflowId, "wf-1")
        XCTAssertEqual(workflow.requestId, "tool-gate-1-1")
        XCTAssertEqual(workflow.phase, "collecting")
        XCTAssertEqual(workflow.revision, 3)
        XCTAssertEqual(workflow.request.questions.count, 2)
        XCTAssertEqual(workflow.request.questions[0].options?.count, 2)
        XCTAssertEqual(workflow.draft[0].selectedOptionIds, ["a"])
        XCTAssertEqual(state.lastActionResult?.accepted, true)
        XCTAssertTrue(workflow.isOpen)
    }

    func testRemoteTabStateCarriesQuestions() throws {
        let json = Data("""
        {
          "id": "tab-1", "title": "T", "status": "waiting",
          "workingDirectory": "/tmp", "permissionMode": "auto",
          "permissionQueue": [], "queuedPrompts": [],
          "questions": [\(workflowJSON())]
        }
        """.utf8)
        let tab = try JSONDecoder().decode(RemoteTabState.self, from: json)
        XCTAssertEqual(tab.questions?.count, 1)
        XCTAssertEqual(tab.questions?.first?.workflowId, "wf-1")
    }

    // MARK: - Command encode

    func testQuestionsCommandsEncodeDesktopTypeKeys() throws {
        let patch = QuestionsPatch(
            workflowId: "wf-1", requestId: "req-1", expectedRevision: 3,
            actionId: "act-1",
            answers: [QuestionDraftAnswer(questionId: "q1", selectedOptionIds: ["a"], customText: nil, skipped: nil, attachments: nil)],
            comment: "note"
        )
        let patchData = try JSONEncoder().encode(RemoteCommand.questionsPatch(tabId: "tab-1", patch: patch))
        let patchObj = try XCTUnwrap(JSONSerialization.jsonObject(with: patchData) as? [String: Any])
        XCTAssertEqual(patchObj["type"] as? String, "desktop_questions_patch")
        XCTAssertEqual(patchObj["tabId"] as? String, "tab-1")
        let patchBody = try XCTUnwrap(patchObj["patch"] as? [String: Any])
        XCTAssertEqual(patchBody["expectedRevision"] as? Int, 3)
        XCTAssertEqual(patchBody["workflowId"] as? String, "wf-1")

        // The atomic submit shape: the action carries the final draft inline
        // (answers + comment) so the desktop applies draft + transition in
        // one revision step — the CAS-race fix for "Review answers".
        let action = QuestionsAction(
            workflowId: "wf-1", requestId: "req-1", expectedRevision: 4,
            actionId: "act-2", kind: "final_confirm", questionId: nil,
            answers: [QuestionDraftAnswer(questionId: "q1", selectedOptionIds: ["a"], customText: "extra", skipped: nil, attachments: nil)],
            comment: "final note"
        )
        let actionData = try JSONEncoder().encode(RemoteCommand.questionsAction(tabId: "tab-1", action: action))
        let actionObj = try XCTUnwrap(JSONSerialization.jsonObject(with: actionData) as? [String: Any])
        XCTAssertEqual(actionObj["type"] as? String, "desktop_questions_action")
        let actionBody = try XCTUnwrap(actionObj["action"] as? [String: Any])
        XCTAssertEqual(actionBody["kind"] as? String, "final_confirm")
        let inlineAnswers = try XCTUnwrap(actionBody["answers"] as? [[String: Any]])
        XCTAssertEqual(inlineAnswers.first?["customText"] as? String, "extra")
        XCTAssertEqual(actionBody["comment"] as? String, "final note")

        let refreshData = try JSONEncoder().encode(RemoteCommand.questionsRefresh(tabId: "tab-1"))
        let refreshObj = try XCTUnwrap(JSONSerialization.jsonObject(with: refreshData) as? [String: Any])
        XCTAssertEqual(refreshObj["type"] as? String, "desktop_questions_refresh")
    }

    // MARK: - Store revision rules

    @MainActor
    func testStoreRevisionRules() throws {
        let store = QuestionsStore()
        let decoder = JSONDecoder()

        func snapshot(revision: Int) throws -> QuestionsStateSnapshot {
            let event = try decoder.decode(RemoteEvent.self, from: stateEventJSON(revision: revision))
            guard case let .questionsState(_, state) = event else { throw XCTSkip("decode shape") }
            return state
        }

        store.applyStateEvent(tabId: "tab-1", state: try snapshot(revision: 3))
        XCTAssertEqual(store.currentWorkflow(tabId: "tab-1")?.revision, 3)

        // Newer replaces.
        store.applyStateEvent(tabId: "tab-1", state: try snapshot(revision: 5))
        XCTAssertEqual(store.currentWorkflow(tabId: "tab-1")?.revision, 5)

        // Older (delayed frame) is ignored — accepted state never rolls back.
        store.applyStateEvent(tabId: "tab-1", state: try snapshot(revision: 4))
        XCTAssertEqual(store.currentWorkflow(tabId: "tab-1")?.revision, 5)

        // Equal is an acknowledgement (applies cleanly).
        store.applyStateEvent(tabId: "tab-1", state: try snapshot(revision: 5))
        XCTAssertEqual(store.currentWorkflow(tabId: "tab-1")?.revision, 5)
    }

    @MainActor
    func testStoreSnapshotMergeAndLifecycle() throws {
        let store = QuestionsStore()
        let workflow = try JSONDecoder().decode(QuestionsWorkflowState.self, from: Data(workflowJSON().utf8))

        store.replaceFromSnapshot(tabId: "tab-1", workflows: [workflow])
        XCTAssertTrue(store.hasActiveQuestions(tabId: "tab-1"))

        // Snapshot with nil clears (authoritative absence).
        store.replaceFromSnapshot(tabId: "tab-1", workflows: nil)
        XCTAssertFalse(store.hasActiveQuestions(tabId: "tab-1"))

        // Tab close removes tab-scoped state.
        store.replaceFromSnapshot(tabId: "tab-1", workflows: [workflow])
        store.removeTab("tab-1")
        XCTAssertFalse(store.hasActiveQuestions(tabId: "tab-1"))

        // Pairing switch clears everything.
        store.replaceFromSnapshot(tabId: "tab-1", workflows: [workflow])
        store.clearAll()
        XCTAssertFalse(store.hasActiveQuestions(tabId: "tab-1"))
        XCTAssertNil(store.lastActionResult)
    }

    // MARK: - Display resolver parity

    func testResolvedDisplayMatchesSharedRule() {
        func spec(mode: String, display: String? = nil, optionCount: Int, described: Bool = false) -> QuestionSpec {
            let options = (0..<optionCount).map {
                QuestionOption(id: "o\($0)", label: "Option \($0)", description: described ? "why" : nil)
            }
            return QuestionSpec(id: "q", prompt: "p", guidance: nil, mode: mode, display: display, options: options)
        }
        // Explicit valid hint wins.
        XCTAssertEqual(spec(mode: "single", display: "pills", optionCount: 2).resolvedDisplay, "pills")
        // Invalid hint for the mode falls through.
        XCTAssertEqual(spec(mode: "single", display: "checkbox", optionCount: 2).resolvedDisplay, "radio")
        // >5 undescribed options → pills.
        XCTAssertEqual(spec(mode: "single", optionCount: 6).resolvedDisplay, "pills")
        XCTAssertEqual(spec(mode: "multiple", optionCount: 7).resolvedDisplay, "pills")
        // ≤5 → radio/checkbox.
        XCTAssertEqual(spec(mode: "single", optionCount: 5).resolvedDisplay, "radio")
        XCTAssertEqual(spec(mode: "multiple", optionCount: 5).resolvedDisplay, "checkbox")
        // Described options force rows regardless of count.
        XCTAssertEqual(spec(mode: "single", optionCount: 8, described: true).resolvedDisplay, "radio")
    }

    // MARK: - Status rollup

    func testGuidedWaitDrivesQuestionStatus() throws {
        let json = Data("""
        {
          "id": "tab-1", "title": "T", "status": "waiting",
          "workingDirectory": "/tmp", "permissionMode": "auto",
          "permissionQueue": [], "queuedPrompts": [],
          "questions": [\(workflowJSON())]
        }
        """.utf8)
        let tab = try JSONDecoder().decode(RemoteTabState.self, from: json)
        XCTAssertEqual(TabStatusRollup.classify(tab).state, .question)
    }
}
