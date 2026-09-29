import SwiftUI

/// One row of the Projects list: its dot, name, and branch with status, or
/// a job's stage and progress.
struct ProjectRowView: View {
    let row: ProjectListRow

    var body: some View {
        let status = row.status
        HStack(alignment: .firstTextBaseline, spacing: IonSpace.compactGap) {
            ProjectStatusDot(status: status)
                .alignmentGuide(.firstTextBaseline) { $0[VerticalAlignment.center] + 4 }
            VStack(alignment: .leading, spacing: 2) {
                Text(row.name).lineLimit(1)
                detail(status)
            }
        }
    }

    @ViewBuilder private func detail(_ status: ProjectRowStatus) -> some View {
        switch row {
        case .project(let project, _):
            let parts = [project.branch, status.text].compactMap { $0 }
            if !parts.isEmpty {
                Text(parts.joined(separator: " · "))
                    .font(.caption)
                    .foregroundStyle(status.tone == .error ? .red : .secondary)
                    .lineLimit(1)
            }
        case .job(let job):
            if job.phase == .failed {
                Text(job.error?.split(separator: "\n").first.map(String.init) ?? "Clone failed")
                    .font(.caption)
                    .foregroundStyle(.red)
                    .lineLimit(2)
            } else {
                Text("\(status.text ?? job.stage) · \(job.stage)")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
                if let percent = job.percent {
                    ProgressView(value: min(max(percent, 0), 100), total: 100)
                        .progressViewStyle(.linear)
                }
            }
        }
    }
}
