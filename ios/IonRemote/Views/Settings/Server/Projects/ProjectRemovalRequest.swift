import Foundation

/// A Remove the person asked for, with what the server said removing would
/// touch. Its choices come from the appraisal.
struct ProjectRemovalRequest: Identifiable, Equatable {
    let project: EnvironmentProject
    let appraisal: ProjectRemovalAppraisal

    var id: String { project.dir }

    var message: String {
        var lines = [appraisal.clonedByIon
            ? "Ion cloned this checkout, so you can also delete its files."
            : "The folder stays where it is. Ion only forgets it."]
        if appraisal.dirty { lines.append("It has uncommitted changes.") }
        if appraisal.worktrees > 0 {
            lines.append(appraisal.worktrees == 1 ? "1 worktree was cut from it." : "\(appraisal.worktrees) worktrees were cut from it.")
        }
        return lines.joined(separator: " ")
    }

    var deleteLabel: String { appraisal.isRisky ? "Delete Files Anyway" : "Remove and Delete Files" }
}
