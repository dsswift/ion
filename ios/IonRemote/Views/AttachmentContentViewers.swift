import SwiftUI

// MARK: - IdentifiablePath

/// Wrapper to make a file path usable with `.fullScreenCover(item:)`.
struct IdentifiablePath: Identifiable {
    let path: String
    var id: String { path }
}

// MARK: - Plan Content View

/// Full-screen viewer for a plan attachment.
/// Loads content via `requestFsReadFile` and delegates rendering to `PlanFullScreenView`.
struct PlanContentView: View {
    @Environment(SessionViewModel.self) private var viewModel
    @Environment(\.dismiss) private var dismiss
    let path: String

    private var isLoading: Bool {
        viewModel.fileContentLoading.contains(path)
    }

    private var fileResponse: FsFileContentResponse? {
        viewModel.fileContent[path]
    }

    var body: some View {
        Group {
            if let response = fileResponse {
                if let error = response.error {
                    errorView(error)
                } else if let content = response.content {
                    PlanFullScreenView(content: content)
                } else {
                    errorView("No content available")
                }
            } else if isLoading {
                loadingView
            } else {
                loadingView
                    .task {
                        viewModel.requestFsReadFile(filePath: path)
                    }
            }
        }
    }

    private var loadingView: some View {
        NavigationStack {
            ProgressView("Loading plan…")
                .frame(maxWidth: .infinity, maxHeight: .infinity)
                .navigationTitle("Plan")
                .navigationBarTitleDisplayMode(.inline)
                .toolbar {
                    ToolbarItem(placement: .topBarTrailing) {
                        Button("Done") { dismiss() }
                            .fontWeight(.semibold)
                    }
                }
        }
    }

    private func errorView(_ message: String) -> some View {
        NavigationStack {
            VStack(spacing: 12) {
                Image(systemName: "exclamationmark.triangle")
                    .font(.largeTitle)
                    .foregroundStyle(.secondary)
                Text(message)
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
                    .multilineTextAlignment(.center)
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .padding()
            .navigationTitle("Plan")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button("Done") { dismiss() }
                        .fontWeight(.semibold)
                }
            }
        }
    }
}

// MARK: - File Content View

/// Full-screen viewer for a file attachment.
/// Displays the raw content with line numbers in a monospaced font.
struct FileContentView: View {
    @Environment(SessionViewModel.self) private var viewModel
    @Environment(\.appTheme) private var theme
    @Environment(\.dismiss) private var dismiss
    let path: String

    private var fileName: String {
        (path as NSString).lastPathComponent
    }

    private var isLoading: Bool {
        viewModel.fileContentLoading.contains(path)
    }

    private var fileResponse: FsFileContentResponse? {
        viewModel.fileContent[path]
    }

    private var isMarkdown: Bool {
        let ext = (fileName as NSString).pathExtension.lowercased()
        return ext == "md" || ext == "markdown" || ext == "mdx"
    }

    private var isImage: Bool {
        let ext = (fileName as NSString).pathExtension.lowercased()
        return ["png", "jpg", "jpeg", "gif", "svg", "webp", "ico"].contains(ext)
    }

    var body: some View {
        NavigationStack {
            Group {
                if let response = fileResponse {
                    if let error = response.error {
                        errorView(error)
                    } else if let content = response.content {
                        contentView(content)
                    } else {
                        errorView("No content available")
                    }
                } else if isLoading {
                    ProgressView("Loading file…")
                        .frame(maxWidth: .infinity, maxHeight: .infinity)
                } else {
                    ProgressView("Loading file…")
                        .frame(maxWidth: .infinity, maxHeight: .infinity)
                        .task {
                            viewModel.requestFsReadFile(filePath: path)
                        }
                }
            }
            .navigationTitle(fileName)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button("Done") { dismiss() }
                        .fontWeight(.semibold)
                }
            }
        }
    }

    // MARK: - Content

    @ViewBuilder
    private func contentView(_ content: String) -> some View {
        if isMarkdown {
            ScrollView {
                MarkdownContentView(blocks: MarkdownFormatter.parse(content))
                    .textSelection(.enabled)
                    .padding(.horizontal, IonSpace.rowInset)
                    .padding(.vertical, IonSpace.contentGap)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
        } else {
            ScrollView(.horizontal) {
                ScrollView(.vertical) {
                    HStack(alignment: .top, spacing: 0) {
                        // Line number gutter
                        let lines = content.components(separatedBy: "\n")
                        VStack(alignment: .trailing, spacing: 0) {
                            ForEach(1...max(lines.count, 1), id: \.self) { lineNum in
                                Text("\(lineNum)")
                                    .ionType(.mono)
                                    .foregroundStyle(.tertiary)
                                    .frame(height: 20)
                            }
                        }
                        .padding(.top, IonSpace.compactGap)
                        .padding(.horizontal, IonSpace.hairlineGap)
                        .frame(width: 40)
                        .background(theme.surfaceSecondary)

                        Text(content)
                            .ionType(.mono)
                            .textSelection(.enabled)
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .padding(.horizontal, IonSpace.contentGap)
                            .padding(.vertical, IonSpace.compactGap)
                    }
                }
            }
        }
    }

    // MARK: - Error

    private func errorView(_ message: String) -> some View {
        VStack(spacing: 12) {
            Image(systemName: "exclamationmark.triangle")
                .font(.largeTitle)
                .foregroundStyle(.secondary)
            Text(message)
                .font(.subheadline)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .padding()
    }
}
