import Foundation

/// Which control occupies the composer's trailing slot.
///
/// The mic alone when there is nothing to send, the mic beside the send arrow
/// once there is, and the dictation pair (Done beside Send) while a session is
/// open. Resolved here, outside the view, so the rule is pinned by a test
/// rather than re-derived at each render site.
enum ComposerTrailingControl: Equatable {
    /// Nothing to send yet: offer dictation.
    case microphone
    /// A draft or attachment exists: offer send, and keep dictation.
    case send
    /// A dictation session is open: Done keeps the words, Send keeps and sends.
    case dictation

    /// Dictation is offered in every state except while a session is already
    /// open. An attachment or a typed draft does not take the mic away:
    /// speaking is how the words that go with a screenshot usually get added,
    /// and dictating appends to a draft rather than replacing it.
    var showsMicrophone: Bool { self != .dictation }

    static func resolve(isDictating: Bool, hasText: Bool, hasAttachments: Bool) -> ComposerTrailingControl {
        if isDictating { return .dictation }
        return (hasText || hasAttachments) ? .send : .microphone
    }

    /// The composer's placeholder for a dictation phase. Idle reads as a
    /// message field; every other phase says what the microphone is doing so
    /// a slow first start never looks like a dead tap.
    static func placeholder(for phase: SpeechRecognitionService.DictationPhase) -> String {
        switch phase {
        case .idle: return "Message"
        case .starting: return "Starting microphone…"
        case .listening: return "Listening…"
        case .finishing: return "Finishing…"
        }
    }
}
