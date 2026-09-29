import Foundation

/// The stored evaluation path of one run: what triggered it, how its
/// conditions and cycle guard decided, and what each step did.
struct AutomationEvaluationTrace: Codable, Equatable, Sendable {
    struct Trigger: Codable, Equatable, Sendable {
        let eventType: String
        let occurredAt: String?
    }

    struct Causation: Codable, Equatable, Sendable {
        /// `continued`, `cycle`, `max-depth`, or `not-evaluated`.
        let decision: String
        let input: AutomationCausation
        let output: AutomationCausation?
    }

    let trigger: Trigger
    let condition: AutomationConditionDecision
    let causation: Causation
    let steps: [AutomationStepDecision]
}
