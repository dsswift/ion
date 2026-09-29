import Foundation

/// The sentence a settings screen shows for a failed call.
enum AdminFailureText {
    static func describe(_ error: Error) -> String {
        if let failure = error as? StudioActionFailure, let message = failure.errorDescription { return message }
        return error.localizedDescription
    }

    /// A short name for the failure, for a log field.
    static func code(_ error: Error) -> String {
        (error as? StudioActionFailure)?.outcomeCode ?? String(describing: type(of: error))
    }
}
