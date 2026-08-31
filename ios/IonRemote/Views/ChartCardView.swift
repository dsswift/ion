import SwiftUI
import UIKit

/// One chart, presented as a card: title, plot, caption, and actions.
///
/// Used in two places with the same code, which is what keeps them consistent:
/// the attachments sheet presents it full-screen, and it is the body of the
/// chart detail. The `compact` flag trims the chrome rather than forking the
/// view, so a chart never renders two different ways.
///
/// ── Actions carry numbers, not pixels ───────────────────────────────────────
/// Copy puts the chart's VALUES on the pasteboard as tab-separated text, not a
/// screenshot. A chart is usually copied to paste into a message or a ticket,
/// where a table is useful and an image is not. Share offers the same text
/// through the system sheet.
struct ChartCardView: View {
    @Environment(\.appTheme) private var theme
    let content: ChartResourceContent
    var compact: Bool = false

    @State private var selectedLabel: String?
    @State private var showShare = false
    @State private var copied = false
    /// Exact-value table visibility. Collapsed by default so the plot is the
    /// card's subject; the desktop card behaves the same way.
    @State private var showValues = false

    private var spec: ChartSpec { content.spec }

    var body: some View {
        VStack(alignment: .leading, spacing: IonSpace.contentGap) {
            header

            if spec.isSupportedVersion {
                ChartPlotView(spec: spec, selectedLabel: $selectedLabel)
                    .frame(height: compact ? 180 : 280)
                    .padding(.vertical, IonSpace.hairlineGap)
            } else {
                unsupportedVersion
            }

            if let caption = spec.caption, !caption.isEmpty {
                Text(caption)
                    .font(.caption)
                    .foregroundStyle(theme.textSecondary)
            }

            if !compact, spec.isSupportedVersion {
                // Exact values are collapsed by default, matching the desktop
                // card's "Show exact values" disclosure.
                //
                // The numbers are not optional — a chart answers "roughly how
                // much", and an operator quoting it to someone else, or a
                // VoiceOver user for whom the table IS the chart, needs
                // "exactly how much". But rendering them unconditionally
                // buried the plot itself: in a transcript the table is often
                // taller than the chart it describes, so every card pushed the
                // next turn off screen.
                Button {
                    withAnimation(.easeInOut(duration: 0.15)) {
                        showValues.toggle()
                    }
                } label: {
                    HStack(spacing: 4) {
                        Image(systemName: "tablecells")
                            .font(.caption2)
                        Text(showValues ? "Hide exact values" : "Show exact values")
                            .font(.caption2)
                        Spacer(minLength: 0)
                    }
                    .foregroundStyle(theme.textTertiary)
                }
                .buttonStyle(.plain)
                .accessibilityLabel(showValues ? "Hide exact values" : "Show exact values")

                if showValues {
                    valueTable
                }
            }

            footer
        }
        .padding(IonSpace.rowInset)
        .background(theme.surfaceElevated)
        .clipShape(RoundedRectangle(cornerRadius: IonRadius.container, style: .continuous))
        .sheet(isPresented: $showShare) {
            ExportShareSheet(items: [ChartMath.plainText(spec)])
        }
    }

    // MARK: - Header

    private var header: some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(spec.title)
                .font(.headline)
                .foregroundStyle(theme.textPrimary)
            if let subtitle = spec.subtitle, !subtitle.isEmpty {
                Text(subtitle)
                    .font(.caption)
                    .foregroundStyle(theme.textSecondary)
            }
        }
    }

    /// Shown when the chart was written by a newer Ion than this build knows.
    ///
    /// Deliberately explicit rather than a blank space: the user asked for a
    /// chart and something exists, so the honest answer is "this build cannot
    /// draw it", not silence. The values remain copyable.
    private var unsupportedVersion: some View {
        HStack(spacing: IonSpace.compactGap) {
            Image(systemName: "exclamationmark.triangle")
                .foregroundStyle(theme.statusWarning)
            Text("This chart needs a newer version of Ion Remote.")
                .font(.caption)
                .foregroundStyle(theme.textSecondary)
            Spacer()
        }
        .padding(.vertical, IonSpace.compactInset)
    }

    // MARK: - Value table
    //
    // The exact numbers, below the plot. A phone-sized chart cannot be read to
    // the precision the desktop's hover tooltip gives, so the values are shown
    // rather than hidden behind an interaction the user has to discover.

    private var valueTable: some View {
        VStack(alignment: .leading, spacing: IonSpace.hairlineGap) {
            ForEach(Array(spec.datasets.enumerated()), id: \.offset) { index, dataset in
                seriesRow(dataset: dataset, index: index)
            }
        }
    }

    private func seriesRow(dataset: ChartDataset, index: Int) -> some View {
        let resolved = dataset.resolvedData
        let format = ChartMath.format(for: dataset, in: spec)
        return VStack(alignment: .leading, spacing: 2) {
            HStack(spacing: IonSpace.compactGap) {
                Circle()
                    .fill(ChartMath.seriesColor(dataset, index: index, palette: ChartPalette.series(theme)))
                    .frame(width: 8, height: 8)
                Text(dataset.label)
                    .font(.caption.weight(.medium))
                    .foregroundStyle(theme.textPrimary)
                Spacer()
            }
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: IonSpace.contentGap) {
                    ForEach(Array(spec.labels.enumerated()), id: \.offset) { row, label in
                        VStack(spacing: 1) {
                            Text(label)
                                .ionType(.microLabel)
                                .foregroundStyle(theme.textSecondary)
                            // An em dash, never a zero: a missing reading and a
                            // reading of zero are different facts.
                            Text(cellText(resolved, row: row, format: format))
                                // design-type: monospaced digits keep the value
                                // columns aligned under their labels; a
                                // proportional role makes the row ragged.
                                .font(IonType.font(.microLabel).monospacedDigit())
                                .foregroundStyle(theme.textPrimary)
                        }
                    }
                }
            }
        }
    }

    private func cellText(_ resolved: [Double?], row: Int, format: ChartValueFormat?) -> String {
        guard row < resolved.count, let value = resolved[row] else { return "—" }
        return ChartMath.formatted(value, format)
    }

    // MARK: - Footer

    private var footer: some View {
        HStack(spacing: IonSpace.contentGap) {
            if let source = spec.source, !source.isEmpty {
                Text(source)
                    .ionType(.microLabel)
                    .foregroundStyle(theme.textSecondary)
                    .lineLimit(1)
            }
            Spacer()
            if content.revision > 1 {
                // Revision depth is worth showing: it tells the user this
                // chart has been refreshed, and which reading they are on.
                Text("v\(content.revision)")
                    // design-type: monospaced digits so the revision badge does
                    // not change width as the number grows.
                    .font(IonType.font(.microLabel).monospacedDigit())
                    .foregroundStyle(theme.textSecondary)
            }
            Button {
                UIPasteboard.general.string = ChartMath.plainText(spec)
                copied = true
                DiagnosticLog.log("chart values copied", tag: "view.chart", fields: [
                    "chart_id": content.chartId,
                    "revision": String(content.revision),
                ])
            } label: {
                Label(copied ? "Copied" : "Copy", systemImage: copied ? "checkmark" : "doc.on.doc")
                    .font(.caption)
            }
            .tint(theme.accent)

            Button {
                showShare = true
            } label: {
                Label("Share", systemImage: "square.and.arrow.up")
                    .font(.caption)
                    .labelStyle(.iconOnly)
            }
            .tint(theme.accent)
        }
    }
}
