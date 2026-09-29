import SwiftUI

/// The dedicated admin content of a settings section, keyed by its taxonomy
/// section id. A section with only projected settings has none.
struct ServerSectionContent: View {
    let session: ServerAdminSession
    let sectionId: String

    var body: some View {
        switch sectionId {
        case "overview": ServerOverviewSection(session: session)
        case "projects": ProjectsAdminSection(session: session)
        case "git-access": GitAccessAdminSection(session: session)
        case "providers": ProvidersAdminSection(session: session)
        case "ai": DefaultModelsAdminSection(session: session)
        case "model-tiers": ModelTiersAdminSection(session: session)
        case "engine-profiles": EngineProfilesAdminSection(session: session)
        case "ai-assist": AIWorkflowPromptsAdminSection(session: session)
        case "mcp": McpAdminSection(session: session)
        case "automation": AutomationsAdminSection(session: session)
        case "entra": EntraAdminSection(session: session)
        case "git": GitWorkflowAdminSection(session: session)
        case "devices": DevicesAdminSection(session: session)
        case "discovery": DiscoveryAdminSection(session: session)
        case "remote": PhoneRelayAdminSection(session: session)
        case "health": HealthAdminSection(session: session)
        default: EmptyView()
        }
    }
}
