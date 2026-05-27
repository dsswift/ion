import Foundation

// MARK: - File explorer events

extension RemoteEvent {

    /// Decode file explorer response events.
    static func decodeFiles(
        type: TypeKey,
        container: KeyedDecodingContainer<CodingKeys>
    ) throws -> RemoteEvent? {
        switch type {
        case .fsDirListing:
            let directory = try container.decode(String.self, forKey: .directory)
            let entries = try container.decode([FsEntry].self, forKey: .entries)
            let error = try container.decodeIfPresent(String.self, forKey: .error)
            let response = FsDirListingResponse(directory: directory, entries: entries, error: error)
            return .fsDirListing(directory: directory, response: response)

        case .fsFileContent:
            let filePath = try container.decode(String.self, forKey: .filePath)
            let content = try container.decodeIfPresent(String.self, forKey: .content)
            let error = try container.decodeIfPresent(String.self, forKey: .error)
            let response = FsFileContentResponse(filePath: filePath, content: content, error: error)
            return .fsFileContent(filePath: filePath, response: response)

        case .fsImageContent:
            let filePath = try container.decode(String.self, forKey: .filePath)
            let dataUrl = try container.decodeIfPresent(String.self, forKey: .dataUrl)
            let error = try container.decodeIfPresent(String.self, forKey: .error)
            return .fsImageContent(filePath: filePath, dataUrl: dataUrl, error: error)

        case .fsWriteResult:
            let filePath = try container.decode(String.self, forKey: .filePath)
            let ok = try container.decode(Bool.self, forKey: .ok)
            let error = try container.decodeIfPresent(String.self, forKey: .error)
            let response = FsWriteResultResponse(filePath: filePath, ok: ok, error: error)
            return .fsWriteResult(filePath: filePath, response: response)

        case .fsRenameResult:
            let oldPath = try container.decode(String.self, forKey: .oldPath)
            let newPath = try container.decode(String.self, forKey: .newPath)
            let ok = try container.decode(Bool.self, forKey: .ok)
            let error = try container.decodeIfPresent(String.self, forKey: .error)
            let response = FsRenameResultResponse(oldPath: oldPath, newPath: newPath, ok: ok, error: error)
            return .fsRenameResult(oldPath: oldPath, newPath: newPath, response: response)

        case .discoverCommandsResponse:
            let directory = try container.decode(String.self, forKey: .directory)
            let commands = try container.decode([DiscoveredSlashCommand].self, forKey: .commands)
            return .discoverCommandsResponse(directory: directory, commands: commands)

        case .uploadAttachmentResult:
            let id = try container.decode(String.self, forKey: .id)
            let name = try container.decode(String.self, forKey: .name)
            let path = try container.decode(String.self, forKey: .path)
            let correlationId = try container.decodeIfPresent(String.self, forKey: .correlationId)
            let error = try container.decodeIfPresent(String.self, forKey: .error)
            return .uploadAttachmentResult(id: id, name: name, path: path, correlationId: correlationId, error: error)

        case .tabAttachments:
            let tabId = try container.decode(String.self, forKey: .tabId)
            let attachments = try container.decode([TabAttachmentEntry].self, forKey: .attachments)
            return .tabAttachments(tabId: tabId, attachments: attachments)

        default:
            return nil
        }
    }

    /// Encode file explorer events. Returns `true` if the receiver was a file event.
    func encodeFiles(into container: inout KeyedEncodingContainer<CodingKeys>) throws -> Bool {
        switch self {
        case .fsDirListing(_, let response):
            try container.encode(TypeKey.fsDirListing, forKey: .type)
            try container.encode(response.directory, forKey: .directory)
            try container.encode(response.entries, forKey: .entries)
            try container.encodeIfPresent(response.error, forKey: .error)
            return true

        case .fsFileContent(_, let response):
            try container.encode(TypeKey.fsFileContent, forKey: .type)
            try container.encode(response.filePath, forKey: .filePath)
            try container.encodeIfPresent(response.content, forKey: .content)
            try container.encodeIfPresent(response.error, forKey: .error)
            return true

        case .fsImageContent(let filePath, let dataUrl, let error):
            try container.encode(TypeKey.fsImageContent, forKey: .type)
            try container.encode(filePath, forKey: .filePath)
            try container.encodeIfPresent(dataUrl, forKey: .dataUrl)
            try container.encodeIfPresent(error, forKey: .error)
            return true

        case .fsWriteResult(_, let response):
            try container.encode(TypeKey.fsWriteResult, forKey: .type)
            try container.encode(response.filePath, forKey: .filePath)
            try container.encode(response.ok, forKey: .ok)
            try container.encodeIfPresent(response.error, forKey: .error)
            return true

        case .fsRenameResult(_, _, let response):
            try container.encode(TypeKey.fsRenameResult, forKey: .type)
            try container.encode(response.oldPath, forKey: .oldPath)
            try container.encode(response.newPath, forKey: .newPath)
            try container.encode(response.ok, forKey: .ok)
            try container.encodeIfPresent(response.error, forKey: .error)
            return true

        case .discoverCommandsResponse(let directory, let commands):
            try container.encode(TypeKey.discoverCommandsResponse, forKey: .type)
            try container.encode(directory, forKey: .directory)
            try container.encode(commands, forKey: .commands)
            return true

        case .uploadAttachmentResult(let id, let name, let path, let correlationId, let error):
            try container.encode(TypeKey.uploadAttachmentResult, forKey: .type)
            try container.encode(id, forKey: .id)
            try container.encode(name, forKey: .name)
            try container.encode(path, forKey: .path)
            try container.encodeIfPresent(correlationId, forKey: .correlationId)
            try container.encodeIfPresent(error, forKey: .error)
            return true

        case .tabAttachments(let tabId, let attachments):
            try container.encode(TypeKey.tabAttachments, forKey: .type)
            try container.encode(tabId, forKey: .tabId)
            try container.encode(attachments, forKey: .attachments)
            return true

        default:
            return false
        }
    }
}
