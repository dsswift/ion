import SwiftUI

/// Edits one workflow's prompt. It may use only the workflow's placeholders;
/// Reset to Default drops the override.
struct AIWorkflowPromptEditor: View {
    let session: ServerAdminSession
    let model: AIWorkflowPromptsModel
    let workflow: AIWorkflow

    @State private var draft: String
    @State private var confirmingReset = false

    init(session: ServerAdminSession, model: AIWorkflowPromptsModel, workflow: AIWorkflow) {
        self.session = session
        self.model = model
        self.workflow = workflow
        _draft = State(initialValue: model.effectivePrompt(workflow))
    }

    private var canEdit: Bool { session.allows(scope: .admin) }
    private var validationError: String? { workflow.validationError(draft) }
    private var dirty: Bool { draft != model.effectivePrompt(workflow) }

    var body: some View {
        List {
            Section {
                TextEditor(text: $draft)
                    .font(.callout.monospaced())
                    .frame(minHeight: 320)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                    .disabled(!canEdit)
            } header: {
                Text(model.isCustomized(workflow.id) ? "Customized" : "Default")
            } footer: {
                VStack(alignment: .leading, spacing: IonSpace.hairlineGap) {
                    if let validationError {
                        Text(validationError).foregroundStyle(.red)
                    } else {
                        Text(placeholderLine)
                    }
                    if let reason = session.denialReason(scope: .admin) { Text(reason) }
                }
            }
            if let error = model.error {
                Section { AdminErrorRow(message: error) }
            }
            Section {
                Button("Reset to Default", role: .destructive) { confirmingReset = true }
                    .disabled(!canEdit || model.busy || (!model.isCustomized(workflow.id) && draft == workflow.defaultTemplate))
            }
        }
        .navigationTitle(workflow.label)
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .confirmationAction) {
                Button("Save") {
                    Task { await model.save(workflow, prompt: draft) }
                }
                .disabled(!canEdit || model.busy || !dirty || validationError != nil
                          || draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
            }
        }
        .confirmationDialog("Reset the \(workflow.label) prompt?", isPresented: $confirmingReset, titleVisibility: .visible) {
            Button("Reset to Default", role: .destructive) {
                Task {
                    if await model.reset(workflow) { draft = workflow.defaultTemplate }
                }
            }
        } message: {
            Text("\(session.serverLabel) goes back to the built-in prompt.")
        }
    }

    private var placeholderLine: String {
        workflow.placeholders.isEmpty
            ? "This prompt takes no placeholders."
            : "Placeholders: " + workflow.placeholders.map { "{{\($0)}}" }.joined(separator: ", ")
    }
}
