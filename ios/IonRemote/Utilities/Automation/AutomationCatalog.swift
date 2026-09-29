import Foundation

/// The automation catalog: every event an automation may start on and every
/// action it may run. A copy of `packages/shared/src/automation-catalog.ts`;
/// `AutomationCatalogTests` holds it to the shared snapshot
/// (`packages/shared/src/__tests__/fixtures/automation-catalog.json`).
enum AutomationCatalog {

    // MARK: Operator groups by field type

    private static let presenceOps: [AutomationConditionOperator] = [.exists, .notExists]
    private static let equalityOps: [AutomationConditionOperator] = [.equals, .notEquals] + presenceOps
    private static let stringOps: [AutomationConditionOperator] = [.equals, .notEquals, .contains, .notContains, .matches] + presenceOps

    // MARK: Finite value sets

    private static let stageChoices = WorkStage.allCases.map { AutomationFieldChoice(value: $0.rawValue, label: $0.label) }
    private static let messageKindChoices = [
        AutomationFieldChoice(value: "prompt", label: "Operator prompt"),
        AutomationFieldChoice(value: "slash", label: "Slash command"),
        AutomationFieldChoice(value: "structured", label: "Guided Questions answer"),
        AutomationFieldChoice(value: "machine", label: "Machine-authored"),
    ]
    private static let permissionModeChoices = [
        AutomationFieldChoice(value: "plan", label: "Plan mode"),
        AutomationFieldChoice(value: "auto", label: "Auto mode"),
    ]
    private static let sourceChoices = [
        AutomationFieldChoice(value: "desktop", label: "Desktop"),
        AutomationFieldChoice(value: "remote", label: "iOS / remote"),
        AutomationFieldChoice(value: "machine", label: "Machine"),
    ]

    // MARK: Reusable fields

    private static let worktreePath = AutomationFieldSpec(path: "payload.worktreePath", label: "Worktree", type: .path, operators: presenceOps)
    private static let stage = AutomationFieldSpec(path: "payload.stage", label: "Current worktree stage", type: .enumType, operators: equalityOps, values: stageChoices)
    private static let previousStage = AutomationFieldSpec(path: "payload.previousStage", label: "Previous worktree stage", type: .enumType, operators: equalityOps, values: stageChoices)
    private static let permissionMode = AutomationFieldSpec(path: "payload.permissionMode", label: "Permission mode", type: .enumType, operators: equalityOps, values: permissionModeChoices)
    private static let source = AutomationFieldSpec(path: "payload.source", label: "Change source", type: .string, operators: equalityOps)
    private static let messageKind = AutomationFieldSpec(path: "payload.messageKind", label: "Message kind", type: .enumType, operators: equalityOps, values: messageKindChoices)
    private static let isSteer = AutomationFieldSpec(path: "payload.isSteer", label: "Sent during an active run (steer)", type: .boolean, operators: equalityOps)
    private static let slashCommand = AutomationFieldSpec(path: "payload.slashCommand", label: "Slash command name", type: .string, operators: stringOps)

    private static func text(_ path: String, _ label: String, _ operators: [AutomationConditionOperator]) -> AutomationFieldSpec {
        AutomationFieldSpec(path: path, label: label, type: .string, operators: operators)
    }

    private static func trigger(_ event: String, _ label: String, worktree: Bool, conversation: Bool, _ fields: [AutomationFieldSpec]) -> AutomationTriggerSpec {
        AutomationTriggerSpec(event: event, label: label, provides: .init(worktree: worktree, conversation: conversation), fields: fields)
    }

    // MARK: Triggers

    static let triggers: [AutomationTriggerSpec] = [
        trigger("conversation:message-submitted", "A message is submitted", worktree: true, conversation: true, [
            messageKind, permissionMode, isSteer,
            AutomationFieldSpec(path: source.path, label: source.label, type: .enumType, operators: source.operators, values: sourceChoices),
            worktreePath, stage,
        ]),
        trigger("prompt:submitted", "A prompt is submitted (legacy)", worktree: true, conversation: true, [permissionMode, slashCommand, source, worktreePath, stage]),
        trigger("conversation:slash", "A slash command is submitted (legacy)", worktree: true, conversation: true, [slashCommand, source, worktreePath, stage]),
        trigger("conversation:slash-resolved", "A slash command resolves", worktree: true, conversation: true, [slashCommand, worktreePath, stage]),
        trigger("conversation:completed", "A conversation completes", worktree: true, conversation: true, [
            text("payload.completionReason", "Completion reason", stringOps),
            text("payload.lastSlashCommand", "Last slash command", stringOps),
            AutomationFieldSpec(path: "payload.endedWithQuestion", label: "Ended with a question", type: .boolean, operators: equalityOps),
            worktreePath, stage,
        ]),
        trigger("plan:implemented", "A plan is implemented", worktree: true, conversation: true, [
            text("payload.planFilePath", "Plan file path", stringOps), worktreePath, stage,
        ]),
        trigger("engine:status", "Engine status changes", worktree: false, conversation: true, [
            text("payload.state", "Engine state", equalityOps),
            text("payload.completionReason", "Completion reason", stringOps),
        ]),
        trigger("worktree:pin-advanced", "A worktree update reaches the bench", worktree: true, conversation: false, [
            worktreePath, stage,
            text("payload.branchName", "Branch name", stringOps),
            text("payload.sourceBranch", "Source branch", stringOps),
        ]),
        trigger("worktree:stage-changed", "A worktree stage changes", worktree: true, conversation: false, [worktreePath, stage, previousStage, source]),
        trigger("worktree:created", "A worktree is created", worktree: true, conversation: false, [
            worktreePath,
            text("payload.branchName", "Branch name", stringOps),
            text("payload.sourceBranch", "Source branch", stringOps),
            source,
        ]),
        trigger("worktree:landed", "A worktree lands", worktree: true, conversation: false, [
            worktreePath,
            text("payload.branchName", "Branch name", stringOps),
            text("payload.sourceBranch", "Source branch", stringOps),
            text("payload.landMode", "Land mode", equalityOps),
        ]),
        trigger("worktree:retired", "A worktree is retired", worktree: true, conversation: false, [
            worktreePath, text("payload.branchName", "Branch name", stringOps),
        ]),
        trigger("bench:member-added", "A worktree joins an integration bench", worktree: true, conversation: false, [
            worktreePath,
            text("payload.sourceBranch", "Source branch", stringOps),
            text("payload.branchName", "Branch name", stringOps),
        ]),
        trigger("bench:member-removed", "A worktree leaves an integration bench", worktree: true, conversation: false, [
            worktreePath, text("payload.sourceBranch", "Source branch", stringOps),
        ]),
    ]

    // MARK: Actions

    static let actions: [AutomationActionSpec] = [
        AutomationActionSpec(kind: "record", label: "Record this run only", target: .none, config: []),
        AutomationActionSpec(kind: "worktree:set-stage", label: "Set the worktree stage", target: .worktree, config: [
            AutomationActionConfigField(key: "stage", label: "New stage", type: .enumType, required: true, values: stageChoices),
            AutomationActionConfigField(key: "onlyIfStage", label: "Only if current stage is", type: .enumType, required: false, values: stageChoices),
        ]),
        AutomationActionSpec(kind: "desktop:notification", label: "Show a desktop notification", target: .none, config: [
            AutomationActionConfigField(key: "title", label: "Title", type: .string, required: true),
            AutomationActionConfigField(key: "body", label: "Body", type: .string, required: false),
        ]),
        AutomationActionSpec(kind: "conversation:run", label: "Start an AI conversation", target: .directory, config: [
            AutomationActionConfigField(key: "prompt", label: "Prompt", type: .string, required: true),
        ]),
        AutomationActionSpec(kind: "conversation:slash", label: "Run a slash command", target: .directory, config: [
            AutomationActionConfigField(key: "command", label: "Command", type: .string, required: true),
            AutomationActionConfigField(key: "args", label: "Arguments", type: .string, required: false),
        ]),
        AutomationActionSpec(kind: "tab:set-color", label: "Set the tab color", target: .conversation, config: [
            AutomationActionConfigField(key: "color", label: "Color", type: .string, required: false),
        ]),
    ]

    /// The tab colors the tab-color action offers, as the server's clients
    /// store them. `nil` is the default color.
    static let tabColorPresets: [(color: String?, label: String)] = [
        (nil, "Default"), ("#f08c4a", "Orange"), ("#4ece78", "Green"), ("#ef5350", "Red"),
        ("#42a5f5", "Blue"), ("#b06de8", "Purple"), ("#f5c842", "Gold"),
    ]

    static func trigger(_ event: String) -> AutomationTriggerSpec? {
        triggers.first { $0.event == event }
    }

    static func action(_ kind: String) -> AutomationActionSpec? {
        actions.first { $0.kind == kind }
    }
}
