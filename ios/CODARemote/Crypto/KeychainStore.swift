import Foundation
import Security

/// Secure keychain storage for paired device credentials and arbitrary data blobs.
struct KeychainStore {

    private static let service = "com.coda.remote"
    private static let pairedDevicesKey = "paired-devices"

    enum Error: Swift.Error {
        case encodingFailed
        case decodingFailed
        case saveFailed(OSStatus)
        case loadFailed(OSStatus)
        case deleteFailed(OSStatus)
    }

    // MARK: - Paired devices

    /// Save paired devices to the keychain as JSON.
    static func savePairedDevices(_ devices: [PairedDevice]) throws {
        let data = try JSONEncoder().encode(devices)
        try save(key: pairedDevicesKey, data: data)
    }

    /// Load paired devices from the keychain.
    static func loadPairedDevices() throws -> [PairedDevice] {
        guard let data = try load(key: pairedDevicesKey) else {
            return []
        }
        return try JSONDecoder().decode([PairedDevice].self, from: data)
    }

    /// Delete all paired device data from the keychain.
    static func deleteAll() throws {
        try delete(key: pairedDevicesKey)
    }

    // MARK: - Generic key-value storage

    /// Save a data blob to the keychain under the given key.
    /// Overwrites any existing value for the same key.
    static func save(key: String, data: Data) throws {
        // Delete any existing item first so the add doesn't conflict.
        let deleteQuery: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: key,
        ]
        SecItemDelete(deleteQuery as CFDictionary)

        let addQuery: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: key,
            kSecAttrAccessible as String: kSecAttrAccessibleWhenUnlockedThisDeviceOnly,
            kSecValueData as String: data,
        ]
        let status = SecItemAdd(addQuery as CFDictionary, nil)
        guard status == errSecSuccess else {
            throw Error.saveFailed(status)
        }
    }

    /// Load a data blob from the keychain. Returns nil if the key does not exist.
    static func load(key: String) throws -> Data? {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: key,
            kSecReturnData as String: true,
            kSecMatchLimit as String: kSecMatchLimitOne,
        ]
        var result: AnyObject?
        let status = SecItemCopyMatching(query as CFDictionary, &result)
        if status == errSecItemNotFound {
            return nil
        }
        guard status == errSecSuccess, let data = result as? Data else {
            throw Error.loadFailed(status)
        }
        return data
    }

    /// Delete a single value from the keychain.
    static func delete(key: String) throws {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: key,
        ]
        let status = SecItemDelete(query as CFDictionary)
        guard status == errSecSuccess || status == errSecItemNotFound else {
            throw Error.deleteFailed(status)
        }
    }
}
