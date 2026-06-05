import SwiftUI

/// File viewer/editor pushed onto the NavigationStack from FileExplorerView.
/// Opens in read-only preview mode by default. Markdown files render richly
/// using `MarkdownContentView`. Tap "Edit" to switch to the TextEditor.
struct FileEditorView: View {
    @Environment(\.appTheme) private var theme
    @Environment(SessionViewModel.self) private var viewModel
    @Environment(\.dismiss) private var dismiss

    let filePath: String
    let fileName: String

    @State private var editedContent: String = ""
    @State private var originalContent: String = ""
    @State private var isLoaded = false
    @State private var isEditing = false
    @State private var showUnsavedAlert = false
    @State private var saveMessage: String?

    private var isDirty: Bool {
        isLoaded && editedContent != originalContent
    }

    private var isLoading: Bool {
        viewModel.fileContentLoading.contains(filePath)
    }

    private var fileError: String? {
        viewModel.fileContent[filePath]?.error
    }

    private var isMarkdown: Bool {
        let ext = (fileName as NSString).pathExtension.lowercased()
        return ext == "md" || ext == "markdown" || ext == "mdx"
    }

    var body: some View {
        contentView
            .navigationTitle(fileName)
            .navigationBarTitleDisplayMode(.inline)
            .navigationBarBackButtonHidden(isDirty)
            .toolbar { toolbarContent }
            .task { viewModel.requestFsReadFile(filePath: filePath) }
            .onChange(of: viewModel.fileContent[filePath]?.content) { _, newContent in
                handleContentLoaded(newContent)
            }
            .onChange(of: viewModel.fileWriteResult) { _, result in
                handleWriteResult(result)
            }
            .alert("Unsaved Changes", isPresented: $showUnsavedAlert) {
                Button("Discard", role: .destructive) { dismiss() }
                Button("Cancel", role: .cancel) {}
            } message: {
                Text("You have unsaved changes. Discard them?")
            }
    }

    // MARK: - Content

    @ViewBuilder
    private var contentView: some View {
        if isLoading && !isLoaded {
            ProgressView("Loading file…")
                .frame(maxWidth: .infinity, maxHeight: .infinity)
        } else if let error = fileError {
            errorView(error)
        } else if isLoaded {
            if isEditing {
                editorView
            } else {
                previewView
            }
        } else {
            Color.clear
        }
    }

    // MARK: - Toolbar

    @ToolbarContentBuilder
    private var toolbarContent: some ToolbarContent {
        if isDirty {
            ToolbarItem(placement: .topBarLeading) {
                Button("Cancel") { showUnsavedAlert = true }
            }
        }
        ToolbarItem(placement: .topBarTrailing) {
            if isEditing {
                editingToolbar
            } else {
                Button {
                    isEditing = true
                } label: {
                    Label("Edit", systemImage: "pencil")
                        .font(.subheadline)
                }
            }
        }
    }

    private var editingToolbar: some View {
        HStack(spacing: 12) {
            Button {
                if isDirty {
                    showUnsavedAlert = true
                } else {
                    isEditing = false
                }
            } label: {
                Image(systemName: "eye")
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
            }

            Button {
                save()
            } label: {
                Text("Save")
                    .fontWeight(.semibold)
                    .foregroundStyle(isDirty ? theme.accent : .secondary)
            }
            .disabled(!isDirty)
        }
    }

    // MARK: - Preview View

    private var previewView: some View {
        ScrollView {
            if isMarkdown {
                markdownPreview
            } else {
                HStack(alignment: .top, spacing: 0) {
                    // Line number gutter
                    VStack(alignment: .trailing, spacing: 0) {
                        ForEach(1...max(editedContent.components(separatedBy: "\n").count, 1), id: \.self) { lineNum in
                            Text("\(lineNum)")
                                .font(.system(.caption, design: .monospaced))
                                .foregroundStyle(.tertiary)
                                .frame(height: 20)
                        }
                    }
                    .padding(.top, 8)
                    .padding(.horizontal, 4)
                    .frame(width: 40)
                    .background(Color(.secondarySystemBackground))

                    Text(editedContent)
                        .font(.system(.body, design: .monospaced))
                        .textSelection(.enabled)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .padding(.horizontal, 12)
                        .padding(.vertical, 8)
                }
            }
        }
    }

    // MARK: - Markdown Preview (with frontmatter handling)

    /// Markdown preview body. Splits any YAML frontmatter off the top of
    /// the document before handing the content to `MarkdownFormatter`,
    /// then renders the frontmatter (if present) in a dedicated collapsible
    /// section above the parsed markdown body.
    ///
    /// Why split: swift-markdown (CommonMark + GFM) does not recognize
    /// YAML frontmatter and parses the closing `---` fence as a setext
    /// H2 underline, which mangles the first frontmatter key into a giant
    /// heading and corrupts parser state so the first real heading below
    /// is rendered as body text. See `FrontmatterSplitter` for the full
    /// rationale; this mirrors the desktop renderer's behavior so the two
    /// reference clients render frontmatter-bearing markdown identically.
    private var markdownPreview: some View {
        let split = FrontmatterSplitter.split(editedContent)
        return VStack(alignment: .leading, spacing: 12) {
            if let frontmatter = split.frontmatterRaw {
                frontmatterSection(frontmatter)
            }
            MarkdownContentView(blocks: MarkdownFormatter.parse(split.body))
                .textSelection(.enabled)
                .frame(maxWidth: .infinity, alignment: .leading)
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 12)
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    /// Collapsible section that shows the raw frontmatter YAML verbatim.
    /// Default state: collapsed, so the preview reads cleanly. iOS's
    /// `DisclosureGroup` is the native equivalent of the desktop
    /// `<details>` element used in `FileEditorPreview.tsx`.
    private func frontmatterSection(_ raw: String) -> some View {
        DisclosureGroup {
            ScrollView(.horizontal, showsIndicators: false) {
                Text(raw)
                    .font(.system(.footnote, design: .monospaced))
                    .foregroundStyle(.secondary)
                    .textSelection(.enabled)
                    .padding(.horizontal, 12)
                    .padding(.vertical, 8)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
            .background(Color(.secondarySystemFill).opacity(0.4))
            .clipShape(RoundedRectangle(cornerRadius: 6))
        } label: {
            Text("Frontmatter")
                .font(.caption.weight(.semibold))
                .textCase(.uppercase)
                .foregroundStyle(.secondary)
                .kerning(0.4)
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 8)
        .overlay(
            RoundedRectangle(cornerRadius: 8)
                .stroke(Color(.separator), lineWidth: 0.5)
        )
    }

    // MARK: - Editor View

    private var editorView: some View {
        ZStack(alignment: .topTrailing) {
            HStack(alignment: .top, spacing: 0) {
                // Line number gutter
                ScrollView {
                    VStack(alignment: .trailing, spacing: 0) {
                        ForEach(1...max(editedContent.components(separatedBy: "\n").count, 1), id: \.self) { lineNum in
                            Text("\(lineNum)")
                                .font(.system(.caption, design: .monospaced))
                                .foregroundStyle(.tertiary)
                                .frame(height: 20)
                        }
                    }
                    .padding(.top, 8)
                    .padding(.horizontal, 4)
                }
                .frame(width: 40)
                .background(Color(.secondarySystemBackground))
                .scrollDisabled(true)

                Divider()

                TextEditor(text: $editedContent)
                    .font(.system(.body, design: .monospaced))
                    .autocorrectionDisabled()
                    .textInputAutocapitalization(.never)
                    .scrollContentBackground(.hidden)
                    .background(Color(.systemBackground))
            }

            if let msg = saveMessage {
                saveMessageBadge(msg)
            }
        }
    }

    private func saveMessageBadge(_ msg: String) -> some View {
        Text(msg)
            .font(.caption.weight(.medium))
            .padding(.horizontal, 8)
            .padding(.vertical, 4)
            .background(msg == "Saved" ? Color.green.opacity(0.15) : Color.red.opacity(0.15))
            .foregroundStyle(msg == "Saved" ? .green : .red)
            .clipShape(Capsule())
            .padding(8)
    }

    // MARK: - Error View

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

    // MARK: - Actions

    private func save() {
        guard isDirty else { return }
        saveMessage = nil
        viewModel.requestFsWriteFile(filePath: filePath, content: editedContent)
    }

    private func handleContentLoaded(_ newContent: String?) {
        if let content = newContent, !isLoaded {
            originalContent = content
            editedContent = content
            isLoaded = true
        }
    }

    private func handleWriteResult(_ result: FsWriteResultResponse?) {
        guard let result, result.filePath == filePath else { return }
        if result.ok {
            originalContent = editedContent
            saveMessage = "Saved"
            Task { @MainActor in
                try? await Task.sleep(for: .seconds(2))
                if saveMessage == "Saved" { saveMessage = nil }
            }
        } else {
            saveMessage = result.error ?? "Save failed"
        }
    }
}
