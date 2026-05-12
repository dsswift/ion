import SwiftUI

@main
struct IonRemoteApp: App {
    @UIApplicationDelegateAdaptor(AppDelegate.self) private var appDelegate
    @State private var viewModel = SessionViewModel()
    @Environment(\.scenePhase) private var scenePhase

    var body: some Scene {
        WindowGroup {
            ContentView()
                .environment(viewModel)
                .preferredColorScheme(.dark)
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
        .onChange(of: viewModel.connectionState) { _, newState in
            if newState == .authFailed {
                viewModel.resetAll()
            }
        }
    }

    private var disconnectedView: some View {
        VStack(spacing: 16) {
            Spacer()
            ProgressView()
                .controlSize(.large)
            Text(viewModel.connectionState.label)
                .font(.headline)
            Text("Waiting for Ion desktop...")
                .font(.subheadline)
                .foregroundStyle(.secondary)
            Button("Retry") {
                viewModel.reconnect()
            }
            .buttonStyle(.borderedProminent)
            .padding(.top, 8)
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
                // Break out of a stuck handshake after 15 seconds and keep retrying.
                while !Task.isCancelled {
                    try? await Task.sleep(for: .seconds(15))
                    guard !Task.isCancelled,
                          viewModel.connectionState == .connecting else { return }
                    viewModel.reconnect()
                }
            default:
                break
            }
        }
    }
}
