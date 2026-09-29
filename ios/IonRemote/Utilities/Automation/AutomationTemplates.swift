import Foundation

/// The ready-made automations "New from template" offers. A copy of
/// `AUTOMATION_TEMPLATES` in
/// `desktop/src/renderer/components/settings/automation-editor-helpers.ts`.
enum AutomationTemplates {

    struct Template: Identifiable {
        let id: String
        let label: String
        private let make: (Date, () -> String) -> AutomationDefinition

        init(id: String, label: String, make: @escaping (Date, () -> String) -> AutomationDefinition) {
            self.id = id
            self.label = label
            self.make = make
        }

        /// A new, unsaved definition filled in from the template.
        func definition(now: Date = Date(), newId: () -> String = AutomationDraft.newId) -> AutomationDefinition {
            make(now, newId)
        }
    }

    private static func setStage(_ stage: String, onlyIf: String? = nil) -> AutomationStep {
        var payload: [String: JSONValue] = ["stage": .string(stage)]
        if let onlyIf { payload["onlyIfStage"] = .string(onlyIf) }
        return .action(AutomationAction(kind: "worktree:set-stage", payload: payload))
    }

    private static func equals(_ path: String, _ value: JSONValue) -> AutomationCondition {
        AutomationCondition(path: path, operator: .equals, value: value)
    }

    private static func notEquals(_ path: String, _ value: JSONValue) -> AutomationCondition {
        AutomationCondition(path: path, operator: .notEquals, value: value)
    }

    private static let hasWorktree = AutomationCondition(path: "payload.worktreePath", operator: .exists)

    static let all: [Template] = [
        template("issue-found-refinement", label: "Normal message on a tested worktree marks Issue found",
                 name: "Normal refinement marks worktree as Issue found", event: "conversation:message-submitted",
                 steps: [setStage("bug", onlyIf: "test")],
                 all: [hasWorktree, equals("payload.stage", .string("test")), equals("payload.messageKind", .string("prompt")), equals("payload.permissionMode", .string("auto"))]),
        template("verified-align", label: "Verified runs alignment",
                 name: "Verified runs alignment", event: "worktree:stage-changed",
                 steps: [.action(AutomationAction(kind: "conversation:slash", payload: ["command": .string("align")]))],
                 all: [equals("payload.stage", .string("verified")), equals("payload.source", .string("operator"))]),
        template("align-merge", label: "Align enters merge checks",
                 name: "Align enters merge checks", event: "conversation:slash-resolved",
                 steps: [setStage("merge")],
                 // Requires a stage and never moves a ready worktree back to merge.
                 all: [equals("payload.slashCommand", .string("align")), hasWorktree, notEquals("payload.stage", .string("ready"))]),
        template("squash-merge", label: "Squash enters merge checks",
                 name: "Squash enters merge checks", event: "conversation:slash-resolved",
                 steps: [setStage("merge")],
                 all: [equals("payload.slashCommand", .string("squash")), hasWorktree, notEquals("payload.stage", .string("ready"))]),
        template("squash-ready", label: "Completed squash is ready to land",
                 name: "Completed squash is ready to land", event: "conversation:completed",
                 steps: [setStage("ready")],
                 all: [equals("payload.lastSlashCommand", .string("squash")), equals("payload.endedWithQuestion", .bool(false)), hasWorktree]),
        template("bug-migration", label: "When an issue fix reaches the bench, move it to Needs testing",
                 name: "When an issue fix reaches the bench, move it to Needs testing", event: "worktree:pin-advanced",
                 steps: [setStage("test", onlyIf: "bug")], all: []),
        template("plan-message", label: "Plan message returns worktree to planning",
                 name: "Plan message returns worktree to planning", event: "prompt:submitted",
                 steps: [setStage("plan")],
                 all: [equals("payload.permissionMode", .string("plan")), hasWorktree]),
    ]

    private static func template(_ id: String, label: String, name: String, event: String, steps: [AutomationStep], all: [AutomationCondition]) -> Template {
        Template(id: id, label: label) { now, newId in
            let stamp = AutomationDraft.timestamp(now)
            return AutomationDefinition(
                id: "user.\(slug(name)).\(newId())", name: name, enabled: true,
                trigger: AutomationTrigger(event: event),
                condition: all.isEmpty ? nil : AutomationConditionGroup(all: all.map(AutomationConditionExpression.condition)),
                steps: steps, actions: nil, createdAt: stamp, updatedAt: stamp
            )
        }
    }

    /// Lowercase words joined by dashes: `Align enters merge checks` → `align-enters-merge-checks`.
    static func slug(_ value: String) -> String {
        var slug = ""
        var pendingDash = false
        for scalar in value.lowercased().unicodeScalars {
            if ("a"..."z").contains(scalar) || ("0"..."9").contains(scalar) {
                if pendingDash && !slug.isEmpty { slug.append("-") }
                pendingDash = false
                slug.unicodeScalars.append(scalar)
            } else {
                pendingDash = true
            }
        }
        return slug
    }
}
