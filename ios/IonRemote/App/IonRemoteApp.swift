import SwiftUI

@main
struct IonRemoteApp: App {
    @UIApplicationDelegateAdaptor(AppDelegate.self) private var appDelegate
    @State private var viewModel = SessionViewModel()
    @Environment(\.scenePhase) private var scenePhase

    init() {
        CrashReporter.install()
    }

    var body: some Scene {
        WindowGroup {
            ContentView()
                .environment(viewModel)
                .preferredColorScheme(.dark)
                .tint(IonTheme.accent)
                .onAppear {
                    appDelegate.sessionViewModel = viewModel
                }
                .onChange(of: scenePhase) { _, newPhase in
                    switch newPhase {
                    case .active:
                        guard !viewModel.pairedDevices.isEmpty else { break }
                        // Resume transport without wiping state.
                        viewModel.resumeTransport()
                    case .background:
                        // Stop transport but preserve all state (tabs, messages,
                        // navigation, typed input) so the user returns to the
                        // same view when the app foregrounds.
                        viewModel.suspendTransport()
                    default:
                        break
                    }
                }
        }
    }
}

struct ContentView: View {
    @Environment(SessionViewModel.self) private var viewModel
    @State private var connectingElapsed: Int = 0
    @State private var showTroubleshooting = false

    var body: some View {
        Group {
            if viewModel.pairedDevices.isEmpty || viewModel.connectionState == .authFailed {
                PairingView()
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
        .overlay(alignment: .top) {
            ToastOverlay(
                messages: viewModel.toastMessages,
                onDismiss: { viewModel.dismissToast(id: $0) }
            )
        }
        .onChange(of: viewModel.connectionState) { _, newState in
            if newState == .authFailed {
                viewModel.resetAll()
            }
        }
    }

    private var disconnectedView: some View {
        VStack(spacing: 16) {
            Spacer()
            Image(systemName: "bolt.shield.fill")
                .font(.system(size: 50))
                .foregroundStyle(IonTheme.accent)
            ProgressView()
                .controlSize(.large)
            Text(viewModel.connectionState.label)
                .font(.headline)
            Text("Waiting for Ion desktop...")
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
            .tint(IonTheme.accent)
            .padding(.top, 8)
            if connectingElapsed > 10 {
                DisclosureGroup("Troubleshooting", isExpanded: $showTroubleshooting) {
                    VStack(alignment: .leading, spacing: 6) {
                        Label("Make sure Ion desktop is running", systemImage: "desktopcomputer")
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
                    .tint(IonTheme.accent)
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
                    try? await Task.sleep(for: .seconds(5))
                    guard !Task.isCancelled,
                          viewModel.connectionState == .disconnected else { break }
                    viewModel.reconnect()
                }
            case .connecting:
                connectingElapsed = 0
                while !Task.isCancelled {
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
