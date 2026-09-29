import SwiftUI

/// The prompt each AI-assisted workflow sends on a server: one row per
/// workflow saying whether it runs the built-in prompt or a custom one.
struct AIWorkflowPromptsAdminSection: View {
    let session: ServerAdminSession

    @State private var model: AIWorkflowPromptsModel

    init(session: ServerAdminSession) {
        self.session = session
        _model = State(initialValue: AIWorkflowPromptsModel(client: session.client, serverId: session.serverId))
    }

    var body: some View {
        Group {
            if let workflows = model.workflows {
                ForEach(workflows) { workflow in
                    NavigationLink {
                        AIWorkflowPromptEditor(session: session, model: model, workflow: workflow)
                    } label: {
                        VStack(alignment: .leading, spacing: 2) {
                            LabeledContent(workflow.label, value: model.isCustomized(workflow.id) ? "Customized" : "Default")
                            Text(workflow.description)
                                .font(.caption)
                                .foregroundStyle(.secondary)
                        }
                    }
                }
            } else if let error = model.error {
                AdminErrorRow(message: error)
            } else {
                AdminLoadingRow(text: "Loading workflow prompts…")
            }
        }
        .task { await model.load() }
        .reloadsWithServerPage("ai-assist") { [model] in await model.load() }
    }
}
