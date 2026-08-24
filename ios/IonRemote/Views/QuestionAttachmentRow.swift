import SwiftUI
import PhotosUI

/// Per-question attachment row for the Questions Wizard.
///
/// Reuses the composer's existing upload path rather than inventing one: a
/// PhotosPicker selection is compressed, sent as `desktop_upload_attachment`,
/// and the desktop writes the bytes to a real host file and returns its path
/// via `uploadAttachmentResult`. That path is what a question answer stores,
/// so an image attached from the phone reaches the model exactly like one
/// attached on the desktop.
///
/// This closes a real gap: the wire and the models carried attachments and the
/// review screen rendered them, but iOS had no way to ADD one — the desktop
/// picker was built and the iOS half was never wired, then rationalised as
/// "the paths are desktop-local". They are, but the upload is precisely the
/// mechanism that turns phone bytes into a desktop-local path.
struct QuestionAttachmentRow: View {
    @Environment(\.appTheme) private var theme
    let viewModel: SessionViewModel
    @Binding var draft: QuestionDraftAnswer

    @State private var photoItem: PhotosPickerItem?
    /// Correlation ids for uploads this row started and is still awaiting.
    @State private var awaiting: Set<String> = []

    private var attachments: [QuestionAnswerAttachment] { draft.attachments ?? [] }

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack(spacing: 8) {
                PhotosPicker(selection: $photoItem, matching: .images) {
                    Label("Attach image", systemImage: "paperclip")
                        .font(.caption2)
                }
                .buttonStyle(.bordered)
                .tint(.secondary)

                if !awaiting.isEmpty {
                    ProgressView().controlSize(.mini)
                }
            }

            if !attachments.isEmpty {
                FlowLayout(spacing: 6) {
                    ForEach(attachments, id: \.path) { att in
                        HStack(spacing: 4) {
                            Text(att.name)
                                .font(.caption2)
                                .lineLimit(1)
                            Button {
                                remove(att)
                            } label: {
                                Image(systemName: "xmark")
                                    .font(.caption2)
                            }
                            .buttonStyle(.plain)
                            .accessibilityLabel("Remove \(att.name)")
                        }
                        .padding(.horizontal, 8)
                        .padding(.vertical, 4)
                        .background(theme.surfaceSecondary, in: Capsule())
                    }
                }
            }
        }
        .onChange(of: photoItem) { _, item in
            guard let item else { return }
            upload(item)
            photoItem = nil
        }
        // Drain the shared upload stream, claiming only the correlation ids
        // this row is waiting on so several rows (and the composer) can have
        // uploads in flight at once without stealing each other's results.
        .onChange(of: viewModel.pendingUploadResults) { _, results in
            consume(results)
        }
    }

    private func upload(_ item: PhotosPickerItem) {
        let correlationId = UUID().uuidString
        let name = "photo-\(Int(Date().timeIntervalSince1970 * 1000)).jpeg"
        awaiting.insert(correlationId)

        Task {
            guard let data = try? await item.loadTransferable(type: Data.self) else {
                await MainActor.run {
                    awaiting.remove(correlationId)
                    DiagnosticLog.log("questions attachment: could not load picked image", tag: "questions", level: .warn)
                }
                return
            }
            let compressed = ImageCompression.jpeg(data: data, maxBytes: 1_000_000)
            let dataUrl = "data:image/jpeg;base64,\(compressed.base64EncodedString())"
            await MainActor.run {
                viewModel.uploadAttachment(dataUrl: dataUrl, name: name, correlationId: correlationId)
            }
        }
    }

    private func consume(_ results: [UploadAttachmentResult]) {
        guard !awaiting.isEmpty else { return }
        var claimed: Set<String> = []
        for result in results {
            guard let cid = result.correlationId, awaiting.contains(cid) else { continue }
            claimed.insert(cid)
            if let error = result.error, !error.isEmpty {
                DiagnosticLog.log("questions attachment upload failed", tag: "questions", level: .warn, fields: ["error": error])
                continue
            }
            guard !result.path.isEmpty else { continue }
            // De-duplicate by path: re-attaching the same file is a no-op.
            if attachments.contains(where: { $0.path == result.path }) { continue }
            let next = attachments + [QuestionAnswerAttachment(path: result.path, name: result.name)]
            draft = QuestionDraftAnswer(
                questionId: draft.questionId,
                selectedOptionIds: draft.selectedOptionIds,
                customText: draft.customText,
                skipped: nil,
                attachments: next
            )
        }
        guard !claimed.isEmpty else { return }
        awaiting.subtract(claimed)
        viewModel.pendingUploadResults.removeAll { r in
            guard let cid = r.correlationId else { return false }
            return claimed.contains(cid)
        }
    }

    private func remove(_ att: QuestionAnswerAttachment) {
        let next = attachments.filter { $0.path != att.path }
        draft = QuestionDraftAnswer(
            questionId: draft.questionId,
            selectedOptionIds: draft.selectedOptionIds,
            customText: draft.customText,
            skipped: draft.skipped,
            attachments: next.isEmpty ? nil : next
        )
    }
}
