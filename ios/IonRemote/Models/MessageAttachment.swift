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

/// Result of an upload_attachment command from the desktop.
struct UploadAttachmentResult: Identifiable, Sendable, Equatable {
    let id: String
    let name: String
    let path: String
    let correlationId: String?
    let error: String?
}
