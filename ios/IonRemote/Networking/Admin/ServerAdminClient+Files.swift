import Foundation

extension ServerAdminClient {
    /// The largest file the server sends as bytes. Mirrors `MAX_FILE_DATA_BYTES` in `packages/shared/src/file-link.ts`.
    static let maxFileDataBytes = 25 * 1024 * 1024

    func resolveFileLink(tabId: String, path: String, cwd: String) async throws -> FileLinkTarget {
        try await call(.fsResolveLink, fields: ["tabId": .string(tabId), "path": .string(path), "cwd": .string(cwd)])
    }

    /// The file's bytes, or nil when the server declines (missing, a folder, or over the size limit).
    func readFileData(tabId: String, filePath: String) async throws -> Data? {
        // A 25 MB file is about 34 MB of base64, which a relay carries slowly.
        let value: RemoteFileData? = try await call(.fsReadFileData, fields: ["tabId": .string(tabId), "filePath": .string(filePath)], timeoutSeconds: 120)
        guard let value else { return nil }
        return Data(base64Encoded: value.base64)
    }
}
