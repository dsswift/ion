import SwiftUI

@main
struct IonRemoteApp: App {
    @UIApplicationDelegateAdaptor(AppDelegate.self) private var appDelegate
    @State private var viewModel = SessionViewModel()
    @Environment(\.scenePhase) private var scenePhase
    @State private var didGoToBackground = false

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
                        if didGoToBackground {
                            didGoToBackground = false
                            // Returning from a true app switch (went through .background).
                            // disconnect() already fired; only reconnect if a retry loop
                            // hasn't already started a new attempt.
                            if viewModel.connectionState == .disconnected {
                                viewModel.reconnect()
                            }
                        } else {
                            // Returning from screen lock (.inactive only, no .background).
                            // Reconnect on any non-connected state to recover silent relay drops.
                            if viewModel.connectionState != .connected {
                                viewModel.reconnect()
                            }
                        }
                    case .background:
                        didGoToBackground = true
                        viewModel.disconnect()
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
            } else if viewModel.connectionState == .disconnected || viewModel.connectionState == .connecting || viewModel.connectionState == .reconnecting {
                disconnectedView
            } else {
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
            case .connecting, .reconnecting:
                // Break out of a stuck handshake after 15 seconds and keep retrying.
                // Loop because reconnect() may batch .connecting→.disconnected→.connecting
                // in a single SwiftUI update so .task(id:) wouldn't restart.
                while !Task.isCancelled {
                    try? await Task.sleep(for: .seconds(15))
                    guard !Task.isCancelled,
                          viewModel.connectionState == .connecting
                              || viewModel.connectionState == .reconnecting else { return }
                    viewModel.reconnect()
                }
            default:
                break
            }
        }
    }
}
