import SwiftUI
import UIKit

/// A block of message text that holds links, drawn by UIKit so each link has
/// its own long-press menu.
///
/// SwiftUI's `Text` gives a long press on a link only the text selection menu.
/// `UITextView` asks its delegate for a menu per link, so a file path offers
/// Preview, Download, and Copy Path, and a web address keeps the system's own
/// link menu. A tap on a file link runs `FileLinkActions.open`.
struct LinkableText: UIViewRepresentable {
    let text: AttributedString
    var style = LinkableTextRenderer.Style()
    /// Used for a tap when no conversation supplies `fileLinkActions`.
    var onOpenFile: ((String) -> Void)?

    @Environment(\.appTheme) private var theme
    @Environment(\.fileLinkActions) private var actions
    // Read so a Dynamic Type change re-renders with the new base font.
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize

    func makeCoordinator() -> Coordinator { Coordinator() }

    func makeUIView(context: Context) -> UITextView {
        let view = UITextView()
        view.isEditable = false
        view.isSelectable = true
        view.isScrollEnabled = false
        view.backgroundColor = .clear
        view.textContainerInset = .zero
        view.textContainer.lineFragmentPadding = 0
        view.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        view.delegate = context.coordinator
        return view
    }

    func updateUIView(_ view: UITextView, context: Context) {
        context.coordinator.actions = actions
        context.coordinator.onOpenFile = onOpenFile
        let rendered = LinkableTextRenderer.render(text, style: style)
        if view.attributedText != rendered { view.attributedText = rendered }
        view.linkTextAttributes = [.foregroundColor: UIColor(theme.accent)]
    }

    func sizeThatFits(_ proposal: ProposedViewSize, uiView: UITextView, context: Context) -> CGSize? {
        let target = proposal.width ?? .greatestFiniteMagnitude
        let fit = uiView.sizeThatFits(CGSize(width: target, height: .greatestFiniteMagnitude))
        return CGSize(width: min(ceil(fit.width), target), height: ceil(fit.height))
    }

    final class Coordinator: NSObject, UITextViewDelegate {
        var actions: FileLinkActions?
        var onOpenFile: ((String) -> Void)?

        func textView(_ textView: UITextView, primaryActionFor textItem: UITextItem, defaultAction: UIAction) -> UIAction? {
            guard case .link(let url) = textItem.content, let path = FilePathDetector.path(from: url) else { return defaultAction }
            return UIAction { [weak self] _ in self?.open(path) }
        }

        func textView(_ textView: UITextView, menuConfigurationFor textItem: UITextItem, defaultMenu: UIMenu) -> UITextItem.MenuConfiguration? {
            guard case .link(let url) = textItem.content, let path = FilePathDetector.path(from: url) else {
                return UITextItem.MenuConfiguration(menu: defaultMenu)
            }
            DiagnosticLog.log("file link menu opened", tag: "file-link", fields: ["path": path, "in_conversation": String(actions != nil)])
            return UITextItem.MenuConfiguration(menu: menu(for: path))
        }

        private func open(_ path: String) {
            if let actions {
                actions.open(path)
            } else if let onOpenFile {
                onOpenFile(path)
            } else {
                DiagnosticLog.log("file link tapped with no handler", tag: "file-link", fields: ["path": path])
            }
        }

        private func menu(for path: String) -> UIMenu {
            var items: [UIMenuElement] = []
            if let actions {
                if FileLinkKind.of(path).canPreview {
                    items.append(UIAction(title: "Preview", image: UIImage(systemName: "eye")) { _ in actions.preview(path) })
                }
                items.append(UIAction(title: "Download", image: UIImage(systemName: "arrow.down.circle")) { _ in actions.download(path) })
            }
            items.append(UIAction(title: "Copy Path", image: UIImage(systemName: "doc.on.doc")) { _ in
                UIPasteboard.general.string = path
            })
            return UIMenu(title: (path as NSString).lastPathComponent, children: items)
        }
    }
}
