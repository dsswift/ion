import SwiftUI

// MARK: - IonSpace
//
// Spacing named by intent, not by size.
//
// `IonTheme` has shipped a 4/8/12/16/24/32 spacing scale since early on
// (`IonTheme.xs` through `IonTheme.xxl`), and views ignore it at the large
// majority of padding call sites. The scale is not the problem — these are the
// same six values. The names are. `IonTheme.lg` tells a call site how big the
// gap is, which it already knew; it never asks what the gap is *for*. A name
// that answers a question nobody has to ask gets skipped in favour of the
// literal, and the result is hundreds of independent spacing decisions instead
// of one shared rhythm.
//
// So each role below is named for the job it does. `IonSpace.rowInset` is a
// decision a call site has to make correctly; `IonTheme.lg` was not. When two
// roles carry the same number, that is deliberate: they are separate decisions
// that currently agree, and either can move without dragging the other with it.
//
// Base unit 4pt. The scale is an ordered ladder, not a strict 4pt-multiple
// grid: 4/6/8/12/16/24/32. The 6pt `compactInset` is a deliberate half-step
// between 4 and 8. The physical values stay native to iOS.
//
// `IonTheme.xs`/`sm`/`md`/`lg`/`xl`/`xxl` are superseded by this file. They
// remain declared because live call sites still reference them and removing
// them mid-rebuild would break the build; they are not to be used in new code.
// Surface conversion retires them.

enum IonSpace {

    /// 4pt. Icon to compact label, internal micro-gap.
    static let hairlineGap: CGFloat = 4

    /// 6pt. Chip and compact-control interior inset. The deliberate half-step
    /// between `hairlineGap` and `compactGap`: a value already in wide use for
    /// compact vertical and chip interior padding, promoted to a role because it
    /// is the single largest recurring cluster and forcing it to hatch described
    /// the codebase inaccurately.
    static let compactInset: CGFloat = 6

    /// 8pt. Between adjacent compact controls.
    static let compactGap: CGFloat = 8

    /// 12pt. Standard component gap, and the trailing row gutter.
    static let contentGap: CGFloat = 12

    /// 16pt. Primary leading gutter, and the assistant document gutter.
    static let rowInset: CGFloat = 16

    /// 24pt. Major group separation.
    static let sectionGap: CGFloat = 24

    /// 32pt. Sheet and large-document inset.
    static let screenInset: CGFloat = 32

    // MARK: - Metrics
    //
    // Fixed geometry the design specifies, as distinct from the rhythm roles
    // above. These are named here rather than left as literals at their call
    // sites because each one is a design decision that must hold across every
    // surface that draws the thing: a tab row is 60pt everywhere or the list
    // stops scanning as a list.
    //
    // What does NOT belong here is one-off geometry — a nudge that exists to
    // make one specific layout sit right. Those stay literal at the call site
    // with a `// design-geometry:` note explaining the reason, which is the
    // form the eventual source gate will accept. The test is whether a second
    // surface would ever need the same number for the same reason.

    enum Metric {

        /// Minimum height of a tab row. The information row: taller than the
        /// 44pt touch minimum because it carries a title and a meaning line.
        static let tabRowHeight: CGFloat = 60

        /// Vertical interior padding inside a tab row.
        static let tabRowVerticalPadding: CGFloat = 10

        /// Minimum height of a settings or worktree row. The touch minimum.
        static let standardRowHeight: CGFloat = 44

        /// Total height of a section header strip, inclusive of its top padding.
        static let sectionHeaderHeight: CGFloat = 28

        /// Top padding within the section header strip.
        static let sectionHeaderTopPadding: CGFloat = 8

        /// Leading gutter of a tab row. Same value as `rowInset`, kept separate
        /// because the tab row's gutter is measured from the reserved status
        /// column and can move independently of the general row inset.
        static let tabRowLeadingGutter: CGFloat = 16

        /// Trailing gutter of a tab row, where the condition rail sits.
        static let tabRowTrailingGutter: CGFloat = 12

        /// Vertical gap between consecutive assistant turns.
        static let assistantTurnGap: CGFloat = 12

        /// Horizontal gutter of the assistant document.
        static let assistantDocumentGutter: CGFloat = 16

        /// Left inset of a tool-call line. Deeper than the document gutter so
        /// tool lines read as subordinate to the turn that produced them.
        static let toolLineInset: CGFloat = 32

        /// Composer offset from the bottom safe area.
        static let composerBottomOffset: CGFloat = 12

        /// Width of the reserved status column in a tab row, and the diameter
        /// of the status shape that occupies it. Reserved whether or not a
        /// shape is drawn, so idle rows stay aligned with active ones.
        static let statusColumnWidth: CGFloat = 8

        /// Diameter of the compact status shape used in the instance bar,
        /// worktree rows, and the agent-bar run-state dot.
        static let compactStatusDiameter: CGFloat = 6
    }
}
