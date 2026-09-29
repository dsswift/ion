import SwiftUI
import SwiftTerm

/// UIViewRepresentable wrapper around SwiftTerm's TerminalView.
///
/// Registers with TerminalOutputRouter for high-performance data routing
/// that bypasses SwiftUI observation. Keystrokes and resize events are
/// forwarded to the SessionViewModel for relay to desktop.
struct SwiftTermWrapper: UIViewRepresentable {
    let tabId: String
    let instanceId: String
    @Environment(SessionViewModel.self) private var viewModel

    func makeCoordinator() -> Coordinator {
        Coordinator(tabId: tabId, instanceId: instanceId, viewModel: viewModel)
    }

    func makeUIView(context: Context) -> TerminalView {
        let terminal = TerminalView(frame: .zero)
        terminal.nativeBackgroundColor = .black
        terminal.nativeForegroundColor = .white
        let font = UIFont(name: "JetBrainsMonoNL NFM", size: 14)
            ?? UIFont.monospacedSystemFont(ofSize: 14, weight: .regular)
        terminal.font = font
        terminal.terminalDelegate = context.coordinator
        context.coordinator.terminalView = terminal

        let key = "\(tabId):\(instanceId)"
        let coordinator = context.coordinator
        TerminalOutputRouter.shared.register(
            key: key,
            dataHandler: { [weak terminal] data in
                DispatchQueue.main.async {
                    terminal?.feed(text: data)
                }
            },
            historyHandler: { [weak terminal, weak coordinator] data in
                DispatchQueue.main.async {
                    guard let terminal, let coordinator else { return }
                    coordinator.replyGate.replayHistory(key: key) {
                        terminal.feed(text: data)
                    }
                }
            },
            exitHandler: { _ in
                // Terminal exited -- could show an overlay or indicator
            },
            restartHandler: { [weak terminal, weak coordinator] in
                DispatchQueue.main.async {
                    guard let terminal, let coordinator else { return }
                    // RIS: a full reset, so the replaced run's screen and
                    // scrollback go with it.
                    terminal.feed(text: "\u{1b}c")
                    // The fresh shell starts at the desktop's default size.
                    let size = terminal.getTerminal()
                    coordinator.sizeChanged(source: terminal, newCols: size.cols, newRows: size.rows)
                }
            }
        )

        return terminal
    }

    func updateUIView(_ uiView: TerminalView, context: Context) {
        // Update coordinator references in case they changed
        context.coordinator.tabId = tabId
        context.coordinator.instanceId = instanceId
    }

    static func dismantleUIView(_ uiView: TerminalView, coordinator: Coordinator) {
        let key = "\(coordinator.tabId):\(coordinator.instanceId)"
        TerminalOutputRouter.shared.unregister(key: key)
    }

    // MARK: - Coordinator

    final class Coordinator: NSObject, TerminalViewDelegate {
        var tabId: String
        var instanceId: String
        weak var terminalView: TerminalView?
        let replyGate = TerminalReplyGate()
        private let viewModel: SessionViewModel

        init(tabId: String, instanceId: String, viewModel: SessionViewModel) {
            self.tabId = tabId
            self.instanceId = instanceId
            self.viewModel = viewModel
        }

        func sizeChanged(source: TerminalView, newCols: Int, newRows: Int) {
            viewModel.sendTerminalResize(tabId: tabId, instanceId: instanceId, cols: newCols, rows: newRows)
        }

        func send(source: TerminalView, data: ArraySlice<UInt8>) {
            // An answer SwiftTerm generated while parsing snapshot history
            // belongs to a program that is long gone; forwarding it would type
            // it into the live shell.
            guard replyGate.shouldForward(byteCount: data.count) else { return }
            let str = String(bytes: data, encoding: .utf8) ?? ""
            if !str.isEmpty {
                viewModel.sendTerminalInput(tabId: tabId, instanceId: instanceId, data: str)
            }
        }

        func setTerminalTitle(source: TerminalView, title: String) {
            // Could update instance label via remote command
        }

        func scrolled(source: TerminalView, position: Double) {}
        func hostCurrentDirectoryUpdate(source: TerminalView, directory: String?) {}
        func rangeChanged(source: TerminalView, startY: Int, endY: Int) {}
        func requestOpenLink(source: TerminalView, link: String, params: [String: String]) {}
        func bell(source: TerminalView) {}
        func iTermContent(source: TerminalView, content: ArraySlice<UInt8>) {}
        func clipboardCopy(source: TerminalView, content: Data) {
            if let str = String(data: content, encoding: .utf8) {
                UIPasteboard.general.string = str
            }
        }
    }
}
