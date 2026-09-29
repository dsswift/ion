import SwiftUI

/// The last lines of one of a server's logs, monospaced, newest at the
/// bottom, with share and reload.
struct ServerLogTailView: View {
    @State private var model: LogTailModel

    init(client: ServerAdminClient, file: EnvironmentLogTail.File) {
        _model = State(initialValue: LogTailModel(client: client, file: file))
    }

    var body: some View {
        content
            .navigationTitle(model.file.fileName)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItemGroup(placement: .topBarTrailing) {
                    if model.tail != nil {
                        ShareLink(item: model.text, subject: Text(model.file.fileName)) {
                            Image(systemName: "square.and.arrow.up")
                        }
                        .accessibilityLabel("Share")
                    }
                    Button {
                        Task { await model.load() }
                    } label: {
                        Image(systemName: "arrow.clockwise")
                    }
                    .accessibilityLabel("Reload")
                    .disabled(model.loading)
                }
            }
            .task { await model.load() }
    }

    @ViewBuilder
    private var content: some View {
        if let tail = model.tail {
            if tail.lines.isEmpty {
                ContentUnavailableView("Empty log", systemImage: "doc.text", description: Text("\(tail.path) has no lines."))
            } else {
                ScrollViewReader { proxy in
                    ScrollView([.vertical]) {
                        LazyVStack(alignment: .leading, spacing: 2) {
                            ForEach(Array(tail.lines.enumerated()), id: \.offset) { _, line in
                                Text(line)
                                    .font(.caption2.monospaced())
                                    .foregroundStyle(.secondary)
                                    .frame(maxWidth: .infinity, alignment: .leading)
                                    .textSelection(.enabled)
                            }
                            Color.clear.frame(height: 1).id(Self.bottom)
                        }
                        .padding(IonSpace.contentGap)
                    }
                    .refreshable { await model.load() }
                    .onAppear { proxy.scrollTo(Self.bottom, anchor: .bottom) }
                    .onChange(of: tail) { proxy.scrollTo(Self.bottom, anchor: .bottom) }
                }
            }
        } else if let error = model.error {
            ContentUnavailableView {
                Label("Could not read the log", systemImage: "exclamationmark.triangle")
            } description: {
                Text(error)
            } actions: {
                Button("Try again") { Task { await model.load() } }
            }
        } else {
            ProgressView("Reading the last \(LogTailModel.lineCount) lines…")
        }
    }

    private static let bottom = "log-bottom"
}
