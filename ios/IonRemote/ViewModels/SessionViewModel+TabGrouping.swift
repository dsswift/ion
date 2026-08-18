import Foundation

// MARK: - Tab Grouping
//
// Tab-list grouping (by working directory, or by the desktop's manual groups)
// extracted from SessionViewModel.swift to keep it under the Swift 600-line cap
// (see ios/AGENTS.md -> file-architecture rules; SessionViewModel.swift is
// allowlisted as do-not-extend). Moved verbatim: these are pure computed
// projections over `tabs` / `tabGroups` with no stored state of their own,
// which makes them the natural seam to lift out.

extension SessionViewModel {

    /// Tabs grouped by working directory basename, preserving original order within each group.
    /// Duplicate basenames are disambiguated with the parent directory name.
    var tabsByDirectory: [(directory: String, fullPath: String, tabs: [RemoteTabState])] {
        var order: [String] = []
        var groups: [String: [RemoteTabState]] = [:]
        for tab in tabs {
            let key = tab.workingDirectory
            if groups[key] == nil {
                order.append(key)
            }
            groups[key, default: []].append(tab)
        }

        var basenameCounts: [String: Int] = [:]
        for path in order {
            let base = (path as NSString).lastPathComponent
            basenameCounts[base, default: 0] += 1
        }

        return order.map { fullPath in
            let base = (fullPath as NSString).lastPathComponent
            let label: String
            if base.isEmpty || fullPath == "/" || fullPath == "~" {
                label = "Home"
            } else if basenameCounts[base, default: 0] > 1 {
                let parent = ((fullPath as NSString).deletingLastPathComponent as NSString).lastPathComponent
                label = "\(base) (\(parent))"
            } else {
                label = base
            }
            return (directory: label, fullPath: fullPath, tabs: groups[fullPath]!)
        }
    }

    /// Groups for display: manual groups when desktop is in manual mode,
    /// otherwise auto-grouped by working directory.
    /// Each tuple: (label, identifier for ForEach, icon name, directory for new-tab, tabs).
    var displayGroups: [(label: String, id: String, icon: String, directory: String?, tabs: [RemoteTabState])] {
        if tabGroupMode == "manual", !tabGroups.isEmpty {
            return tabsByManualGroup
        }
        return tabsByDirectory.map { group in
            (label: group.directory, id: group.fullPath, icon: "folder", directory: group.fullPath, tabs: group.tabs)
        }
    }

    /// Tabs grouped by manual group definitions from the desktop.
    var tabsByManualGroup: [(label: String, id: String, icon: String, directory: String?, tabs: [RemoteTabState])] {
        let sorted = tabGroups.sorted { $0.order < $1.order }
        let defaultGroup = sorted.first(where: \.isDefault) ?? sorted.first
        var groupMap: [String: [RemoteTabState]] = [:]
        for g in sorted { groupMap[g.id] = [] }
        for tab in tabs {
            if let gid = tab.groupId, groupMap[gid] != nil {
                groupMap[gid]!.append(tab)
            } else if let dg = defaultGroup {
                groupMap[dg.id, default: []].append(tab)
            }
        }
        return sorted.compactMap { g in
            let gTabs = groupMap[g.id] ?? []
            guard !gTabs.isEmpty else { return nil }
            let dir = gTabs.first?.workingDirectory
            return (label: g.label, id: g.id, icon: "tray.2.fill", directory: dir, tabs: gTabs)
        }
    }
}
