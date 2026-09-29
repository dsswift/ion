import SwiftUI

/// The developer tools a server's host has. A project setup that needs a
/// missing one fails there until it is installed.
struct HostToolsView: View {
    let model: HealthAdminModel

    var body: some View {
        List {
            if let tools = model.tools {
                Section {
                    ForEach(tools.tools) { tool in
                        HStack {
                            Image(systemName: tool.installed ? "checkmark.circle.fill" : "xmark.circle.fill")
                                .foregroundStyle(tool.installed ? .green : .red)
                                .accessibilityLabel(tool.installed ? "Installed" : "Missing")
                            VStack(alignment: .leading, spacing: 2) {
                                Text(tool.name)
                                if let path = tool.path {
                                    Text(path).font(.caption.monospaced()).foregroundStyle(.secondary).lineLimit(1).truncationMode(.middle)
                                }
                            }
                            Spacer()
                            Text(Self.version(tool)).foregroundStyle(.secondary).lineLimit(1)
                        }
                    }
                } footer: {
                    if !model.missingTools.isEmpty {
                        Text("A project setup that needs a missing tool will fail on \(model.serverLabel) until it is installed there.")
                    }
                }
            } else if let error = model.toolsError {
                Label("Could not check the host: \(error)", systemImage: "exclamationmark.triangle").foregroundStyle(.orange)
            } else {
                HStack(spacing: 10) {
                    ProgressView()
                    Text("Checking the host…").foregroundStyle(.secondary)
                }
            }
        }
        .navigationTitle("Tools on the host")
        .navigationBarTitleDisplayMode(.inline)
    }

    /// "2.47.0" from "git version 2.47.0"; "Missing" for an absent tool.
    static func version(_ tool: EnvironmentToolchains.Tool) -> String {
        guard tool.installed else { return "Missing" }
        guard let version = tool.version else { return "" }
        for prefix in ["git version ", "go version "] where version.hasPrefix(prefix) {
            return String(version.dropFirst(prefix.count))
        }
        return version
    }
}
