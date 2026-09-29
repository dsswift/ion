import SwiftUI

/// One run's stored evaluation path, one line per decision.
struct AutomationRunDetailView: View {
    let run: AutomationHistoryEntry
    let name: String

    var body: some View {
        List {
            Section {
                LabeledContent("Trigger", value: AutomationDescribe.triggerLabel(run.eventType))
                LabeledContent("Outcome") {
                    Label(run.outcome.capitalized, systemImage: AutomationRunRow.symbol(run.outcome))
                        .foregroundStyle(AutomationRunRow.tint(run.outcome))
                }
                if let finished = AutomationRunRow.date(run.finishedAt) {
                    LabeledContent("Finished") { Text(finished, format: .dateTime) }
                }
            }
            Section("Evaluation Path") {
                if let trace = run.trace {
                    ForEach(Array(AutomationDescribe.traceRows(trace).enumerated()), id: \.offset) { index, row in
                        HStack(alignment: .firstTextBaseline, spacing: IonSpace.compactGap) {
                            Text("\(index + 1).").font(.caption.monospacedDigit()).foregroundStyle(.secondary)
                            Text(row).font(.callout)
                        }
                    }
                } else {
                    Text("This older activity record has no step-by-step trace.").foregroundStyle(.secondary)
                }
            }
            if let error = run.error, !error.isEmpty {
                Section { AdminErrorRow(message: "Error: \(error)") }
            }
        }
        .navigationTitle(name)
        .navigationBarTitleDisplayMode(.inline)
    }
}
