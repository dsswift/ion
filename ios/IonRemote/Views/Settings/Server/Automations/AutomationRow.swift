import SwiftUI

/// One automation in the list: its enable switch, name, when it runs, and
/// its source. Tapping the row outside the switch opens it.
struct AutomationRow<Destination: View>: View {
    let entry: AutomationSourceEntry
    let canToggle: Bool
    let onToggle: () -> Void
    @ViewBuilder let destination: () -> Destination

    var body: some View {
        HStack(alignment: .top, spacing: IonSpace.contentGap) {
            Toggle("Enable \(entry.definition.name)", isOn: Binding(
                get: { AutomationsAdminModel.isEnabled(entry) },
                set: { _ in onToggle() }
            ))
            .labelsHidden()
            .disabled(!canToggle)
            VStack(alignment: .leading, spacing: IonSpace.hairlineGap) {
                Text(entry.definition.name.isEmpty ? "Untitled automation" : entry.definition.name)
                    .foregroundStyle(entry.effective ? .primary : .secondary)
                Text(AutomationDescribe.triggerLabel(entry.definition.trigger.event))
                    .font(.caption)
                    .foregroundStyle(.secondary)
                AutomationSourceChips(entry: entry)
            }
            Spacer(minLength: 0)
            Image(systemName: "chevron.right").font(.caption.weight(.semibold)).foregroundStyle(.tertiary)
        }
        // The link fills the row behind the switch, so the switch keeps its own taps.
        .background {
            NavigationLink(destination: destination) { EmptyView() }.opacity(0)
        }
    }
}
