import SwiftUI

/// The Remove confirmation: the same choices the desktop offers, decided by
/// the server's appraisal. `onRemoved` runs after a removal lands.
struct ProjectRemovalDialog: ViewModifier {
    @Binding var request: ProjectRemovalRequest?
    let model: ProjectsAdminModel
    var onRemoved: () -> Void = {}

    func body(content: Content) -> some View {
        content.confirmationDialog(
            request.map { "Remove \($0.project.displayName)?" } ?? "",
            isPresented: Binding(get: { request != nil }, set: { if !$0 { request = nil } }),
            titleVisibility: .visible,
            presenting: request
        ) { pending in
            Button("Remove from List", role: .destructive) { remove(pending, deleteFiles: false) }
            if pending.appraisal.clonedByIon {
                Button(pending.deleteLabel, role: .destructive) { remove(pending, deleteFiles: true) }
            }
            Button("Keep", role: .cancel) {}
        } message: { pending in
            Text(pending.message)
        }
    }

    private func remove(_ pending: ProjectRemovalRequest, deleteFiles: Bool) {
        Task {
            if await model.remove(pending.project, appraisal: pending.appraisal, deleteFiles: deleteFiles) { onRemoved() }
        }
    }
}
