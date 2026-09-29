import SwiftUI

/// Which paired server this phone chats on. Picking another one switches the
/// live connection at once.
struct ChatOnPicker: View {
    @Environment(SessionViewModel.self) private var viewModel

    var body: some View {
        Picker(selection: Binding(
            get: { viewModel.activeDevice?.id ?? "" },
            set: { id in
                guard id != viewModel.activeDevice?.id else { return }
                DiagnosticLog.log("settings chat-on switching", tag: "view.settings", fields: ["device": String(id.prefix(8))])
                viewModel.switchToDevice(id: id)
                Haptic.success()
            }
        )) {
            ForEach(viewModel.pairedDevices) { device in
                Text(device.displayName).tag(device.id)
            }
        } label: {
            Text("Chat on")
        }
        .pickerStyle(.menu)
    }
}
