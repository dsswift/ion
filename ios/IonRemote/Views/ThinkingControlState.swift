import Foundation

/// Resolves how the per-conversation thinking control renders for a given
/// model. Pure — no SwiftUI, no view model — so the rendering rules are
/// testable without building a view hierarchy.
///
/// The `thinkingEffort` wire values are unchanged. Their neutral value is
/// model-dependent: "adaptive" for adaptive models, "off" otherwise. What
/// that resolves to is a property of the model, which is why it needs resolving:
///
///  - `thinkingMode == "adaptive"`: the model always thinks, at its own default
///    budget, and cannot be turned off. The neutral row therefore reads
///    "Adaptive" — it is what the model does with no override, not an absence
///    of thinking. Advertised override levels are layered on top of that floor.
///    "Adaptive" REPLACES "Off" for these models; it is not an extra menu row.
///  - any other mode that declares effort levels: the neutral row reads "Off".
///  - a model that declares no effort levels (or is absent from
///    `availableModels` entirely): the control renders DISABLED. Never hidden —
///    a control that vanishes teaches the user nothing about why the option is
///    unavailable, and it makes the status bar reflow between models.
///
/// The desktop counterpart is
/// `desktop/src/renderer/components/thinking-control-state.ts` and carries the
/// same three outputs. Changes here belong there too.
struct ThinkingControlState: Equatable {
    /// One selectable row: the wire value plus its display label.
    struct Level: Equatable {
        let value: String
        let label: String
    }

    /// Label for the neutral row and for an unselectable stored effort.
    /// "Adaptive" when the model thinks by default, "Off" otherwise.
    let offLabel: String

    /// Rows to offer in display order. Begins with model's neutral row,
    /// followed by only declared overrides.
    let levels: [Level]

    /// False when the model declares no effort levels, i.e. there is nothing to
    /// choose. The control still renders; it renders disabled.
    let enabled: Bool

    /// Canonical display label map shared by resolver rows and the public
    /// status-bar parity seam. `xhigh` cannot use generic capitalization.
    static func label(for effort: String) -> String {
        switch effort {
        case "adaptive": return "Adaptive"
        case "low": return "Low"
        case "medium": return "Medium"
        case "high": return "High"
        case "xhigh": return "Extra High"
        case "max": return "Max"
        default: return "Off"
        }
    }

    /// Resolve the control's rendering state from the model's declared
    /// reasoning shape. Both arguments are optional because the active model
    /// may be absent from `availableModels` entirely (unknown id, models not
    /// yet projected) — that resolves to a disabled control rather than a
    /// hidden one.
    static func resolve(thinkingMode: String?, thinkingEfforts: [String]?) -> ThinkingControlState {
        let declared = thinkingEfforts ?? []
        let overrides = ["low", "medium", "high", "xhigh", "max"]
            .filter { declared.contains($0) }
            .map { Level(value: $0, label: label(for: $0)) }
        let neutral = thinkingMode == "adaptive"
            ? Level(value: "adaptive", label: label(for: "adaptive"))
            : Level(value: "off", label: label(for: "off"))
        return ThinkingControlState(
            offLabel: neutral.label,
            levels: [neutral] + overrides,
            enabled: !declared.isEmpty
        )
    }

    /// Label for the trigger given the currently-selected effort. Falls back to
    /// the "off" row rather than rendering an empty label when the stored effort
    /// is not one this model declares.
    func triggerLabel(for effort: String) -> String {
        levels.first(where: { $0.value == effort })?.label ?? offLabel
    }
}
