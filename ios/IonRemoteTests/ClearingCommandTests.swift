import XCTest
@testable import IonRemote

/// Pins the clear-confirmation decision against the desktop's
/// `InputBarClearingCommand.test.ts`. Both clients must decide identically for
/// identical input, or the same command warns on one device and silently wipes
/// the conversation on the other.
final class ClearingCommandTests: XCTestCase {

    private func cmd(_ name: String, clears: Bool? = nil) -> DiscoveredSlashCommand {
        DiscoveredSlashCommand(
            name: name,
            description: name,
            scope: "user",
            source: "command",
            origin: "ion",
            clearsConversation: clears
        )
    }

    private var commands: [DiscoveredSlashCommand] {
        [cmd("squash", clears: true), cmd("review", clears: true), cmd("recap", clears: false), cmd("spec")]
    }

    // MARK: - Invocation parsing

    func test_readsLoneInvocationAndArguments() {
        XCTAssertEqual(ClearingCommand.parseCommandName("/squash"), "squash")
        XCTAssertEqual(ClearingCommand.parseCommandName("/implement my-spec.md"), "implement")
        XCTAssertEqual(ClearingCommand.parseCommandName("  /review  "), "review")
    }

    func test_ignoresSlashThatIsNotALeadingInvocation() {
        // A destructive dialog must never fire on ordinary prose or a path.
        XCTAssertNil(ClearingCommand.parseCommandName("look at src/main/index.ts"))
        XCTAssertNil(ClearingCommand.parseCommandName("what does /squash do?"))
        XCTAssertNil(ClearingCommand.parseCommandName("/"))
        XCTAssertNil(ClearingCommand.parseCommandName("/123bad"))
        XCTAssertNil(ClearingCommand.parseCommandName(""))
    }

    // MARK: - Decision

    func test_promptsForClearingCommandWhenHistoryExists() {
        let got = ClearingCommand.resolve(input: "/squash", hasHistory: true, commands: commands)
        XCTAssertEqual(got, ClearingCommand.Pending(command: "squash", pendingInput: "/squash"))
    }

    func test_preservesArgumentsSoConfirmedSendIsIdentical() {
        let got = ClearingCommand.resolve(
            input: "/review spec.md --deep",
            hasHistory: true,
            commands: commands
        )
        XCTAssertEqual(got?.pendingInput, "/review spec.md --deep")
    }

    // The suppression rule. A fresh or just-cleared conversation has nothing to
    // lose, so interrupting the operator would be pure noise.
    func test_staysSilentOnConversationWithNoHistory() {
        XCTAssertNil(ClearingCommand.resolve(input: "/squash", hasHistory: false, commands: commands))
    }

    func test_staysSilentForCommandThatDoesNotClear() {
        XCTAssertNil(ClearingCommand.resolve(input: "/recap", hasHistory: true, commands: commands))
        XCTAssertNil(ClearingCommand.resolve(input: "/spec", hasHistory: true, commands: commands))
    }

    func test_failsOpenForUnknownCommand() {
        // An extension command, or a discovery feed that has not loaded.
        // Blocking the send would be worse than missing a warning.
        XCTAssertNil(ClearingCommand.resolve(input: "/some-extension-cmd", hasHistory: true, commands: commands))
        XCTAssertNil(ClearingCommand.resolve(input: "/squash", hasHistory: true, commands: []))
    }

    func test_staysSilentForOrdinaryText() {
        XCTAssertNil(ClearingCommand.resolve(
            input: "please squash the branch",
            hasHistory: true,
            commands: commands
        ))
    }

    func test_messageNamesCommandAndSaysTranscriptSurvives() {
        let msg = ClearingCommand.message(for: "squash")
        XCTAssertTrue(msg.contains("/squash"))
        XCTAssertTrue(msg.contains("transcript stays readable"))
    }
}
