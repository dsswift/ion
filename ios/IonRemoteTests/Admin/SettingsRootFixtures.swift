@testable import IonRemote

/// A connected server's settings snapshot for the Settings root tests: one
/// Device, one Personal, and one Environment setting, and the pages they sit on.
enum SettingsRootFixtures {

    static func entry(_ key: String, label: String, description: String = "", scope: String, page: String, section: String, type: ServerSettingType = .boolean) -> ServerSettingSchemaEntry {
        ServerSettingSchemaEntry(
            key: key, type: type, group: "general", label: label, description: description,
            defaultValue: AnyCodable(false), choices: nil, range: nil, itemSchema: nil, itemType: nil,
            scope: scope, sealed: nil, page: page, section: section
        )
    }

    static let pages: [ServerSettingsPage] = [
        ServerSettingsPage(id: "behavior", label: "Behavior", scope: .device, sections: [
            .init(id: "device-behavior", label: "Conversations and alerts"),
            .init(id: "device-git", label: "Git panel"),
        ]),
        ServerSettingsPage(id: "defaults", label: "Defaults", scope: .you, sections: [
            .init(id: "defaults-conversation", label: "New conversations"),
            .init(id: "defaults-thinking", label: "Extended thinking"),
        ]),
        ServerSettingsPage(id: "notifications", label: "Notifications", scope: .you, sections: [
            .init(id: "notifications", label: "Notification tray"),
        ]),
        ServerSettingsPage(id: "workflow", label: "Workflow", scope: .server, sections: [
            .init(id: "git", label: "Git operations"),
            .init(id: "tabs", label: "Inbox"),
        ]),
    ]

    static func state(settings: [String: AnyCodable] = [:]) -> ServerSettingsState {
        ServerSettingsState(
            settings: settings,
            schema: [
                entry("gitChangesTreeView", label: "Show changes as a tree", scope: "device", page: "behavior", section: "device-git"),
                entry("showTodoList", label: "Show the todo list", scope: "device", page: "behavior", section: "device-behavior"),
                entry("defaultThinkingEffort", label: "Thinking effort", scope: "personal", page: "defaults", section: "defaults-thinking", type: .enumType),
                entry("aiGeneratedTitles", label: "AI-generated titles", description: "Name new conversations from their first prompt.", scope: "personal", page: "defaults", section: "defaults-conversation"),
                entry("excludedResourceKinds", label: "Hidden kinds", scope: "personal", page: "notifications", section: "notifications", type: .list),
                entry("inboxAutoSettleDays", label: "Settle idle conversations after", description: "Days before an idle conversation settles.", scope: "environment", page: "workflow", section: "tabs", type: .number),
                entry("uiZoom", label: "Zoom", scope: "device", page: "appearance", section: "appearance", type: .number),
            ],
            groups: [ServerSettingGroupDescriptor(groupId: "general", label: "General")],
            pages: pages
        )
    }
}
