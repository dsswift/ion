import SwiftUI

/// A chart as it appears in the conversation transcript.
///
/// Two states, mirroring the desktop:
///
///   - **current** — this row owns the live card, so the chart is drawn.
///   - **moved** — a later turn revised this chart, so the row keeps its place
///     in history but shows a marker pointing forward instead of drawing a
///     stale card. Drawing the old data here would present superseded numbers
///     as though they were current, which is worse than showing nothing.
///
/// The card itself is `ChartCardView`, the same renderer the notifications
/// sheet uses — one chart renderer for the whole app, so a spec cannot draw
/// differently depending on where it is opened.
struct ChartTranscriptCard: View {
    let render: ChartTranscript.RowRender
    @Environment(\.appTheme) private var theme

    var body: some View {
        switch render {
        case .current(let timeline):
            VStack(alignment: .leading, spacing: IonSpace.hairlineGap) {
                ChartCardView(content: content(for: timeline))
                    // Publish the card's position so a jump can land on the
                    // CARD rather than the top of the turn that contains it.
                    // A turn can be several screens tall with the chart at its
                    // very end, so row-start alone leaves the chart below the
                    // fold — the same defect the desktop fixed by measuring
                    // the chart element instead of the row.
                    .reportsChartAnchor(chartId: timeline.chartId)
                if timeline.revisions.count > 1 {
                    // Revision depth is stated rather than made browsable: the
                    // desktop card pages through revisions, but a transcript
                    // row on a phone is not the place for that control. The
                    // count tells the operator the chart has history without
                    // implying the row is interactive.
                    Text("Revision \(timeline.revisions.count)")
                        .font(IonType.microLabel)
                        .foregroundStyle(theme.textTertiary)
                        .padding(.leading, IonSpace.screenInset)
                }
            }
        case .moved(_, let title, _):
            HStack(spacing: IonSpace.hairlineGap) {
                Image(systemName: "arrow.down.circle")
                    .font(IonType.metadata)
                Text("\(title) — updated later in this conversation")
                    .font(IonType.microLabel)
                Spacer(minLength: 0)
            }
            .foregroundStyle(theme.textTertiary)
            .padding(.leading, IonSpace.screenInset)
        }
    }

    /// Adapt a derived timeline to the shape `ChartCardView` renders.
    ///
    /// The transcript derives its chart from tool rows, while the notifications
    /// sheet decodes a stored resource; both end at the same spec, so the card
    /// takes the resource shape and this fills in the fields a transcript row
    /// does not carry. Timestamps are empty because the card does not display
    /// them — inventing values here would put fabricated data on screen.
    private func content(for timeline: ChartTranscript.Timeline) -> ChartResourceContent {
        ChartResourceContent(
            chartId: timeline.chartId,
            title: timeline.title,
            spec: timeline.revisions.last?.spec ?? timeline.revisions[0].spec,
            revision: timeline.revisions.count,
            toolMessageId: timeline.currentMessageId,
            createdAt: "",
            updatedAt: ""
        )
    }
}
