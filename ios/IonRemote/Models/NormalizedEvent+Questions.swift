import Foundation

// MARK: - Guided Questions events
//
// Decode/encode for desktop_questions_state — the authoritative
// guided-questions workflow snapshot (complete replacement per tab). Kept in
// its own family file per the one-family-per-file decoder convention.

extension RemoteEvent {

    /// Decode guided-questions events. Returns nil for anything not owned
    /// here, so the caller can fall through to the other decoders.
    static func decodeQuestions(
        type: TypeKey,
        container: KeyedDecodingContainer<CodingKeys>
    ) throws -> RemoteEvent? {
        switch type {
        case .questionsState:
            let tabId = try container.decode(String.self, forKey: .tabId)
            let state = try container.decode(QuestionsStateSnapshot.self, forKey: .state)
            return .questionsState(tabId: tabId, state: state)
        default:
            return nil
        }
    }

    /// Encode guided-questions events. Returns false when the event is not
    /// owned here.
    func encodeQuestions(into container: inout KeyedEncodingContainer<CodingKeys>) throws -> Bool {
        switch self {
        case .questionsState(let tabId, let state):
            try container.encode(TypeKey.questionsState, forKey: .type)
            try container.encode(tabId, forKey: .tabId)
            try container.encode(state, forKey: .state)
            return true
        default:
            return false
        }
    }
}
