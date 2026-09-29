import SwiftUI

/// The editor in a sheet, for a new automation, a template, or a fresh copy.
struct AutomationEditorSheet: View {
    let session: ServerAdminSession
    let model: AutomationsAdminModel
    let item: AutomationDraftItem

    var body: some View {
        NavigationStack {
            AutomationEditorView(session: session, model: model, definition: item.definition, isNew: item.isNew, inSheet: true)
        }
    }
}
