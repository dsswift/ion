import UIKit
import UserNotifications

/// Handles push notification registration and delivery.
///
/// This is intentionally minimal — push notifications are an
/// enhancement, not a requirement. All app functionality works
/// via WebSocket regardless of push status.
final class AppDelegate: NSObject, UIApplicationDelegate, UNUserNotificationCenterDelegate {

    /// Shared reference set by IonRemoteApp so we can forward the device token.
    weak var sessionViewModel: SessionViewModel?

    func application(
        _ application: UIApplication,
        didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil
    ) -> Bool {
        UNUserNotificationCenter.current().delegate = self
        requestNotificationPermission()
        return true
    }

    // MARK: - Registration

    func application(
        _ application: UIApplication,
        didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data
    ) {
        let token = deviceToken.map { String(format: "%02x", $0) }.joined()
        DiagnosticLog.log("apns registered", tag: "apns", fields: ["token_prefix": String(token.prefix(8))])
        sessionViewModel?.apnsToken = token
    }

    func application(
        _ application: UIApplication,
        didFailToRegisterForRemoteNotificationsWithError error: Error
    ) {
        // Graceful degradation: push is optional.
        DiagnosticLog.log("apns registration failed", tag: "apns", level: .error, fields: ["error": error.localizedDescription])
    }

    // MARK: - Foreground delivery

    /// Suppress notifications when the app is in the foreground.
    func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        willPresent notification: UNNotification,
        withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void
    ) {
        // Don't show a banner if the user is already looking at the app.
        completionHandler([])
    }

    /// Handle notification taps (app was in background or closed).
    func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        didReceive response: UNNotificationResponse,
        withCompletionHandler completionHandler: @escaping () -> Void
    ) {
        let userInfo = response.notification.request.content.userInfo
        if let tabId = userInfo["tabId"] as? String {
            sessionViewModel?.navigateToTab(tabId)
        }
        completionHandler()
    }

    // MARK: - Private

    private func requestNotificationPermission() {
        UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .badge, .sound]) { granted, error in
            if let error {
                DiagnosticLog.log("apns authorization error", tag: "apns", level: .error, fields: ["error": error.localizedDescription])
                return
            }
            guard granted else {
                DiagnosticLog.log("apns authorization denied by user", tag: "apns", level: .warn)
                return
            }
            DispatchQueue.main.async {
                UIApplication.shared.registerForRemoteNotifications()
            }
        }
    }
}
