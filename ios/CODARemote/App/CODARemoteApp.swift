import SwiftUI

@main
struct CODARemoteApp: App {
    @State private var viewModel = SessionViewModel()
    @Environment(\.scenePhase) private var scenePhase

    var body: some Scene {
        WindowGroup {
            ContentView()
                .environment(viewModel)
                .preferredColorScheme(.dark)
                .onChange(of: scenePhase) { _, newPhase in
                    if newPhase == .active
                        && viewModel.connectionState == .disconnected
                        && !viewModel.pairedDevices.isEmpty {
                        viewModel.reconnect()
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
        .onAppear {
            if !viewModel.pairedDevices.isEmpty && viewModel.connectionState == .disconnected {
                viewModel.reconnect()
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
            Text("Waiting for CODA desktop...")
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
        .task(id: viewModel.connectionState == .disconnected) {
            // Auto-retry every 5 seconds while on the disconnected screen.
            guard viewModel.connectionState == .disconnected,
                  !viewModel.pairedDevices.isEmpty else { return }
            while !Task.isCancelled {
                try? await Task.sleep(for: .seconds(5))
                guard !Task.isCancelled,
                      viewModel.connectionState == .disconnected,
                      !viewModel.pairedDevices.isEmpty else { break }
                viewModel.reconnect()
            }
        }
    }
}
