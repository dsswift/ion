import SwiftUI

struct TabListView: View {
    @Environment(SessionViewModel.self) private var viewModel
    @State private var showSettings = false
    @State private var showNewTab = false
    @State private var showPairingSheet = false
    @State private var navigationPath = NavigationPath()
    @State private var enginePickerDirectory: String? = nil
    @State private var renamingTabId: String?
    @State private var renameText: String = ""

    var body: some View {
        NavigationStack(path: $navigationPath) {
            List {
                ForEach(viewModel.displayGroups, id: \.id) { group in
                    Section {
                        ForEach(group.tabs) { tab in
                            NavigationLink(value: tab.id) {
                                TabRowView(tab: tab, showDirectory: viewModel.tabGroupMode == "manual")
                            }
                            .swipeActions(edge: .leading, allowsFullSwipe: false) {
                                Button {
                                    renameText = tab.displayTitle
                                    renamingTabId = tab.id
                                } label: {
                                    Label("Rename", systemImage: "pencil")
                                }
                                .tint(.orange)
                            }
                            .contextMenu {
                                Button {
                                    renameText = tab.displayTitle
                                    renamingTabId = tab.id
                                } label: {
                                    Label("Rename", systemImage: "pencil")
                                }
                                if viewModel.tabGroupMode == "manual" {
                                    let targets = viewModel.tabGroups.filter { $0.id != tab.groupId }
                                    if !targets.isEmpty {
                                        Menu {
                                            ForEach(targets) { target in
                                                Button(target.label) {
                                                    viewModel.moveTabToGroup(tabId: tab.id, groupId: target.id)
                                                }
                                            }
                                        } label: {
                                            Label("Move to Group", systemImage: "arrow.right.arrow.left")
                                        }
                                    }
                                }
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
                            Label(group.label, systemImage: group.icon)
                                .font(.subheadline.weight(.semibold))
                                .foregroundStyle(.secondary)
                            Spacer()
                            if let dir = group.directory {

                                Button {
                                    viewModel.createTab(workingDirectory: dir)
                                } label: {
                                    Image(systemName: "plus")
                                        .font(.subheadline)
                                        .foregroundStyle(.secondary)
                                }
                                .contextMenu {
                                    Button {
                                        viewModel.createTab(workingDirectory: dir)
                                    } label: {
                                        Label("New Tab", systemImage: "plus")
                                    }
                                    Button {
                                        viewModel.createTerminalTab(workingDirectory: dir)
                                    } label: {
                                        Label("New Terminal", systemImage: "terminal")
                                    }
                                    Button {
                                        requestEngineTab(directory: dir)
                                    } label: {
                                        Label("New Engine", systemImage: "bolt.fill")
                                    }
                                }
                            }
                        }
                        .padding(.top, 4)
                    }
                }
            }
            .navigationTitle("")
            .toolbar {
                ToolbarItem(placement: .principal) {
                    DesktopPickerMenu(showPairingSheet: $showPairingSheet)
                }
            }
            .alert("Rename Tab", isPresented: .init(
                get: { renamingTabId != nil },
                set: { if !$0 { renamingTabId = nil } }
            )) {
                TextField("Name", text: $renameText)
                Button("Rename") {
                    if let id = renamingTabId {
                        let title = renameText.trimmingCharacters(in: .whitespacesAndNewlines)
                        viewModel.renameTab(tabId: id, customTitle: title.isEmpty ? nil : title)
                    }
                    renamingTabId = nil
                }
                Button("Cancel", role: .cancel) {
                    renamingTabId = nil
                }
            } message: {
                Text("Enter a new name for this tab.")
            }
            .navigationDestination(for: String.self) { tabId in
                if viewModel.tab(for: tabId)?.isEngine == true {
                    EngineView(tabId: tabId)
                } else if viewModel.tab(for: tabId)?.isTerminalOnly == true {
                    RemoteTerminalView(tabId: tabId)
                } else {
                    ConversationView(tabId: tabId)
                }
            }
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    HStack(spacing: 12) {
                        Button {
                            showSettings = true
                        } label: {
                            Image(systemName: "gearshape")
                        }
                        ConnectionQualityView(compact: true)
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
                    .contextMenu {
                        if let defaultDir = allDirectories.first {
                            Button { viewModel.createTab(workingDirectory: defaultDir.fullPath) } label: {
                                Label("New Tab", systemImage: "plus")
                            }
                            Button { viewModel.createTerminalTab(workingDirectory: defaultDir.fullPath) } label: {
                                Label("New Terminal", systemImage: "terminal")
                            }
                            Button { requestEngineTab(directory: defaultDir.fullPath) } label: {
                                Label("New Engine", systemImage: "bolt.fill")
                            }
                        }
                    }
                }
            }
            .refreshable {
                Haptic.light()
                viewModel.sync()
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
            .sheet(isPresented: $showPairingSheet) {
                PairingView()
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
                                Button {
                                    showNewTab = false
                                    requestEngineTab(directory: dir.fullPath)
                                } label: {
                                    Image(systemName: "bolt")
                                }
                                .buttonStyle(.bordered)
                                .buttonBorderShape(.circle)
                                .tint(.orange)
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
            .confirmationDialog(
                "Select Engine Profile",
                isPresented: Binding(
                    get: { enginePickerDirectory != nil },
                    set: { if !$0 { enginePickerDirectory = nil } }
                ),
                titleVisibility: .visible
            ) {
                ForEach(viewModel.engineProfiles) { profile in
                    Button(profile.name) {
                        let dir = enginePickerDirectory
                        enginePickerDirectory = nil
                        viewModel.createEngineTab(workingDirectory: dir, profileId: profile.id)
                    }
                }
                Button("Cancel", role: .cancel) {
                    enginePickerDirectory = nil
                }
            }
            .overlay {
                if viewModel.tabs.isEmpty {
                    VStack(spacing: 12) {
                        Image(systemName: "terminal")
                            .font(.system(size: 40))
                            .foregroundStyle(IonTheme.accent)
                        Text("No Tabs")
                            .font(.title3.weight(.semibold))
                        Text("Tap + to create a new tab or pull to refresh.")
                            .font(.subheadline)
                            .foregroundStyle(.secondary)
                            .multilineTextAlignment(.center)
                    }
                    .padding()
                }
            }
        }
    }

    // MARK: - Reconnecting Indicator


    /// Handle engine tab creation with profile selection.
    /// - 0 profiles: auto-create without a profileId (engine uses default)
    /// - 1 profile: auto-select the only profile
    /// - 2+ profiles: show a confirmation dialog picker
    private func requestEngineTab(directory: String) {
        let profiles = viewModel.engineProfiles
        switch profiles.count {
        case 0:
            viewModel.createEngineTab(workingDirectory: directory)
        case 1:
            viewModel.createEngineTab(workingDirectory: directory, profileId: profiles[0].id)
        default:
            enginePickerDirectory = directory
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
    var showDirectory: Bool = false

    @State private var pulseOpacity: Double = 1.0

    var body: some View {
        HStack(spacing: 12) {
            Circle()
                .fill(statusInfo.color)
                .frame(width: 8, height: 8)
                .opacity(statusInfo.pulse ? pulseOpacity : 1.0)
                .shadow(color: statusInfo.pulse ? statusInfo.color.opacity(0.6) : .clear, radius: 3)
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

            if tab.isEngine == true {
                Image(systemName: "bolt.fill")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            } else if tab.isTerminalOnly == true {
                Image(systemName: "terminal")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }

            VStack(alignment: .leading, spacing: 2) {
                Text(tab.displayTitle)
                    .font(.headline)

                if showDirectory {
                    Text(directoryLabel)
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                }

                if tab.status == .running || tab.status == .connecting {
                    Text("Running…")
                        .font(.caption2)
                        .foregroundStyle(IonTheme.statusRunning)
                        .lineLimit(1)
                }

                if let message = tab.lastMessage {
                    Text(message)
                        .font(.caption2)
                        .foregroundStyle(.tertiary)
                        .lineLimit(1)
                }
            }

            Spacer()

            if !tab.permissionQueue.isEmpty && tab.status != .running {
                Circle()
                    .fill(Color.orange)
                    .frame(width: 6, height: 6)
            }
        }
        .padding(.vertical, 4)
    }

    private var directoryLabel: String {
        let path = tab.workingDirectory
        let base = (path as NSString).lastPathComponent
        if base.isEmpty || path == "/" || path == "~" { return "Home" }
        return base
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
