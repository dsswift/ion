import XCTest
@testable import IonRemote

/// Pins the bench verification wording. The bench row and the worktree menu
/// render these sentences in place of the raw verify output, so the output
/// itself must never appear in them.
final class BenchVerificationCopyTests: XCTestCase {
    func testMemberNameDropsTheBranchPrefix() {
        XCTAssertEqual(BenchVerificationCopy.memberName("wt/ion-90fe0902"), "ion-90fe0902")
        XCTAssertEqual(BenchVerificationCopy.memberName("feature"), "feature")
    }

    func testHeadlineNamesTheSuspectWorktrees() {
        XCTAssertEqual(
            BenchVerificationCopy.headline(replayedBranches: ["wt/ion-90fe0902"]),
            "A saved conflict fix for ion-90fe0902 was reused, and your verify command failed on the result."
        )
        XCTAssertEqual(
            BenchVerificationCopy.headline(replayedBranches: ["wt/a", "wt/b"]),
            "Saved conflict fixes for a, b were reused, and your verify command failed on the result."
        )
        XCTAssertEqual(
            BenchVerificationCopy.headline(replayedBranches: []),
            "Every worktree merged, but your verify command failed on the combined code."
        )
    }

    func testNextStepOffersDiscardOnlyWhenThereIsASavedFix() {
        XCTAssertTrue(BenchVerificationCopy.nextStep(replayedBranches: ["wt/a"]).contains("Discard"))
        XCTAssertFalse(BenchVerificationCopy.nextStep(replayedBranches: []).contains("Discard"))
    }

    func testDiscardPromptNamesEachSuspect() {
        XCTAssertEqual(
            BenchVerificationCopy.discardPrompt(replayedBranches: ["wt/a"]),
            "Discard the saved conflict fix for a? The bench reassembles. If the conflict is real, you resolve it again."
        )
        XCTAssertTrue(BenchVerificationCopy.discardPrompt(replayedBranches: ["wt/a", "wt/b"]).contains("fixes for a, b"))
    }
}
