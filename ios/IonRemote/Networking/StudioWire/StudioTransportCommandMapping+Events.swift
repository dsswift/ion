import Foundation

/// What a command's `studio_action` answers, as the events the view model
/// already handles. The `desktop_*` wire pushed a named reply event for many
/// commands; on the Studio wire the reply is the action's value, and this is
/// where one becomes the other.
///
/// A command whose outcome reaches the client as an ordinary event (a tab
/// delta, a status change, a questions snapshot) answers with no events at
/// all: the event stream already carries it, and synthesizing a second copy
/// would double-surface the same change.
extension StudioTransportCommandMapping {

    // swiftlint:disable:next cyclomatic_complexity function_body_length
    func events(for command: RemoteCommand, call: StudioActionCall, result: JSONValue) -> [RemoteEvent] {
        switch command {
        case .closeTab(let tabId):
            // `false` means the conversation still has work in flight; the row stays.
            return result["closed"]?.boolValue == true ? [.tabClosed(tabId: tabId)] : []

        case .prompt(let tabId, _, _, let clientMsgId, _, _, _, _):
            let accepted = result["accepted"]?.boolValue == true
            return [.promptResult(
                tabId: tabId, clientMsgId: result["clientMsgId"]?.stringValue ?? clientMsgId ?? "",
                status: accepted ? "accepted" : "rejected", error: result["reason"]?.stringValue)]

        case .stopBackgroundTask(_, let taskId, let requestId):
            let status = result["status"]?.stringValue ?? (result["ok"]?.boolValue == true ? "stopped" : "failed")
            return [.backgroundTaskStopResult(
                requestId: requestId, taskId: taskId, status: status, error: result["error"]?.stringValue)]

        case .requestTranscript(let tabId, let requestId):
            return [.transcript(
                tabId: tabId, requestId: requestId, transcript: result["content"]?.stringValue ?? "", error: nil)]

        case .forkFromMessage:
            // A refused fork answers null and leaves the composer alone.
            guard let tabId = result["tabId"]?.stringValue else { return [] }
            return [.inputPrefill(
                tabId: tabId, text: result["pendingInput"]?.stringValue ?? "", switchTo: true, instanceId: nil)]

        case .engineRewind(let tabId, let instanceId, _, _):
            guard result["ok"]?.boolValue == true else {
                return [.engineRewindResult(
                    tabId: tabId, instanceId: instanceId,
                    error: result["error"]?.stringValue ?? "The rewind was refused")]
            }
            guard let pending = result["pendingInput"]?.stringValue else { return [] }
            return [.inputPrefill(tabId: tabId, text: pending, switchTo: false, instanceId: instanceId)]

        case .requestAgentState(let tabId, let instanceId):
            let agents = Self.decode(result["agents"] ?? .array([]), as: [AgentStateUpdate].self, what: "agent roster") ?? []
            return [.engineAgentState(
                tabId: result["tabId"]?.stringValue ?? tabId,
                instanceId: result["instanceId"]?.stringValue ?? instanceId, agents: agents, metadataOmitted: false)]

        case .loadAttachments(let tabId):
            let entries = Self.decode(result["attachments"] ?? .array([]), as: [TabAttachmentEntry].self, what: "tab attachments") ?? []
            return [.tabAttachments(tabId: tabId, attachments: entries)]

        case .requestPlanContent(_, let questionId, let planFilePath, let offset, _):
            return [.planContent(
                questionId: result["questionId"]?.stringValue ?? questionId,
                planFilePath: result["planFilePath"]?.stringValue ?? planFilePath,
                offset: result["offset"]?.intValue ?? offset, content: result["content"]?.stringValue ?? "",
                totalBytes: result["totalBytes"]?.intValue ?? 0, hasMore: result["hasMore"]?.boolValue ?? false)]

        case .discoverCommands(let directory):
            let commands = Self.decode(result, as: [DiscoveredSlashCommand].self, what: "discovered commands") ?? []
            return [.discoverCommandsResponse(directory: directory, commands: commands)]

        case .terminalAddInstance(let tabId), .requestTerminalSnapshot(let tabId):
            // The add answers only the new instance's id, so the pane is read
            // back (see `next`) and the whole pane becomes the event: it names
            // every instance and which one is active, which an "added" event
            // on its own does not.
            guard call.action == "terminal.paneSnapshot" else { return [] }
            return Self.paneEvents(tabId: tabId, result: result)

        case .terminalRemoveInstance(let tabId, let instanceId):
            return [.terminalInstanceRemoved(tabId: tabId, instanceId: instanceId)]

        case .questionsRefresh(let tabId):
            guard let state = Self.decode(result, as: QuestionsStateSnapshot.self, what: "questions state") else { return [] }
            return [.questionsState(tabId: tabId, state: state)]

        case .setRemoteDisplay(_, _, let updatedAt):
            let stamped = result["updatedAt"]?.numberValue.map { Date(timeIntervalSince1970: $0 / 1000) } ?? updatedAt
            return [.remoteDisplay(
                customName: result["customName"]?.stringValue, customIcon: result["customIcon"]?.stringValue,
                updatedAt: stamped)]

        case .requestResourceContent(let kind, let producer, let resourceId):
            return [.resourceContent(
                resourceId: result["id"]?.stringValue ?? resourceId, kind: result["kind"]?.stringValue ?? kind,
                producer: result["producer"]?.stringValue ?? producer ?? "", content: result["content"]?.stringValue ?? "")]

        case .requestThemeAsset(let themeId, let slot):
            return [.desktopThemeAssetContent(
                themeId: themeId, slot: slot, ok: !result.isNull,
                sha256: result["sha256"]?.stringValue, dataUrl: result["dataUrl"]?.stringValue)]

        case .uploadAttachment(_, let name, let correlationId):
            guard !result.isNull else {
                return [.uploadAttachmentResult(
                    id: "", name: name, path: "", correlationId: correlationId, contentHash: nil,
                    error: "Failed to save uploaded file")]
            }
            return [.uploadAttachmentResult(
                id: result["id"]?.stringValue ?? "", name: result["name"]?.stringValue ?? name,
                path: result["path"]?.stringValue ?? "", correlationId: correlationId,
                contentHash: result["contentHash"]?.stringValue, error: nil)]

        default:
            return Self.fileEvents(for: command, result: result)
                ?? Self.gitEvents(for: command, call: call, result: result)
                ?? Self.worktreeEvents(for: command, call: call, result: result)
                ?? []
        }
    }

    func events(for command: RemoteCommand, call: StudioActionCall, failure: StudioActionFailure) -> [RemoteEvent] {
        let message = failure.localizedDescription
        switch command {
        case .prompt(let tabId, _, _, let clientMsgId, _, _, _, _):
            return [.promptResult(tabId: tabId, clientMsgId: clientMsgId ?? "", status: "rejected", error: message)]
        case .stopBackgroundTask(_, let taskId, let requestId):
            return [.backgroundTaskStopResult(requestId: requestId, taskId: taskId, status: "failed", error: message)]
        case .requestTranscript(let tabId, let requestId):
            return [.transcript(tabId: tabId, requestId: requestId, transcript: "", error: message)]
        case .engineRewind(let tabId, let instanceId, _, _):
            return [.engineRewindResult(tabId: tabId, instanceId: instanceId, error: message)]
        default:
            return Self.gitFailureEvents(for: command, call: call, message: message)
                ?? Self.worktreeFailureEvents(for: command, message: message)
                ?? Self.fileEvents(for: command, result: .object(["error": .string(message)]))
                ?? []
        }
    }

    // MARK: - Chained calls

    func next(for command: RemoteCommand, after call: StudioActionCall, result: JSONValue) -> StudioActionCall? {
        switch command {
        // Adding an instance answers its id only; read the pane back for the rest.
        case .terminalAddInstance(let tabId) where call.action == "addTerminalInstance":
            return .fields("terminal.paneSnapshot", ["tabId": .string(tabId)])

        // A write the older wire answered with a pushed refresh. The read runs
        // after the write, never beside it, so it cannot report the old tree.
        case .gitStage(let directory, _), .gitUnstage(let directory, _), .gitDiscard(let directory, _):
            return call.action == "git.changes" ? nil : Self.gitChanges(directory)
        case .gitCommit(let directory, _), .gitFetch(let directory), .gitPull(let directory):
            if call.action == "git.changes" { return Self.gitGraph(directory) }
            return call.action == "git.graph" ? nil : Self.gitChanges(directory)
        case .gitPush(let directory):
            return call.action == "git.graph" ? nil : Self.gitGraph(directory)

        // The recovery answers the bench path; the assist verb opens a
        // conversation on it. A null path means there was nothing to recover.
        case .benchConflictAssist where call.action == "benchResolveConflict":
            guard let benchPath = result.stringValue else { return nil }
            return .positional("openConflictAssist", .string(benchPath))

        default:
            return nil
        }
    }

    // MARK: - Helpers

    /// Decodes an action's value, saying which command's reply was lost when it
    /// does not fit. A dropped reply is a missing event, never a crash.
    static func decode<T: Decodable>(_ value: JSONValue, as type: T.Type, what: String) -> T? {
        do {
            return try value.decoded(as: T.self)
        } catch {
            DiagnosticLog.log("studio mapping: an action value did not decode, its reply is lost", tag: "studio.map", level: .error, fields: [
                "what": what, "error": String(String(describing: error).prefix(300))
            ])
            return nil
        }
    }

    private static func paneEvents(tabId: String, result: JSONValue) -> [RemoteEvent] {
        // A tab with no terminal answers null.
        guard !result.isNull else { return [] }
        let instances = decode(result["instances"] ?? .array([]), as: [TerminalInstanceInfo].self, what: "terminal pane") ?? []
        let buffers = decode(result["buffers"] ?? .null, as: [String: String].self, what: "terminal buffers")
        return [.terminalSnapshot(
            tabId: result["tabId"]?.stringValue ?? tabId, instances: instances,
            activeInstanceId: result["activeInstanceId"]?.stringValue, buffers: buffers)]
    }
}
