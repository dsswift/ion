import SwiftUI

@main
struct IonRemoteApp: App {
    @UIApplicationDelegateAdaptor(AppDelegate.self) private var appDelegate
    @State private var viewModel = SessionViewModel()
    @State private var themeManager = ThemeManager()
    @Environment(\.scenePhase) private var scenePhase

    init() {
        CrashReporter.install()
        // MetricKit catches what the in-process breadcrumb cannot: jetsam
        // memory kills, watchdog terminations, and hangs — delivered by the
        // OS on the next launch. Device-only (no simulator payloads).
        MetricKitCrashObserver.start()
    }

    var body: some Scene {
        WindowGroup {
            ContentView()
                .environment(viewModel)
                .environment(\.appTheme, themeManager)
                .preferredColorScheme(themeManager.preferredColorScheme)
                .tint(themeManager.accent)
                .onAppear {
                    appDelegate.sessionViewModel = viewModel
                    // Theme sync: event handlers route desktop_theme_manifest
                    // and asset content into the ThemeManager's registry.
                    viewModel.themeManager = themeManager
                    DiagnosticLog.log("theme injected", tag: "app", fields: [
                        "reason": themeManager.selectedThemeId,
                        "status": String(describing: themeManager.accent)
                    ])
                    // Cached tabs bypass ContentView's empty-state retry task.
                    // Start the selected pairing's transport here so cold launch
                    // converges whether cache exists or not; no UI surface owns
                    // connection recovery.
                    viewModel.resumeTransport()
                }
                .onOpenURL { url in
                    if StudioPairingLink.looksLikeLink(url.absoluteString) {
                        DiagnosticLog.log("opened a studio pairing link", tag: "app")
                        viewModel.pairWithStudioLink(url.absoluteString)
                    } else if DeepLinkURL.isDeepLink(url) {
                        DiagnosticLog.log("opened an ion deep link", tag: "deeplink", fields: ["route": url.host ?? ""])
                        viewModel.openDeepLink(url)
                    } else {
                        DiagnosticLog.log("opened url ignored, not a pairing or deep link", tag: "app", level: .warn, fields: [
                            "scheme": url.scheme ?? ""
                        ])
                    }
                }
                .onChange(of: scenePhase) { _, newPhase in
                    switch newPhase {
                    case .active:
                        guard !viewModel.pairedDevices.isEmpty else { break }
                        // Resume transport without wiping state.
                        viewModel.resumeTransport()
                        // Auto-fired resume commands must wait until the
                        // transport is actually usable — `resumeTransport`
                        // returns synchronously after kicking off the
                        // handshake task, so firing sends here would race
                        // the LAN/relay connect and surface spurious
                        // "Not connected" / "Send failed" toasts. The
                        // `runWhenConnected` helper defers each block
                        // until `handleSnapshot` confirms the first
                        // snapshot has arrived (state → .connected).
                        // Manual user actions are deliberately NOT routed
                        // through this helper — their toasts are
                        // legitimate feedback when a real disconnect is
                        // in progress.
                        // Weak through a local: the view model holds this
                        // block until the snapshot lands, and naming the
                        // property directly would capture it strongly first.
                        let model = viewModel
                        model.runWhenConnected { [weak model] in
                            guard let viewModel = model else { return }
                            // Refresh git info for every visible tab dir — the
                            // desktop watcher may have dropped events while we
                            // were backgrounded, so we can't trust cached state.
                            if viewModel.showGitInfoInTabList {
                                viewModel.requestAllGitChanges()
                            }
                            // Re-send the current focus state so the desktop's
                            // deviceFocusMap is fresh after any suspension gap.
                            // Uses the locally-tracked focusedTabId (may be nil
                            // if the user hasn't opened a tab yet this session).
                            viewModel.sendReportFocus(tabId: viewModel.focusedTabId)
                        }
                    case .background:
                        // Push any debounced draft out before the transport
                        // stops. A suspended app may never run the pending
                        // timer, and the draft is the one piece of state whose
                        // whole purpose is surviving what happens next; if the
                        // send cannot go now it rides the essential queue to
                        // the next connect.
                        viewModel.flushAllDraftSends()
                        // Stop the Environment load summary; the phone only
                        // shows it while in the foreground.
                        viewModel.stopSystemMetricsWatch()
                        // Stop transport but preserve all state (tabs, messages,
                        // navigation, typed input) so the user returns to the
                        // same view when the app foregrounds.
                        viewModel.suspendTransport()
                        // Tell the desktop this device is no longer focused on
                        // any tab so redirect-level intercepts are not sent to
                        // a backgrounded device. Send before suspending the
                        // transport so the message can be flushed.
                        viewModel.sendReportFocus(tabId: nil)
                    default:
                        break
                    }
                }
        }
    }
}

struct ContentView: View {
    @Environment(SessionViewModel.self) private var viewModel
    @Environment(\.appTheme) private var theme
    @State private var connectingElapsed: Int = 0
    @State private var showTroubleshooting = false

    var body: some View {
        Group {
            // Locked desktop access never auto-wipes: paired devices, Keychain,
            // and cached layout survive explicit auth refusal so recovery can
            // restore access without re-pairing. The root gate hides the entire
            // desktop-owned subtree instead of treating this as a network drop.
            if viewModel.pairedDevices.isEmpty {
                PairingView()
            } else if viewModel.activeServerIsLocked {
                ServerAccessRecoveryView()
            } else if !viewModel.hasConnectedBefore && viewModel.tabs.isEmpty
                        && viewModel.connectionState != .connected {
                // First launch with no cached data — show the connecting screen.
                disconnectedView
            } else {
                // Show tab list whenever we have data (live or cached).
                // A reconnecting banner handles transient disconnects.
                TabListView()
            }
        }
        .modifier(DeepLinkPresenter())
        .overlay { ProviderSubscriptionPromptOverlay() }
        .overlay(alignment: .top) {
            ToastOverlay(
                messages: viewModel.toastMessages,
                onDismiss: { viewModel.dismissToast(id: $0) }
            )
        }
    }

    private var disconnectedView: some View {
        VStack(spacing: 16) {
            Spacer()
            Image(systemName: "bolt.shield.fill")
                .font(.system(size: 50))
                .foregroundStyle(theme.accent)
            ProgressView()
                .controlSize(.large)
            Text(viewModel.connectionState.label)
                .font(.headline)
            Text("Waiting for the Ion server...")
                .font(.subheadline)
                .foregroundStyle(.secondary)
            if viewModel.connectionState == .connecting && connectingElapsed > 0 {
                Text("Attempting connection… \(connectingElapsed)s")
                    .font(.caption)
                    .foregroundStyle(.tertiary)
            }
            Button("Retry") {
                viewModel.reconnect()
            }
            .buttonStyle(.borderedProminent)
            .tint(theme.accent)
            .padding(.top, 8)
            if connectingElapsed > 10 {
                DisclosureGroup("Troubleshooting", isExpanded: $showTroubleshooting) {
                    VStack(alignment: .leading, spacing: 6) {
                        Label("Make sure the Ion server is running", systemImage: "server.rack")
                        Label("Check you're on the same network", systemImage: "wifi")
                        Label("Try tapping Retry", systemImage: "arrow.clockwise")
                    }
                    .font(.caption)
                    .foregroundStyle(.secondary)
                }
                .font(.caption)
                .padding(.horizontal, 32)
                .tint(.secondary)
            }
            if connectingElapsed > 10, viewModel.pairedDevices.count > 1 {
                let others = viewModel.pairedDevices.filter { $0.id != viewModel.activeDeviceId }
                if let other = others.first {
                    Button {
                        viewModel.switchToDevice(id: other.id)
                        connectingElapsed = 0
                    } label: {
                        Label("Try \(other.name)", systemImage: "arrow.right.arrow.left")
                            .font(.caption)
                    }
                    .buttonStyle(.bordered)
                    .tint(theme.accent)
                }
            }
            Spacer()
            Button("Unpair and Start Over", role: .destructive) {
                viewModel.resetAll()
            }
            .font(.footnote)
            .padding(.bottom, 32)
        }
        .task(id: viewModel.connectionState) {
            guard !viewModel.pairedDevices.isEmpty else { return }
            switch viewModel.connectionState {
            case .disconnected:
                // Auto-retry every 5 seconds while on the disconnected screen.
                while !Task.isCancelled {
                    // Only CancellationError can surface; the guard below re-checks cancellation.
                    // swiftlint:disable:next silent_try_optional
                    try? await Task.sleep(for: .seconds(5))
                    guard !Task.isCancelled,
                          viewModel.connectionState == .disconnected else { break }
                    viewModel.reconnect()
                }
            case .connecting:
                connectingElapsed = 0
                while !Task.isCancelled {
                    // Only CancellationError can surface; the guard below re-checks cancellation.
                    // swiftlint:disable:next silent_try_optional
                    try? await Task.sleep(for: .seconds(1))
                    guard !Task.isCancelled,
                          viewModel.connectionState == .connecting else { return }
                    connectingElapsed += 1
                    if connectingElapsed >= 15 {
                        viewModel.reconnect()
                        connectingElapsed = 0
                    }
                }
            default:
                break
            }
        }
    }
}
