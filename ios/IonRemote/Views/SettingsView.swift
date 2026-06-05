import SwiftUI

/// Top-level settings screen. Shows category rows that push into
/// dedicated detail views, matching the iOS Settings.app pattern.
///
/// Layout
/// ──────
/// 1. Active-device picker (only when ≥2 paired desktops). Tapping a
///    different device switches transports immediately — no Connect
///    button, no drilling into Desktops & Connection. Single-device
///    setups skip this picker entirely to avoid wasting space.
/// 2. Category rows:
///    - Desktops & Connection — pairing list, connection diagnostics,
///      and per-desktop projected settings.
///    - Appearance — merged iOS-local appearance/interface settings
///      (theme + new-tab default + tab list + agent panel + tab groups).
///    - Models — conversation/engine model pickers.
///    - Voice — voice toggle, API key, mode, prompt.
///    - Diagnostics & About — transport info, log, version.
///
/// Per-desktop scoping
/// ───────────────────
/// All "desktop settings" land in the Desktops & Connection → Desktop
/// Settings nested screen, scoped to the currently-active pairing.
/// Switching desktops from the picker at the top of this screen brings
/// up a fresh snapshot from the newly-active desktop, and that snapshot
/// drives every per-desktop projected control downstream.
struct SettingsView: View {
    @Environment(SessionViewModel.self) private var viewModel
    @Environment(\.appTheme) private var theme
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            List {
                // Multi-device picker, shown only when the user has
                // paired ≥2 desktops. With a single pairing the picker
                // is useless decoration so we hide it.
                if viewModel.pairedDevices.count >= 2 {
                    Section {
                        activeDevicePicker
                    } header: {
                        Text("Active Desktop")
                    } footer: {
                        Text("Switch between paired desktops without leaving Settings.")
                    }
                }

                categoryLink(
                    "Desktops & Connection",
                    icon: "desktopcomputer",
                    color: .blue,
                    detail: viewModel.activeDevice?.displayName
                ) {
                    SettingsDesktopsView()
                }

                categoryLink(
                    "Appearance",
                    icon: "paintbrush",
                    color: .purple,
                    detail: currentThemeName
                ) {
                    SettingsAppearanceView()
                }

                categoryLink(
                    "Models",
                    icon: "cpu",
                    color: .orange,
                    detail: currentModelLabel
                ) {
                    SettingsModelsView()
                }

                categoryLink(
                    "Voice",
                    icon: "waveform",
                    color: .green,
                    detail: viewModel.voiceService.isEnabled ? "On" : "Off"
                ) {
                    SettingsVoiceView()
                }

                categoryLink(
                    "Diagnostics & About",
                    icon: "stethoscope",
                    color: .gray
                ) {
                    SettingsDiagnosticsView()
                }
            }
            .navigationTitle("Settings")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button("Done") { dismiss() }
                }
            }
        }
    }

    // MARK: - Active device picker

    /// Inline picker row for switching the active desktop. Mirrors the
    /// `DesktopPickerMenu` toolbar pill (used in the main app
    /// toolbar) but rendered as a Settings-style row so it fits the
    /// surrounding List visual language.
    ///
    /// Tapping a non-active device calls `switchToDevice(id:)`, which
    /// tears down the current transport and brings up the new one.
    /// The active-device row shows a checkmark and is non-tappable.
    private var activeDevicePicker: some View {
        Menu {
            ForEach(viewModel.pairedDevices) { device in
                let isActive = device.id == viewModel.activeDeviceId
                    || (viewModel.activeDeviceId == nil && device.id == viewModel.pairedDevices.first?.id)
                Button {
                    if !isActive {
                        DiagnosticLog.log("[SettingsView] Active picker → switching to \(device.id)")
                        viewModel.switchToDevice(id: device.id)
                        Haptic.success()
                    }
                } label: {
                    HStack {
                        Label(device.displayName, systemImage: device.displayIcon)
                        if isActive { Image(systemName: "checkmark") }
                    }
                }
                .disabled(isActive)
            }
        } label: {
            HStack(spacing: 12) {
                if let device = viewModel.activeDevice {
                    Image(systemName: device.displayIcon)
                        .font(.system(size: 16, weight: .semibold))
                        .foregroundStyle(.white)
                        .frame(width: 28, height: 28)
                        .background(activeStatusColor, in: RoundedRectangle(cornerRadius: 6))
                } else {
                    Image(systemName: "questionmark")
                        .font(.system(size: 16, weight: .semibold))
                        .foregroundStyle(.white)
                        .frame(width: 28, height: 28)
                        .background(Color.gray, in: RoundedRectangle(cornerRadius: 6))
                }
                VStack(alignment: .leading, spacing: 2) {
                    Text(viewModel.activeDevice?.displayName ?? "No active desktop")
                        .foregroundStyle(.primary)
                    Text(connectionStateLabel)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
                Spacer()
                Image(systemName: "chevron.up.chevron.down")
                    .font(.caption)
                    .foregroundStyle(.tertiary)
            }
            .contentShape(Rectangle())
        }
    }

    /// Status-color dot color for the active device. Green when
    /// connected, orange when reconnecting/connecting, red otherwise.
    private var activeStatusColor: Color {
        switch viewModel.connectionState {
        case .connected: .green
        case .reconnecting, .connecting: .orange
        default: .red
        }
    }

    /// Connection-state subtitle for the picker row. Mirrors
    /// `DesktopPickerMenu.connectionStateLabel`.
    private var connectionStateLabel: String {
        let connection = viewModel.connectionState.label
        switch viewModel.transportState {
        case .lanPreferred:
            return "\(connection) · LAN"
        case .relayOnly:
            return "\(connection) · Relay"
        case .disconnected:
            return connection
        }
    }

    // MARK: - Helpers

    private var currentThemeName: String {
        ThemeRegistry.themes.first { $0.id == theme.selectedThemeId }?.displayName ?? "Default"
    }

    private var currentModelLabel: String {
        viewModel.availableModels.first { $0.id == viewModel.preferredModel }?.label ?? viewModel.preferredModel
    }

    /// Reusable category row with icon, label, optional detail, and chevron.
    private func categoryLink<Destination: View>(
        _ title: String,
        icon: String,
        color: Color,
        detail: String? = nil,
        @ViewBuilder destination: () -> Destination
    ) -> some View {
        NavigationLink(destination: destination) {
            HStack(spacing: 12) {
                Image(systemName: icon)
                    .font(.system(size: 14, weight: .semibold))
                    .foregroundStyle(.white)
                    .frame(width: 28, height: 28)
                    .background(color, in: RoundedRectangle(cornerRadius: 6))

                Text(title)

                Spacer()

                if let detail {
                    Text(detail)
                        .foregroundStyle(.secondary)
                        .font(.subheadline)
                        .lineLimit(1)
                }
            }
        }
    }
}
