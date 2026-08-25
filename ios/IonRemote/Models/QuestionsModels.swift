import Foundation

// MARK: - Guided Questions models
//
// Swift mirrors of the desktop-owned Questions contract
// (desktop/src/shared/questions-schema.ts + questions-state.ts). The desktop
// main process is the ONLY workflow owner; iOS holds a synchronized replica
// keyed by tab, sends revisioned patches/actions, and replaces local state
// with every authoritative desktop_questions_state event (or the questions
// field on RemoteTabState in a full snapshot).

/// One selectable option on a question.
struct QuestionOption: Codable, Equatable, Sendable, Identifiable {
    let id: String
    let label: String
    let description: String?
}

/// One question on a page.
struct QuestionSpec: Codable, Equatable, Sendable, Identifiable {
    let id: String
    let prompt: String
    let guidance: String?
    /// "single" | "multiple" | "text"
    let mode: String
    /// Optional rendering hint ("radio" | "checkbox" | "pills").
    let display: String?
    let options: [QuestionOption]?

    /// The deterministic shared display rule — MUST match the TypeScript
    /// resolveQuestionDisplay in desktop/src/shared/questions-schema.ts
    /// (both sides pin it with unit tests): an explicit valid hint wins;
    /// otherwise pills for MORE THAN FIVE options none of which carries a
    /// description; else radio (single) / checkbox (multiple).
    var resolvedDisplay: String {
        let valid: [String] = mode == "single" ? ["radio", "pills"] : ["checkbox", "pills"]
        if mode == "text" { return "radio" }
        if let display, valid.contains(display) { return display }
        let opts = options ?? []
        let anyDescribed = opts.contains { ($0.description ?? "").isEmpty == false }
        if opts.count > 5 && !anyDescribed { return "pills" }
        return mode == "single" ? "radio" : "checkbox"
    }
}

/// The AskUserQuestions tool input: one page of questions.
struct QuestionsRequest: Codable, Equatable, Sendable {
    let title: String
    let description: String?
    let workflowId: String?
    let questions: [QuestionSpec]
}

/// One answered question inside a submitted page.
struct QuestionsPageAnswer: Codable, Equatable, Sendable {
    let questionId: String
    let prompt: String
    let selectedOptionIds: [String]
    let selectedLabels: [String]
    let customText: String?
    let skipped: Bool?
}

/// One submitted page (workflows can span several requestMore rounds).
struct QuestionsPageResult: Codable, Equatable, Sendable {
    let title: String
    let answers: [QuestionsPageAnswer]
    let comment: String?
}

/// One image attached to a question's answer (path on the desktop host).
struct QuestionAnswerAttachment: Codable, Equatable, Sendable {
    let path: String
    let name: String
}

/// The draft answer for one question, as edited in the wizard.
struct QuestionDraftAnswer: Codable, Equatable, Sendable {
    var questionId: String
    var selectedOptionIds: [String]
    var customText: String?
    var skipped: Bool?
    /// Images attached on the desktop. iOS renders their presence read-only;
    /// attaching from iOS is not supported (the paths are desktop-local).
    var attachments: [QuestionAnswerAttachment]?
}

/// One workflow's synchronized state (mirrors QuestionsWorkflowState).
struct QuestionsWorkflowState: Codable, Equatable, Sendable, Identifiable {
    var id: String { workflowId }
    let workflowId: String
    let requestId: String
    let sessionKey: String
    let conversationId: String?
    /// "collecting" | "review" | "submitting" | "awaiting_next" | "terminal"
    let phase: String
    let terminalReason: String?
    let request: QuestionsRequest
    var draft: [QuestionDraftAnswer]
    var comment: String?
    let history: [QuestionsPageResult]
    let revision: Int
    let startedAt: Double
    let pendingRequestMore: Bool?

    /// Open = renderable as an active wait (mirrors the desktop's
    /// openWorkflowsForTab filter). Parked questions are durable: restored
    /// and live entries render alike.
    var isOpen: Bool { phase != "terminal" }
}

/// Result of a patch/action attempt (echoed on the state event).
struct QuestionsActionResult: Codable, Equatable, Sendable {
    let actionId: String
    let accepted: Bool
    let error: String?
}

/// The full synchronized Questions state carried by desktop_questions_state.
struct QuestionsStateSnapshot: Codable, Equatable, Sendable {
    let workflows: [QuestionsWorkflowState]
    let lastActionResult: QuestionsActionResult?
}

/// A revisioned draft patch (iOS → desktop, desktop_questions_patch).
struct QuestionsPatch: Codable, Equatable, Sendable {
    let workflowId: String
    let requestId: String
    let expectedRevision: Int
    let actionId: String
    let answers: [QuestionDraftAnswer]?
    let comment: String?
}

/// A revisioned workflow action (iOS → desktop, desktop_questions_action).
/// Submit-bearing actions carry the final local draft inline (answers /
/// comment) so the draft and the transition land in ONE atomic revision step
/// on the desktop — never a patch followed by an action that guesses the
/// post-patch revision.
struct QuestionsAction: Codable, Equatable, Sendable {
    let workflowId: String
    let requestId: String
    let expectedRevision: Int
    let actionId: String
    /// "enter_review" | "edit_question" | "request_more" | "final_confirm" | "cancel"
    let kind: String
    let questionId: String?
    let answers: [QuestionDraftAnswer]?
    let comment: String?
}
