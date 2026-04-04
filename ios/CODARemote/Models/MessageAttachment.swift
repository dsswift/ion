import Foundation

/// Attachment associated with a message (file, image, or plan).
struct MessageAttachment: Codable, Identifiable, Sendable {
    let id: String
    let type: AttachmentType
    let name: String
    let path: String
}

enum AttachmentType: String, Codable, Sendable {
    case image, file, plan
}
