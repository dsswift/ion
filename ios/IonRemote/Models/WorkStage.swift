import SwiftUI

// MARK: - Work stage
//
// Mirrors `WorkStage` in desktop/src/shared/types-git.ts. A curated, fixed
// vocabulary for the operator's own workflow marker on a worktree — one
// optional stage per worktree, any subset is a complete workflow, and no verb
// is gated on it. The desktop owns the single automatic transition (`bug`
// moves to `test` when the worktree's bench pin advances); this app renders
// and sets, never derives.

enum WorkStage: String, Codable, CaseIterable, Hashable {
    case plan, build, test, bug, verified, merge, ready

    /// Menu / accessibility label, matching the desktop's `WORK_STAGES` table.
    var label: String {
        switch self {
        case .plan: return "Planning"
        case .build: return "Building"
        case .test: return "Needs testing"
        case .bug: return "Issue found"
        case .verified: return "Verified"
        case .merge: return "Merge checks"
        case .ready: return "Ready to land"
        }
    }

    /// SF Symbol counterpart of the desktop's Phosphor glyph.
    var systemImage: String {
        switch self {
        case .plan: return "safari"
        case .build: return "hammer.fill"
        case .test: return "testtube.2"
        case .bug: return "ant.fill"
        case .verified: return "checkmark.circle.fill"
        case .merge: return "arrow.triangle.merge"
        // SF Symbols has no rocket; the paper plane carries the same
        // "ready to send" reading.
        case .ready: return "paperplane.fill"
        }
    }

    /// Stage colour, matching the desktop's hue assignments (infoFg, warning,
    /// question-purple, danger, worktreeGreen, accent, success). `merge` takes
    /// indigo rather than a second blue so it stays separable from `plan` at
    /// badge size — the desktop's accent blue and info blue differ the same way.
    var color: Color {
        switch self {
        case .plan: return .blue
        case .build: return .orange
        case .test: return .purple
        case .bug: return .red
        case .verified: return .green
        case .merge: return .indigo
        case .ready: return .green
        }
    }
}
