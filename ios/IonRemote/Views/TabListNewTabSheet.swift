import SwiftUI

// MARK: - "New Tab" bottom sheet
//
// Extracted from TabListView.swift to keep that file under the 600-line
// Swift cap (CLAUDE.md → "When a file exceeds the cap"). The sheet shows a
// list of recent / default-base directories and offers three creation
// modes per row (conversation tab, terminal tab, engine tab).
//
// `pendingPinToGroupId` is the wiring for the per-group "+" button feature:
// when the sheet is presented from a group header's `+` (instead of the
// global toolbar `+`), the caller sets this to the target group's id; we
// forward it as `pinToGroupId` on the createTab command so the desktop
// places the new tab inside that group with groupPinned=true from the
// start, suppressing the first-prompt auto-movement that would otherwise
// yank the tab away from the user's explicit group choice. The engine and
// terminal creation paths do NOT carry pinToGroupId — they have their own
// commands (createEngineTab, createTerminalTab) which would need their
// own additive extensions; the issue we're solving here is specifically
// for conversation tabs, which is the primary use of the per-group `+`.
struct TabListNewTabSheet: View {
    let directories: [(label: String, fullPath: String)]
    let pendingPinToGroupId: String?
    @Binding var isPresented: Bool
    let onCreateConversationTab: (_ dir: String, _ pinToGroupId: String?) -> Void
    let onCreateTerminalTab: (_ dir: String) -> Void
    let onCreateEngineTab: (_ dir: String) -> Void

    var body: some View {
        NavigationStack {
            List {
                ForEach(directories, id: \.fullPath) { dir in
                    HStack {
                        Text(dir.label)
                            .lineLimit(1)
                        Spacer()
                        Button {
                            isPresented = false
                            onCreateConversationTab(dir.fullPath, pendingPinToGroupId)
                        } label: {
                            Image(systemName: "plus")
                        }
                        .buttonStyle(.bordered)
                        .buttonBorderShape(.circle)
                        Button {
                            isPresented = false
                            onCreateTerminalTab(dir.fullPath)
                        } label: {
                            Image(systemName: "terminal")
                        }
                        .buttonStyle(.bordered)
                        .buttonBorderShape(.circle)
                        Button {
                            isPresented = false
                            onCreateEngineTab(dir.fullPath)
                        } label: {
                            Image(systemName: "bolt")
                        }
                        .buttonStyle(.bordered)
                        .buttonBorderShape(.circle)
                        .tint(.orange)
                    }
                }
            }
            .navigationTitle(pendingPinToGroupId == nil ? "New Tab" : "New Tab in Group")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { isPresented = false }
                }
            }
        }
        .presentationDetents([.medium])
    }
}
