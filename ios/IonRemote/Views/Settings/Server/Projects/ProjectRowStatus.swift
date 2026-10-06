import Foundation

/// The one status a Projects list row carries: its dot, and the short text
/// beside the branch.
struct ProjectRowStatus: Equatable, Sendable {
    enum Tone: Equatable, Sendable {
        case ok, warn, error, muted
    }

    /// Short status text, or nil when the row needs none.
    let text: String?
    let tone: Tone
    let dot: Tone
    /// What the dot means, for VoiceOver.
    let dotLabel: String

    static func of(_ project: EnvironmentProject, job: EnvironmentJob?) -> ProjectRowStatus {
        let setupRunning = project.setup?.state == .running
        let setupFailed = project.setup?.state == .failed
        let untrusted = !project.isTrusted
        let dot: Tone = !project.exists ? .error : (untrusted || job != nil || setupRunning || setupFailed) ? .warn : .ok
        let dotLabel = !project.exists ? "Missing on disk"
            : untrusted ? "Not trusted"
            : (job != nil || setupRunning) ? "Working"
            : setupFailed ? "Setup failed" : "Ready"
        func status(_ text: String?, _ tone: Tone) -> ProjectRowStatus {
            ProjectRowStatus(text: text, tone: tone, dot: dot, dotLabel: dotLabel)
        }
        if !project.exists { return status("Missing", .error) }
        if untrusted { return status("Not trusted", .warn) }
        if let job { return status(progressLabel(job), .warn) }
        if setupRunning { return status("Setting up", .warn) }
        if setupFailed { return status("Setup failed", .error) }
        if !project.isGitRepo { return status("Not git", .muted) }
        if project.clonedByIon { return status("Cloned by Ion", .muted) }
        return status(nil, .muted)
    }

    static func of(_ job: EnvironmentJob) -> ProjectRowStatus {
        if job.phase == .failed {
            let text = job.kind == .create ? "Create failed" : "Clone failed"
            return ProjectRowStatus(text: text, tone: .error, dot: .error, dotLabel: job.error.map { "\(text): \($0)" } ?? text)
        }
        return ProjectRowStatus(text: progressLabel(job), tone: .warn, dot: .warn, dotLabel: "Working")
    }

    /// `Cloning 45%`, `Setting up`, `Creating 45%`.
    static func progressLabel(_ job: EnvironmentJob) -> String {
        let verb = job.kind.title
        guard let percent = job.percent else { return verb }
        return "\(verb) \(Int(percent))%"
    }
}
