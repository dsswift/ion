import Foundation

/// Chart identity and revision derivation for the transcript.
///
/// ── Why this mirrors the desktop rather than inventing a rule ──────────────
/// The desktop derives a chart's identity and its revision timeline purely
/// from transcript rows (`desktop/src/renderer/components/conversation/
/// chart-revisions.ts` and `desktop/src/shared/chart-result.ts`). iOS receives
/// the same rows over the wire — `toolName`, `toolInput`, and the tool
/// result `content` — so it can reach the same answer without any new
/// protocol surface.
///
/// The identity rule is the load-bearing part, and it is subtle enough that
/// the desktop got it wrong first: a chart id is minted from the tool-GATE
/// request id (`tool-gate-<nanos>-<seq>`), while a transcript row is keyed by
/// the engine's tool-USE id (`toolu_…` / `call_…`). Those id spaces never
/// intersect, so identity cannot be derived from the row id. It is stated in
/// the tool's RESULT text, which the engine persists verbatim, and read back
/// out from there on both clients.
///
/// Keeping the parse anchored on the same marker and separator as the desktop
/// writer means a reworded summary fails loudly on both platforms instead of
/// silently dropping charts on one of them.
enum ChartTranscript {

    /// The literal that precedes a chart id in a tool result.
    private static let idMarker = "id: "

    /// Read the chart id back out of a tool result.
    ///
    /// Returns `nil` when the content is not a chart result — a refused call,
    /// an empty row mid-stream, or any other tool's output. A `nil` means
    /// "this row has no chart identity", which the caller renders as no chart
    /// rather than guessing.
    static func chartId(fromResult content: String?) -> String? {
        guard let content, let markerRange = content.range(of: idMarker) else { return nil }
        let afterMarker = content[markerRange.upperBound...]
        // Anchored on the trailing separator so an id can never absorb the
        // words that follow it.
        guard let separator = afterMarker.range(of: " ·") else { return nil }
        let candidate = String(afterMarker[..<separator.lowerBound])
        guard !candidate.isEmpty,
              candidate.allSatisfy({ $0.isLetter || $0.isNumber || $0 == "-" || $0 == "_" })
        else { return nil }
        return candidate
    }

    /// One revision of a chart, and the transcript row that produced it.
    struct Revision: Equatable {
        let messageId: String
        let spec: ChartSpec
        let revision: Int
    }

    /// Every revision of one chart, in branch order.
    struct Timeline: Equatable {
        let chartId: String
        var title: String
        var revisions: [Revision]
        /// The row whose card is the CURRENT one; earlier rows show a marker.
        var currentMessageId: String
    }

    /// What a given tool row should draw.
    enum RowRender: Equatable {
        /// This row owns the live card.
        case current(Timeline)
        /// This row's chart was superseded by a later revision.
        case moved(chartId: String, title: String, targetMessageId: String)
    }

    /// Derive every chart timeline present in a conversation.
    ///
    /// Only completed `RenderChart` rows contribute: a running row has no
    /// result yet, and a failed one must not be able to change which chart is
    /// current. Identity comes from each row's own committed result for BOTH
    /// operations, so a stale or hallucinated `chartId` argument cannot graft
    /// a revision onto a different chart.
    static func timelines(from messages: [Message]) -> [Timeline] {
        var byChartId: [String: Timeline] = [:]
        var order: [String] = []

        for message in messages {
            guard message.role == .tool,
                  message.toolName == "RenderChart",
                  message.toolStatus == .completed,
                  let rawInput = message.toolInput, !rawInput.isEmpty,
                  let chartId = chartId(fromResult: message.content)
            else { continue }

            guard let request = ChartToolRequest.decode(from: rawInput) else { continue }

            if request.isUpdate {
                // An update whose create is not on this branch has nothing to
                // revise — after a rewind past the create, its row is orphaned.
                guard var timeline = byChartId[chartId] else { continue }
                timeline.revisions.append(Revision(
                    messageId: message.id,
                    spec: request.spec,
                    revision: timeline.revisions.count + 1
                ))
                timeline.title = request.spec.title
                timeline.currentMessageId = message.id
                byChartId[chartId] = timeline
                continue
            }

            byChartId[chartId] = Timeline(
                chartId: chartId,
                title: request.spec.title,
                revisions: [Revision(messageId: message.id, spec: request.spec, revision: 1)],
                currentMessageId: message.id
            )
            order.append(chartId)
        }

        return order.compactMap { byChartId[$0] }
    }

    /// Map every chart-bearing row id to what it should draw.
    ///
    /// Derived from the WHOLE conversation because a chart's current revision
    /// usually lives in a different turn than the row being rendered.
    static func rowRenders(from messages: [Message]) -> [String: RowRender] {
        var renders: [String: RowRender] = [:]
        for timeline in timelines(from: messages) {
            for revision in timeline.revisions {
                renders[revision.messageId] = revision.messageId == timeline.currentMessageId
                    ? .current(timeline)
                    : .moved(
                        chartId: timeline.chartId,
                        title: timeline.title,
                        targetMessageId: timeline.currentMessageId
                    )
            }
        }
        return renders
    }
}

/// A `RenderChart` tool call's input, as far as the transcript needs it.
///
/// The desktop validates every spec before storing it, so this decode is a
/// render-time guard rather than a second validator: anything that will not
/// decode is skipped and logged, never drawn half-formed.
struct ChartToolRequest {
    let isUpdate: Bool
    let spec: ChartSpec

    static func decode(from toolInput: String) -> ChartToolRequest? {
        guard let data = toolInput.data(using: .utf8) else { return nil }
        do {
            let spec = try JSONDecoder().decode(ChartSpec.self, from: data)
            // `operation` lives alongside the spec fields on the same object.
            let object = try JSONSerialization.jsonObject(with: data) as? [String: Any]
            let operation = object?["operation"] as? String
            return ChartToolRequest(isUpdate: operation == "update", spec: spec)
        } catch {
            // Streaming rows carry partial JSON; that is expected and common,
            // so this is debug rather than a warning.
            DiagnosticLog.log("chart tool input not renderable", tag: "model.chart", level: .debug, fields: [
                "input_length": String(toolInput.count),
                "error": String(describing: error),
            ])
            return nil
        }
    }
}
