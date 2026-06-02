import SwiftUI

/// Sheet to set the per-desktop display override (custom name + icon).
///
/// Edits go to the desktop via `viewModel.updateRemoteDisplay(...)` which
/// transparently picks the active transport when editing the current
/// desktop, or opens a transient sidecar transport for an inactive
/// desktop. The desktop persists the value and broadcasts to every paired
/// phone — so this same edit will appear on the user's other iPhones too.
struct DeviceCustomizationSheet: View {
    @Environment(\.appTheme) private var theme
    let device: PairedDevice

    @Environment(SessionViewModel.self) private var viewModel
    @Environment(\.dismiss) private var dismiss

    /// Curated SF Symbol identifiers — must match the desktop's Phosphor
    /// mapping in `RemoteDisplayPanel.tsx` so both UIs accept the same
    /// wire identifier strings. Display labels are iOS-only.
    struct IconChoice: Identifiable, Hashable {
        let id: String
        let label: String
        var symbol: String { PairedDevice.iconSymbol(for: id) }
    }

    static let iconChoices: [IconChoice] = [
        .init(id: "desktop",   label: "Desktop"),
        .init(id: "laptop",    label: "Laptop"),
        .init(id: "macmini",   label: "Mini"),
        .init(id: "macpro",    label: "Pro"),
        .init(id: "display",   label: "Display"),
        .init(id: "server",    label: "Server"),
        .init(id: "terminal",  label: "Terminal"),
        .init(id: "briefcase", label: "Work"),
        .init(id: "house",     label: "Home"),
        .init(id: "gamepad",   label: "Game"),
    ]

    @State private var draftName: String = ""
    @State private var selectedIcon: String? = nil
    @State private var saving: Bool = false
    @State private var errorMessage: String? = nil
    @State private var showError: Bool = false

    private let columns = [GridItem(.adaptive(minimum: 72, maximum: 96), spacing: 12)]

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    TextField("Custom name", text: $draftName)
                        .textInputAutocapitalization(.words)
                        .autocorrectionDisabled(false)
                        .disabled(saving)
                } header: {
                    Text("Custom Name")
                } footer: {
                    Text("Leave blank to use the original host name (\(device.name)).")
                }

                Section {
                    LazyVGrid(columns: columns, spacing: 12) {
                        // "Use default" tile clears the icon override
                        iconTile(
                            id: nil,
                            label: "Default",
                            symbol: PairedDevice.defaultIconSymbol,
                        )

                        ForEach(Self.iconChoices) { choice in
                            iconTile(
                                id: choice.id,
                                label: choice.label,
                                symbol: choice.symbol,
                            )
                        }
                    }
                    .padding(.vertical, 4)
                } header: {
                    Text("Icon")
                } footer: {
                    let isActive = device.id == viewModel.activeDevice?.id
                    if isActive {
                        Text("These settings sync to your other phones paired to this desktop.")
                    } else {
                        Text("Will connect briefly to this desktop to apply the change, then disconnect. Active session is not interrupted.")
                    }
                }
            }
            .navigationTitle("Customize")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    Button("Cancel") { dismiss() }
                        .disabled(saving)
                }
                ToolbarItem(placement: .topBarTrailing) {
                    if saving {
                        ProgressView()
                    } else {
                        Button("Save") { Task { await save() } }
                            .fontWeight(.semibold)
                    }
                }
            }
            .onAppear {
                draftName = device.customName ?? ""
                selectedIcon = device.customIcon
                DiagnosticLog.log("DISPLAY-SHEET: opened device=\(device.id.prefix(8)) hasName=\(device.customName != nil) hasIcon=\(device.customIcon ?? "nil")")
            }
            .alert("Couldn't Save", isPresented: $showError, presenting: errorMessage) { _ in
                Button("OK", role: .cancel) { }
            } message: { msg in
                Text(msg)
            }
        }
        .presentationDetents([.medium, .large])
    }

    @ViewBuilder
    private func iconTile(id: String?, label: String, symbol: String) -> some View {
        let isSelected = selectedIcon == id
        Button {
            selectedIcon = id
            Haptic.light()
        } label: {
            VStack(spacing: 6) {
                Image(systemName: symbol)
                    .font(.system(size: 24))
                    .frame(width: 28, height: 28)
                Text(label)
                    .font(.caption2)
                    .lineLimit(1)
            }
            .frame(maxWidth: .infinity, minHeight: 72)
            .padding(.vertical, 6)
            .background(
                RoundedRectangle(cornerRadius: 10)
                    .fill(isSelected ? theme.accent.opacity(0.18) : Color(.tertiarySystemBackground))
            )
            .overlay(
                RoundedRectangle(cornerRadius: 10)
                    .stroke(isSelected ? theme.accent : Color.clear, lineWidth: 2)
            )
            .foregroundStyle(isSelected ? theme.accent : .primary)
        }
        .buttonStyle(.plain)
        .disabled(saving)
    }

    private func save() async {
        saving = true
        defer { saving = false }

        let trimmed = draftName.trimmingCharacters(in: .whitespacesAndNewlines)
        let nameOut: String? = trimmed.isEmpty ? nil : trimmed
        let iconOut: String? = selectedIcon  // nil means clear override

        DiagnosticLog.log("DISPLAY-SHEET: save device=\(device.id.prefix(8)) name=\(nameOut == nil ? "cleared" : "set") icon=\(iconOut ?? "cleared")")

        do {
            try await viewModel.updateRemoteDisplay(
                device: device,
                customName: nameOut,
                customIcon: iconOut,
            )
            Haptic.success()
            DiagnosticLog.log("DISPLAY-SHEET: save OK device=\(device.id.prefix(8))")
            dismiss()
        } catch {
            DiagnosticLog.log("DISPLAY-SHEET: save FAILED device=\(device.id.prefix(8)) err=\(error.localizedDescription)")
            Haptic.error()
            errorMessage = error.localizedDescription
            showError = true
        }
    }
}
