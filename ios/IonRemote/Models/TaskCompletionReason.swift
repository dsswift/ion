import Foundation

enum TaskCompletionReason: Codable, Equatable, Sendable {
    case normal
    case maxTurns
    case aborted
    case backendExit
    case unknown(String)

    init(from decoder: Decoder) throws {
        let value = try decoder.singleValueContainer().decode(String.self)
        switch value {
        case "normal": self = .normal
        case "max_turns": self = .maxTurns
        case "aborted": self = .aborted
        case "backend_exit": self = .backendExit
        default: self = .unknown(value)
        }
    }

    func encode(to encoder: Encoder) throws {
        var container = encoder.singleValueContainer()
        switch self {
        case .normal: try container.encode("normal")
        case .maxTurns: try container.encode("max_turns")
        case .aborted: try container.encode("aborted")
        case .backendExit: try container.encode("backend_exit")
        case .unknown(let value): try container.encode(value)
        }
    }

    var logValue: String {
        switch self {
        case .normal: return "normal"
        case .maxTurns: return "max_turns"
        case .aborted: return "aborted"
        case .backendExit: return "backend_exit"
        case .unknown(let value): return value
        }
    }
}
