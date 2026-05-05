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

        case .fsWriteResult:
            let filePath = try container.decode(String.self, forKey: .filePath)
            let ok = try container.decode(Bool.self, forKey: .ok)
            let error = try container.decodeIfPresent(String.self, forKey: .error)
            let response = FsWriteResultResponse(filePath: filePath, ok: ok, error: error)
            return .fsWriteResult(filePath: filePath, response: response)

        case .discoverCommandsResponse:
            let directory = try container.decode(String.self, forKey: .directory)
            let commands = try container.decode([DiscoveredSlashCommand].self, forKey: .commands)
            return .discoverCommandsResponse(directory: directory, commands: commands)

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

        case .fsWriteResult(_, let response):
            try container.encode(TypeKey.fsWriteResult, forKey: .type)
            try container.encode(response.filePath, forKey: .filePath)
            try container.encode(response.ok, forKey: .ok)
            try container.encodeIfPresent(response.error, forKey: .error)
            return true

        case .discoverCommandsResponse(let directory, let commands):
            try container.encode(TypeKey.discoverCommandsResponse, forKey: .type)
            try container.encode(directory, forKey: .directory)
            try container.encode(commands, forKey: .commands)
            return true

        default:
            return false
        }
    }
}
