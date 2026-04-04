import SwiftUI

struct TabListView: View {
    @Environment(SessionViewModel.self) private var viewModel
    @State private var showSettings = false
    @State private var showNewTab = false
    @State private var navigationPath = NavigationPath()

    var body: some View {
        NavigationStack(path: $navigationPath) {
            List {
                ForEach(viewModel.tabsByDirectory, id: \.fullPath) { group in
                    Section {
                        ForEach(group.tabs) { tab in
                            NavigationLink(value: tab.id) {
                                TabRowView(tab: tab)
                            }
                        }
                        .onDelete { offsets in
                            let ids = offsets.map { group.tabs[$0].id }
                            for id in ids {
                                viewModel.closeTab(id)
                            }
                        }
                    } header: {
                        HStack {
                            Label(group.directory, systemImage: "folder")
                                .font(.subheadline.weight(.semibold))
                                .foregroundStyle(.secondary)
                            Spacer()
                            Button {
                                viewModel.createTab(workingDirectory: group.fullPath)
                            } label: {
                                Image(systemName: "plus")
                                    .font(.subheadline)
                                    .foregroundStyle(.secondary)
                            }
                            .contextMenu {
                                Button {
                                    viewModel.createTab(workingDirectory: group.fullPath)
                                } label: {
                                    Label("New Tab", systemImage: "plus")
                                }
                                Button {
                                    viewModel.createTerminalTab(workingDirectory: group.fullPath)
                                } label: {
                                    Label("New Terminal", systemImage: "terminal")
                                }
                            }
                        }
                    }
                }
            }
            .navigationTitle("CODA")
            .navigationDestination(for: String.self) { tabId in
                if viewModel.tab(for: tabId)?.isTerminalOnly == true {
                    RemoteTerminalView(tabId: tabId)
                } else {
                    ConversationView(tabId: tabId)
                }
            }
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    Button {
                        showSettings = true
                    } label: {
                        Image(systemName: "gearshape")
                    }
                }
                ToolbarItem(placement: .topBarTrailing) {
                    Button {
                        if allDirectories.isEmpty {
                            viewModel.createTab()
                        } else {
                            showNewTab = true
                        }
                    } label: {
                        Image(systemName: "plus")
                    }
                }
            }
            .refreshable {
                viewModel.sync()
            }
            .onChange(of: viewModel.connectionState) { _, newState in
                if newState == .disconnected {
                    navigationPath = NavigationPath()
                }
            }
            .onChange(of: viewModel.pendingNavigationTabId) { _, tabId in
                if let tabId {
                    navigationPath.append(tabId)
                    viewModel.pendingNavigationTabId = nil
                }
            }
            .sheet(isPresented: $showSettings) {
                SettingsView()
            }
            .sheet(isPresented: $showNewTab) {
                NavigationStack {
                    List {
                        ForEach(allDirectories, id: \.fullPath) { dir in
                            HStack {
                                Text(dir.label)
                                    .lineLimit(1)
                                Spacer()
                                Button {
                                    showNewTab = false
                                    viewModel.createTab(workingDirectory: dir.fullPath)
                                } label: {
                                    Image(systemName: "plus")
                                }
                                .buttonStyle(.bordered)
                                .buttonBorderShape(.circle)
                                Button {
                                    showNewTab = false
                                    viewModel.createTerminalTab(workingDirectory: dir.fullPath)
                                } label: {
                                    Image(systemName: "terminal")
                                }
                                .buttonStyle(.bordered)
                                .buttonBorderShape(.circle)
                            }
                        }
                    }
                    .navigationTitle("New Tab")
                    .navigationBarTitleDisplayMode(.inline)
                    .toolbar {
                        ToolbarItem(placement: .cancellationAction) {
                            Button("Cancel") { showNewTab = false }
                        }
                    }
                }
                .presentationDetents([.medium])
            }
            .overlay {
                if viewModel.tabs.isEmpty {
                    ContentUnavailableView(
                        "No Tabs",
                        systemImage: "terminal",
                        description: Text("Tap + to create a new tab or pull to refresh.")
                    )
                }
            }
        }
    }

    /// Ordered list of directories: default base directory first, then recent directories (deduplicated).
    private var allDirectories: [(label: String, fullPath: String)] {
        var seen = Set<String>()
        var result: [(label: String, fullPath: String)] = []

        if let base = viewModel.defaultBaseDirectory, !base.isEmpty {
            seen.insert(base)
            result.append((label: directoryLabel(base), fullPath: base))
        }

        for dir in viewModel.recentDirectories where !seen.contains(dir) {
            seen.insert(dir)
            result.append((label: directoryLabel(dir), fullPath: dir))
        }

        return result
    }

    private func directoryLabel(_ path: String) -> String {
        let base = (path as NSString).lastPathComponent
        if base.isEmpty || path == "/" || path == "~" {
            return "Home"
        }
        return base
    }
}

// MARK: - TabRowView

private struct TabRowView: View {
    let tab: RemoteTabState

    @State private var pulseOpacity: Double = 1.0

    var body: some View {
        HStack(spacing: 12) {
            Circle()
                .fill(statusInfo.color)
                .frame(width: 10, height: 10)
                .opacity(statusInfo.pulse ? pulseOpacity : 1.0)
                .onChange(of: statusInfo.pulse) { _, shouldPulse in
                    if shouldPulse {
                        withAnimation(.easeInOut(duration: 1.5).repeatForever(autoreverses: true)) {
                            pulseOpacity = 0.3
                        }
                    } else {
                        withAnimation(.default) {
                            pulseOpacity = 1.0
                        }
                    }
                }
                .onAppear {
                    if statusInfo.pulse {
                        withAnimation(.easeInOut(duration: 1.5).repeatForever(autoreverses: true)) {
                            pulseOpacity = 0.3
                        }
                    }
                }

            if tab.isTerminalOnly == true {
                Image(systemName: "terminal")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }

            VStack(alignment: .leading, spacing: 2) {
                Text(tab.displayTitle)
                    .font(.headline)

                if let message = tab.lastMessage {
                    Text(message)
                        .font(.caption2)
                        .foregroundStyle(.tertiary)
                        .lineLimit(1)
                }
            }

            Spacer()
        }
        .padding(.vertical, 4)
    }

    /// Status color and pulse state matching desktop TabStrip priority order.
    private var statusInfo: (color: Color, pulse: Bool) {
        // 1. Dead/Failed -> Red (no pulse)
        if tab.status == .dead || tab.status == .failed {
            return (Color(hex: 0xC47060), false)
        }

        // 2. Check permission queue for special tool states
        let hasGenericPermission = tab.permissionQueue.contains {
            $0.toolName != "ExitPlanMode" && $0.toolName != "AskUserQuestion"
        }
        let hasPlanReady = tab.permissionQueue.contains { $0.toolName == "ExitPlanMode" }
        let hasQuestion = tab.permissionQueue.contains { $0.toolName == "AskUserQuestion" }

        // 3. Generic permission -> Orange (steady)
        if hasGenericPermission {
            return (Color(hex: 0xE8854A), false)
        }
        // 4. Running/Connecting -> Orange + pulse (before plan/question so active streaming always wins)
        if tab.status == .running || tab.status == .connecting {
            return (Color(hex: 0xE8854A), true)
        }
        // 5. Plan ready -> Green (idle or completed -- run finishes after auto-allow)
        if hasPlanReady && (tab.status == .idle || tab.status == .completed) {
            return (.green, false)
        }
        // 6. Question pending -> Blue (idle or completed)
        if hasQuestion && (tab.status == .idle || tab.status == .completed) {
            return (Color(hex: 0x4A9EF5), false)
        }
        // 7. Default -> Gray
        return (Color(hex: 0x8A8A80), false)
    }

}
