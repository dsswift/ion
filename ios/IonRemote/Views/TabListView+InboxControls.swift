import SwiftUI

// MARK: - Inbox controls row
//
// The filter row at the top of the inbox: the project scope, the conversation
// sort, and the collapse-or-expand-everything control. Split from
// TabListView+Inbox.swift at the file-size cap; the members are internal
// rather than private so the list in that file can place the row.
extension TabListView {

    var inboxProjectFilterLabel: String {
        guard inboxProjectFilter != "all" else { return "All projects" }
        return InboxNavigator.projects(tabs: viewModel.tabs, states: viewModel.worktreeStates)
            .first(where: { $0.id == inboxProjectFilter })?.name ?? "Project"
    }

    /// The filter controls in the Active header: project scope, conversation
    /// sort, and collapse-or-expand-everything.
    var inboxHeaderControls: some View {
        HStack(spacing: IonSpace.contentGap) {
            inboxProjectScopeMenu
            Menu {
                ForEach(InboxNavigator.Sort.allCases) { sort in
                    Button {
                        inboxSort = sort
                        UserDefaults.standard.set(sort.rawValue, forKey: "inboxSort")
                    } label: {
                        if inboxSort == sort {
                            Label(sort.label, systemImage: "checkmark")
                        } else {
                            Text(sort.label)
                        }
                    }
                }
            } label: {
                inboxControlChip(inboxSort.label, systemImage: "arrow.up.arrow.down")
            }
            Button { toggleAllInboxGroups() } label: {
                Image(systemName: "arrow.up.and.down.text.horizontal")
                    .font(IonType.metadata)
                    .foregroundStyle(theme.textSecondary)
                    .frame(width: IonSpace.sectionGap, height: IonSpace.sectionGap)
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Collapse or expand inbox groups")
        }
        .textCase(nil)
    }

    /// Collapse or expand EVERY inbox group in one action: the projects and
    /// their bands in the Active tree, the same in the Snoozed tree, and the
    /// Settled shelf. One decision drives all three, so the control can never
    /// leave the view half open (the desktop's collapseAll/expandAll writes the
    /// active set, the snoozed set, and the settled shelf together).
    ///
    /// The Active and Snoozed headings themselves are not collapsible on either
    /// client, so they have no key here.
    ///
    /// Both trees are keyed from their OWN rendered projects. The snoozed tree
    /// is built with `.conversationsOnly`, so it contributes keys only while
    /// something is actually snoozed.
    func toggleAllInboxGroups() {
        let activeKeys = InboxNavigator.expansionKeys(for: InboxNavigator.projects(
            tabs: viewModel.tabs.filter { $0.inboxState != "snoozed" && $0.inboxState != "settled" },
            states: viewModel.worktreeStates
        ))
        let snoozedKeys = InboxNavigator.expansionKeys(for: InboxNavigator.projects(
            tabs: viewModel.tabs.filter { $0.inboxState == "snoozed" },
            states: viewModel.worktreeStates,
            buckets: .conversationsOnly
        ))
        // "Anything still shut" means expand; only a fully open view collapses.
        // The settled shelf votes too, so pressing this with just that shelf
        // closed opens it rather than reading as "already expanded".
        let hasCollapsed = settledShelfCollapsed
            || activeKeys.contains { !activeInboxExpansion.contains($0) }
            || snoozedKeys.contains { !snoozedInboxExpansion.contains($0) }
        activeInboxExpansion = hasCollapsed ? Set(activeKeys) : []
        snoozedInboxExpansion = hasCollapsed ? Set(snoozedKeys) : []
        settledShelfCollapsed = !hasCollapsed
        DiagnosticLog.log("inbox groups toggled", tag: "view.inbox", fields: [
            "expanded": String(hasCollapsed),
            "active_keys": String(activeKeys.count),
            "snoozed_keys": String(snoozedKeys.count)
        ])
    }

    /// Enriched project scope picker: "All projects" with the total, then one
    /// entry per project with its conversation count — the desktop's
    /// InboxProjectScopePicker card content in menu form. Selection persists
    /// (the desktop persists its filter too; this menu used to read the key at
    /// launch and never write it back).
    var inboxProjectScopeMenu: some View {
        // Counts come from a navigator over ALL live tabs (no scope applied):
        // active + snoozed conversations, terminals excluded — the same input
        // the desktop's projectOptions uses.
        let projects = InboxNavigator.projects(
            tabs: viewModel.tabs.filter { $0.inboxState != "settled" },
            states: viewModel.worktreeStates
        )
        let total = projects.reduce(0) { $0 + $1.conversationCount }
        return Menu {
            Button {
                setInboxProjectFilter("all")
            } label: {
                if inboxProjectFilter == "all" {
                    Label("All projects (\(total))", systemImage: "checkmark")
                } else {
                    Text("All projects (\(total))")
                }
            }
            Divider()
            ForEach(projects) { project in
                Button {
                    setInboxProjectFilter(project.id)
                } label: {
                    if inboxProjectFilter == project.id {
                        Label("\(project.name) (\(project.conversationCount))", systemImage: "checkmark")
                    } else {
                        Text("\(project.name) (\(project.conversationCount))")
                    }
                }
            }
        } label: {
            inboxControlChip(inboxProjectFilterLabel, systemImage: "folder")
        }
    }

    /// One filter control in the Active header: glyph, current value, and a
    /// chevron, with no fill of its own. The header is already a bar.
    func inboxControlChip(_ title: String, systemImage: String) -> some View {
        HStack(spacing: IonSpace.hairlineGap) {
            Image(systemName: systemImage)
            Text(title)
                .lineLimit(1)
            Image(systemName: "chevron.down")
                .font(IonType.microLabel)
        }
        .font(IonType.metadata)
        .foregroundStyle(theme.textSecondary)
    }

    func setInboxProjectFilter(_ value: String) {
        inboxProjectFilter = value
        UserDefaults.standard.set(value, forKey: "inboxProjectFilter")
        DiagnosticLog.log("project scope applied", tag: "view.inbox", fields: ["scope": value])
    }
}
