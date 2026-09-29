import SwiftUI

/// A Settings row label: a colored icon tile, the title, and an optional
/// trailing detail, as Settings.app draws its category rows.
struct SettingsCategoryLabel: View {
    let title: String
    let symbol: String
    let tint: Color
    var detail: String?

    var body: some View {
        HStack(spacing: 12) {
            Image(systemName: symbol)
                .font(.system(size: 14, weight: .semibold)) // design-type: SF Symbol row-icon glyph sized as icon geometry, not text
                .foregroundStyle(.white)
                .frame(width: 28, height: 28)
                .background(tint, in: RoundedRectangle(cornerRadius: IonRadius.control))
            Text(title)
            Spacer()
            if let detail {
                Text(detail)
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
            }
        }
    }
}
