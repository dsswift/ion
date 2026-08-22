import Foundation

/// One running session-owned background Bash task.
/// Mirrors the engine's additive `BackgroundTaskState` status snapshot.
struct BackgroundTaskState: Codable, Identifiable, Sendable, Equatable {
    let taskId: String
    let toolId: String?
    let command: String
    let startedAt: Int64
    let notifyOnComplete: Bool

    var id: String { taskId }

    private enum CodingKeys: String, CodingKey {
        case taskId, toolId, command, startedAt, notifyOnComplete
    }

    init(taskId: String, toolId: String? = nil, command: String, startedAt: Int64, notifyOnComplete: Bool) {
        self.taskId = taskId
        self.toolId = toolId
        self.command = command
        self.startedAt = startedAt
        self.notifyOnComplete = notifyOnComplete
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        taskId = try container.decode(String.self, forKey: .taskId)
        toolId = try container.decodeIfPresent(String.self, forKey: .toolId)
        command = try container.decode(String.self, forKey: .command)
        startedAt = try container.decode(Int64.self, forKey: .startedAt)
        notifyOnComplete = try container.decodeIfPresent(Bool.self, forKey: .notifyOnComplete) ?? false
    }
}
