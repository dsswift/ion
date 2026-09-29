import SwiftUI
import UniformTypeIdentifiers

/// The system "Save to Files" sheet for one local file.
struct DocumentExporter: UIViewControllerRepresentable {
    let url: URL

    func makeCoordinator() -> Coordinator { Coordinator() }

    func makeUIViewController(context: Context) -> UIDocumentPickerViewController {
        let picker = UIDocumentPickerViewController(forExporting: [url], asCopy: true)
        picker.delegate = context.coordinator
        return picker
    }

    func updateUIViewController(_ controller: UIDocumentPickerViewController, context: Context) {}

    final class Coordinator: NSObject, UIDocumentPickerDelegate {
        func documentPicker(_ controller: UIDocumentPickerViewController, didPickDocumentsAt urls: [URL]) {
            DiagnosticLog.log("file link: saved to files", tag: "file-link", fields: ["count": String(urls.count)])
        }

        func documentPickerWasCancelled(_ controller: UIDocumentPickerViewController) {
            DiagnosticLog.log("file link: save to files cancelled", tag: "file-link")
        }
    }
}
