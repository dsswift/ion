import XCTest
@testable import IonRemote

/// Cross-client parity for the injection-suppression opinion.
///
/// `InjectionPolicy` (iOS) and `suppressesInjection` in
/// `desktop/src/shared/injection-policy.ts` must reach identical verdicts. If
/// they diverge, the same conversation renders differently on the phone than on
/// the desktop, which is the class of defect this whole change removes — the
/// two clients previously carried four hand-copied kind lists between them, and
/// they had already drifted apart.
///
/// The expectation table below is deliberately the SAME table as the desktop's
/// `KIND_EXPECTATIONS` in `injection-policy.test.ts`. Keep them in step: a kind
/// added to the engine is added to both.
final class InjectionPolicyTests: XCTestCase {

    private struct Expectation {
        let kind: String
        let machineAuthored: Bool
        let suppressed: Bool
    }

    /// Every kind the engine enumerates (types/injection_kind.go) with the
    /// client's expected verdict.
    private let expectations: [Expectation] = [
        Expectation(kind: "", machineAuthored: false, suppressed: false),
        Expectation(kind: "agent_completion", machineAuthored: true, suppressed: true),
        Expectation(kind: "slash_command", machineAuthored: true, suppressed: true),
        Expectation(kind: "background_task_completion", machineAuthored: true, suppressed: true),
        Expectation(kind: "checkin", machineAuthored: true, suppressed: true),
        Expectation(kind: "revive", machineAuthored: true, suppressed: true),
        Expectation(kind: "run_recovery", machineAuthored: true, suppressed: true),
        Expectation(kind: "structured_answer", machineAuthored: false, suppressed: false),
        Expectation(kind: "system_steer", machineAuthored: true, suppressed: true),
        Expectation(kind: "steer", machineAuthored: false, suppressed: false),
        Expectation(kind: "plan_retained", machineAuthored: false, suppressed: false),
    ]

    func testEveryEnumeratedKindMatchesTheDesktopVerdict() {
        for e in expectations {
            XCTAssertEqual(
                InjectionPolicy.suppresses(machineAuthored: e.machineAuthored, injectionKind: e.kind),
                e.suppressed,
                "kind=\(e.kind.isEmpty ? "(empty)" : e.kind) machineAuthored=\(e.machineAuthored)"
            )
        }
    }

    func testEngineFlagIsTrustedForAnUnknownKind() {
        // The property that ends the recurrence: a kind added to the engine is
        // suppressed correctly with no change to this client.
        XCTAssertTrue(
            InjectionPolicy.suppresses(machineAuthored: true, injectionKind: "some_future_kind"),
            "the engine flag is authoritative for kinds this client has never seen"
        )
    }

    func testUnknownKindWithNoFlagRenders() {
        // Hiding content on an unrecognized string would be strictly worse than
        // showing a turn the user did not expect.
        XCTAssertFalse(
            InjectionPolicy.suppresses(machineAuthored: nil, injectionKind: "some_future_kind"),
            "an unknown kind with no flag must render rather than silently vanish"
        )
    }

    func testLegacyRowsWithoutTheFlagAreStillClassified() {
        // Conversation files already on disk carry the kind and no flag.
        for kind in ["agent_completion", "background_task_completion", "slash_command"] {
            XCTAssertTrue(
                InjectionPolicy.suppresses(machineAuthored: nil, injectionKind: kind),
                "legacy \(kind) row must stay suppressed via the kind fallback"
            )
        }
    }

    func testOrdinaryTurnWithNeitherFieldRenders() {
        XCTAssertFalse(InjectionPolicy.suppresses(machineAuthored: nil, injectionKind: nil))
    }

    func testMessageOverloadReadsBothFields() {
        var machine = Message(id: "m1", role: .user, content: "child result", timestamp: 1.0)
        machine.injectionKind = "agent_completion"
        machine.machineAuthored = true
        XCTAssertTrue(InjectionPolicy.suppresses(machine))

        var human = Message(id: "m2", role: .user, content: "what does this do?", timestamp: 2.0)
        human.injectionKind = nil
        human.machineAuthored = nil
        XCTAssertFalse(InjectionPolicy.suppresses(human))
    }

    /// A Guided Questions submission RENDERS. It is real operator input: they
    /// read the questions, chose the options, typed the text and attached the
    /// images. Hiding it dropped work they actually did; the transcript shows
    /// it with a "Questions answered" label instead.
    func testStructuredAnswerRenders() {
        XCTAssertFalse(
            InjectionPolicy.suppresses(machineAuthored: nil, injectionKind: "structured_answer"),
            "a submitted answer set is the operator's own input and must stay visible"
        )
        XCTAssertFalse(
            InjectionPolicy.suppresses(machineAuthored: false, injectionKind: "structured_answer"),
            "the engine classifies structured_answer as user-authored"
        )
    }

    /// A `/clear --keep-plan` retained plan RENDERS. The engine, not the
    /// operator, produced this exact turn, but its content is the operator's
    /// own plan and `--keep-plan` was the operator's explicit choice. Hiding
    /// it would contradict the divider ("plan kept: <slug>") the same action
    /// produces; the transcript shows it with a "Plan retained" label instead.
    func testPlanRetainedRenders() {
        XCTAssertFalse(
            InjectionPolicy.suppresses(machineAuthored: false, injectionKind: "plan_retained"),
            "a retained plan is the operator's own content and must stay visible"
        )
    }

    /// The outbound set is empty by construction: nothing a client authors is
    /// currently hidden. A kind may only be added here when the engine also
    /// classifies it machine-authored.
    func testOutboundSetStaysNarrow() {
        XCTAssertTrue(
            InjectionPolicy.outboundMachineKinds.isEmpty,
            "only kinds a client authors AND the engine hides belong here"
        )
    }

    /// The legacy fallback list is a migration shim, not a second policy.
    /// Pinning its contents keeps a new kind from being appended here instead
    /// of being classified in the engine, which would recreate the
    /// hand-maintained list the shared policy exists to remove.
    func testLegacyFallbackListStaysClosed() {
        XCTAssertEqual(
            InjectionPolicy.legacyMachineKinds,
            ["agent_completion", "slash_command", "background_task_completion"],
            "do not extend the legacy list — classify new kinds in the engine so machineAuthored carries them"
        )
    }
}
