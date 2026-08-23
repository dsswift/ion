import Foundation

/// Typed metadata carried with a background-work row. Content itself stays on
/// the adjacent `Message`, so the displayed expansion is exactly model-facing.
struct BackgroundWorkMetadata: Codable, Sendable, Equatable {
    let kind: String
    let deliveryMode: String
    let items: [BackgroundWorkItem]
    let remainingTaskIds: [String]?
}

struct BackgroundWorkItem: Codable, Sendable, Equatable {
    let id: String
    let source: String
    let label: String?
    let status: String
    let exitCode: Int
    let elapsedMs: Int?
    let outputPath: String?
}
