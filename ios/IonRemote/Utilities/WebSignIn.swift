import AuthenticationServices
import UIKit

/// Runs a browser sign-in in an in-app sheet and returns the address the
/// provider sent the browser back to. The return address is the app's own
/// scheme (`WebSignIn.callbackScheme`), so the sheet closes by itself; the
/// caller hands the returned URL to the server to finish the sign-in.
@MainActor
enum WebSignIn {
    /// The app's registered scheme. Sign-ins return to `ion-studio://oauth/callback`.
    static let callbackScheme = "ion-studio"
    static let redirectURI = "ion-studio://oauth/callback"

    enum Failure: Error, Equatable {
        /// The person closed the sheet.
        case cancelled
        case failed(String)
    }

    /// Opens `url`; returns the callback URL, or throws `.cancelled`.
    static func run(_ url: URL, prefersEphemeral: Bool = false) async throws -> URL {
        let anchor = PresentationAnchor()
        return try await withCheckedThrowingContinuation { continuation in
            let session = ASWebAuthenticationSession(url: url, callbackURLScheme: callbackScheme) { callback, error in
                if let callback {
                    DiagnosticLog.log("web sign-in returned", tag: "signin", fields: ["host": url.host ?? ""])
                    continuation.resume(returning: callback)
                } else if let error = error as? ASWebAuthenticationSessionError, error.code == .canceledLogin {
                    DiagnosticLog.log("web sign-in cancelled", tag: "signin", fields: ["host": url.host ?? ""])
                    continuation.resume(throwing: Failure.cancelled)
                } else {
                    let message = error.map { String(describing: $0) } ?? "no callback"
                    DiagnosticLog.log("web sign-in failed", tag: "signin", level: .warn, fields: ["host": url.host ?? "", "error": message])
                    continuation.resume(throwing: Failure.failed(message))
                }
            }
            session.presentationContextProvider = anchor
            session.prefersEphemeralWebBrowserSession = prefersEphemeral
            anchor.session = session
            if !session.start() {
                DiagnosticLog.log("web sign-in could not start", tag: "signin", level: .warn, fields: ["host": url.host ?? ""])
                continuation.resume(throwing: Failure.failed("The sign-in sheet could not open."))
            }
        }
    }

    /// Supplies the key window and keeps the session alive while it runs.
    private final class PresentationAnchor: NSObject, ASWebAuthenticationPresentationContextProviding {
        var session: ASWebAuthenticationSession?

        func presentationAnchor(for session: ASWebAuthenticationSession) -> ASPresentationAnchor {
            let scenes = UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }
            return scenes.flatMap(\.windows).first(where: \.isKeyWindow) ?? ASPresentationAnchor()
        }
    }
}
