import SwiftUI

struct SettingsInterfaceView: View {
    @Environment(SessionViewModel.self) private var viewModel
    @Environment(\.appTheme) private var theme

    var body: some View {
        List {
            Section("New Tab") {
                Picker("Default Directory", selection: Binding<String?>(
                    get: { viewModel.defaultBaseDirectory },
                    set: { viewModel.defaultBaseDirectory = $0 }
                )) {
                    Text("None (desktop default)").tag(nil as String?)
                    ForEach(viewModel.recentDirectories, id: \.self) { dir in
                        Text((dir as NSString).lastPathComponent).tag(dir as String?)
                    }
                }
            }

            Section {
                Toggle(isOn: Binding(
                    get: { viewModel.showGitInfoInTabList },
                    set: { viewModel.showGitInfoInTabList = $0 }
                )) {
                    Label("Show Git Info", systemImage: "arrow.triangle.branch")
                }
                Toggle(isOn: Binding(
                    get: { viewModel.showTabColorInTabList },
                    set: { viewModel.showTabColorInTabList = $0 }
                )) {
                    Label("Show Tab Colors", systemImage: "paintpalette")
                }
            } header: {
                Text("Tab List")
            } footer: {
                Text("Git Info shows the current branch and commit counts. Tab Colors tints rows with the color set on desktop (desktop always shows color).")
            }

            Section {
                Toggle(isOn: Binding(
                    get: { viewModel.agentPanelFullScreenPopup },
                    set: { viewModel.agentPanelFullScreenPopup = $0 }
                )) {
                    Label("Full-Screen Agent Detail", systemImage: "rectangle.expand.vertical")
                }
            } header: {
                Text("Agent Panel")
            } footer: {
                Text("When enabled, tapping an agent opens a full-screen detail view instead of expanding inline.")
            }

            Section {
                Picker("Grouping", selection: Binding<String>(
                    get: { viewModel.tabGroupMode == "manual" ? "manual" : "auto" },
                    set: { newValue in viewModel.setTabGroupMode(newValue) }
                )) {
                    Text("Auto (by directory)").tag("auto")
                    Text("Manual (custom groups)").tag("manual")
                }

                if viewModel.tabGroupMode == "manual" {
                    let sorted = viewModel.tabGroups.sorted { $0.order < $1.order }
                    ForEach(sorted) { group in
                        HStack {
                            Text(group.label)
                            Spacer()
                            if group.isDefault {
                                Image(systemName: "star.fill")
                                    .font(.caption)
                                    .foregroundStyle(.yellow)
                            }
                        }
                    }
                    .onMove { source, destination in
                        var reordered = sorted
                        reordered.move(fromOffsets: source, toOffset: destination)
                        let orderedIds = reordered.map(\.id)
                        viewModel.reorderTabGroups(orderedIds: orderedIds)
                    }
                }
            } header: {
                Text("Tab Groups")
            } footer: {
                if viewModel.tabGroupMode == "manual" {
                    Text("Drag to reorder groups. Create or delete groups from the desktop settings.")
                }
            }
        }
        .navigationTitle("Interface")
        .navigationBarTitleDisplayMode(.inline)
    }
}
