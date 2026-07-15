import Foundation

/// Attachment associated with a message (file, image, or plan).
/// Mirrors the engine's `SessionMessageAttachment` shared type (manifest entry
/// in contracts.json) on the history-reload path; live handlers construct it
/// locally without a mimeType.
struct MessageAttachment: Codable, Identifiable, Sendable {
    let id: String
    let type: AttachmentType
    let name: String
    let path: String
    /// MIME type carried by the engine on persisted attachments
    /// (e.g. "image/png"). Nil on locally-constructed attachments.
    var mimeType: String? = nil
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
