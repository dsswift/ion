import Foundation

/// One automation run, as `automation.history` stores it.
struct AutomationHistoryEntry: Codable, Equatable, Sendable, Identifiable {
    let id: String
    let automationId: String
    let eventType: String
    let causation: AutomationCausation
    let startedAt: String
    let finishedAt: String
    /// `succeeded`, `failed`, or `skipped`.
    let outcome: String
    let error: String?
    /// Absent on runs stored before traces existed.
    let trace: AutomationEvaluationTrace?
}
