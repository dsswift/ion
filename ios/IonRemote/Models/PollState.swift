import Foundation

struct PollState: Codable, Sendable, Identifiable {
    let pollId: String
    let intent: String
    let attempt: Int
    let deadlineAt: Int64
    let activeDispatchId: String?
    let latestEvidence: String?

    var id: String { pollId }
}
