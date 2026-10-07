import Foundation

/// The plain-language wording for a bench verification failure, shared by the
/// bench row, the worktree menu, and the sheet. Pure so the sentences are
/// pinned by tests rather than through a rendered view.
///
/// The raw verify output is deliberately not part of any summary: it is a log,
/// its first lines are tool noise (npm config warnings, script banners), and
/// the real error sits at the end. The sheet offers it on demand instead.
enum BenchVerificationCopy {
    /// A worktree's short name from its branch (`wt/ion-90fe0902` → `ion-90fe0902`),
    /// the same name the inbox shows on the worktree row.
    static func memberName(_ branch: String) -> String {
        branch.split(separator: "/").last.map(String.init) ?? branch
    }

    /// What happened, in one sentence.
    static func headline(replayedBranches: [String]) -> String {
        let names = replayedBranches.map(memberName)
        switch names.count {
        case 0:
            return "Every worktree merged, but your verify command failed on the combined code."
        case 1:
            return "A saved conflict fix for \(names[0]) was reused, and your verify command failed on the result."
        default:
            return "Saved conflict fixes for \(names.joined(separator: ", ")) were reused, and your verify command failed on the result."
        }
    }

    /// What the operator can do about it, in one sentence.
    static func nextStep(replayedBranches: [String]) -> String {
        replayedBranches.isEmpty
            ? "Ask AI to find out why. Fix it in the worktree that owns the code."
            : "Discard the saved fix to merge it fresh, or ask AI to find out why."
    }

    /// The confirm prompt before discarding the suspects' saved fixes.
    static func discardPrompt(replayedBranches: [String]) -> String {
        let names = replayedBranches.map(memberName).joined(separator: ", ")
        let noun = replayedBranches.count == 1 ? "fix" : "fixes"
        return "Discard the saved conflict \(noun) for \(names)? The bench reassembles. If the conflict is real, you resolve it again."
    }
}
