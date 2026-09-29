import Foundation

/// One JSON value of any shape.
///
/// The Studio wire carries open-ended payloads: action arguments and results,
/// event payloads, and the welcome snapshot. Those stay in this form until the
/// layer that knows their meaning decodes them, so the transport never has to
/// model a payload it does not interpret.
///
/// Whole numbers and fractional numbers are kept apart so a value that arrived
/// as `200` is sent back as `200`, not `200.0`.
enum JSONValue: Equatable, Sendable {
    case null
    case bool(Bool)
    case int(Int)
    case double(Double)
    case string(String)
    case array([JSONValue])
    case object([String: JSONValue])
}

// MARK: - Codable

extension JSONValue: Codable {
    init(from decoder: Decoder) throws {
        let container = try decoder.singleValueContainer()
        // Each `try?` below asks "is it this type?". A miss is the question's
        // answer, not a failure; a value that is none of them throws at the end.
        // swiftlint:disable silent_try_optional
        if container.decodeNil() {
            self = .null
        } else if let value = try? container.decode(Bool.self) {
            self = .bool(value)
        } else if let value = try? container.decode(Int.self) {
            self = .int(value)
        } else if let value = try? container.decode(Double.self) {
            self = .double(value)
        } else if let value = try? container.decode(String.self) {
            self = .string(value)
        } else if let value = try? container.decode([JSONValue].self) {
            self = .array(value)
        } else if let value = try? container.decode([String: JSONValue].self) {
            self = .object(value)
        } else {
            throw DecodingError.dataCorrupted(
                .init(codingPath: decoder.codingPath, debugDescription: "value is not JSON")
            )
        }
        // swiftlint:enable silent_try_optional
    }

    func encode(to encoder: Encoder) throws {
        var container = encoder.singleValueContainer()
        switch self {
        case .null: try container.encodeNil()
        case .bool(let value): try container.encode(value)
        case .int(let value): try container.encode(value)
        case .double(let value): try container.encode(value)
        case .string(let value): try container.encode(value)
        case .array(let value): try container.encode(value)
        case .object(let value): try container.encode(value)
        }
    }
}

// MARK: - Reading

extension JSONValue {
    var stringValue: String? {
        if case .string(let value) = self { return value }
        return nil
    }

    var boolValue: Bool? {
        if case .bool(let value) = self { return value }
        return nil
    }

    var intValue: Int? {
        if case .int(let value) = self { return value }
        return nil
    }

    /// Either number case, as a `Double`.
    var numberValue: Double? {
        switch self {
        case .int(let value): return Double(value)
        case .double(let value): return value
        default: return nil
        }
    }

    var arrayValue: [JSONValue]? {
        if case .array(let value) = self { return value }
        return nil
    }

    var objectValue: [String: JSONValue]? {
        if case .object(let value) = self { return value }
        return nil
    }

    var isNull: Bool { self == .null }

    /// The member named `key` when this is an object that has one.
    subscript(key: String) -> JSONValue? {
        objectValue?[key]
    }

    /// Decodes this value as `type`, for the layer that knows what a payload means.
    func decoded<T: Decodable>(as type: T.Type, decoder: JSONDecoder = JSONDecoder()) throws -> T {
        try decoder.decode(type, from: JSONEncoder().encode(self))
    }

    /// Builds a value from anything `Encodable`, for action arguments.
    static func encoding<T: Encodable>(_ value: T, encoder: JSONEncoder = JSONEncoder()) throws -> JSONValue {
        try JSONDecoder().decode(JSONValue.self, from: encoder.encode(value))
    }
}

// MARK: - Keyed container helpers

extension KeyedDecodingContainer {
    /// A required member that may be JSON `null`. `null` decodes to `.null`
    /// rather than being reported as a missing value.
    func decodeJSON(forKey key: Key) throws -> JSONValue {
        guard contains(key) else {
            throw DecodingError.keyNotFound(key, .init(codingPath: codingPath, debugDescription: "required member is absent"))
        }
        if try decodeNil(forKey: key) { return .null }
        return try decode(JSONValue.self, forKey: key)
    }

    /// An optional member, keeping "absent" (`nil`) apart from "present and null" (`.null`).
    func decodeJSONIfPresent(forKey key: Key) throws -> JSONValue? {
        guard contains(key) else { return nil }
        return try decodeJSON(forKey: key)
    }
}
