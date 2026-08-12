import SwiftUI

// MARK: - IonRadius
//
// Three corner radii, named by what they enclose.
//
// This deliberately collapses the shipped four-step scale. `IonTheme.Radius`
// declares 8/12/16/20; this declares 8/12/20 and drops 16pt. Four steps was one
// more than the design distinguishes, and the extra step did what extra steps
// do: it gave call sites a choice with no rule behind it, so `medium` and
// `large` got picked interchangeably for the same kind of surface. Three roles
// tied to three kinds of enclosure leave nothing to guess.
//
// The dropped 16pt is not homeless. Its main occupant was the user bubble in
// the conversation, which the style guide reassigns to `container` at 12pt.
//
// `IonTheme.Radius.small`/`medium`/`large`/`card` are superseded by this file.
// They remain declared because live call sites still reference them and
// removing them mid-rebuild would break the build; they are not to be used in
// new code. Surface conversion retires them.

enum IonRadius {

    /// 8pt. Compact button, chip, code table.
    static let control: CGFloat = 8

    /// 12pt. Row, permission card, user bubble, inline tool well.
    static let container: CGFloat = 12

    /// 20pt. Sheet and composer pill.
    static let sheet: CGFloat = 20
}
