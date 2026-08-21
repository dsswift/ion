import Foundation

// MARK: - Worktree + integration bench command decoding
//
// Extracted from RemoteCommand+Decode.swift at the 600-line Swift cap. iOS
// only SENDS these commands; the decode paths exist because Codable
// conformance requires them (same pattern as the rest of the decode file).

extension RemoteCommand {

    /// Decode worktree/bench commands. Returns nil for anything not owned
    /// here, so `init(from:)` falls through to its own switch.
    static func decodeWorktreeCommand(
        type: TypeKey,
        container: KeyedDecodingContainer<CodingKeys>
    ) throws -> RemoteCommand? {
        switch type {
        case .worktreeRefresh:
            return .worktreeRefresh(repoPath: try container.decode(String.self, forKey: .repoPath))

        case .worktreeOpenConversation:
            return .worktreeOpenConversation(
                worktreePath: try container.decode(String.self, forKey: .worktreePath),
                // Absent means open-or-cycle: an older desktop sends no flag.
                newConversation: try container.decodeIfPresent(Bool.self, forKey: .newConversation) ?? false)

        case .worktreeSync:
            return .worktreeSync(
                worktreePath: try container.decode(String.self, forKey: .worktreePath),
                sourceBranch: try container.decode(String.self, forKey: .sourceBranch),
                repoPath: try container.decode(String.self, forKey: .repoPath))

        case .worktreeSyncAll:
            return .worktreeSyncAll(
                repoPath: try container.decode(String.self, forKey: .repoPath))

        case .worktreeLandAndRetire:
            return .worktreeLandAndRetire(
                repoPath: try container.decode(String.self, forKey: .repoPath),
                worktreePath: try container.decode(String.self, forKey: .worktreePath),
                worktreeBranch: try container.decode(String.self, forKey: .worktreeBranch),
                sourceBranch: try container.decode(String.self, forKey: .sourceBranch))

        case .benchOpenConversation:
            return .benchOpenConversation(
                repoPath: try container.decode(String.self, forKey: .repoPath),
                sourceBranch: try container.decode(String.self, forKey: .sourceBranch))

        case .benchOpenTerminal:
            return .benchOpenTerminal(
                repoPath: try container.decode(String.self, forKey: .repoPath),
                sourceBranch: try container.decode(String.self, forKey: .sourceBranch))

        case .benchAssemble:
            return .benchAssemble(
                repoPath: try container.decode(String.self, forKey: .repoPath),
                sourceBranch: try container.decode(String.self, forKey: .sourceBranch))

        case .benchUpdateMember:
            return .benchUpdateMember(
                repoPath: try container.decode(String.self, forKey: .repoPath),
                sourceBranch: try container.decode(String.self, forKey: .sourceBranch),
                worktreePath: try container.decode(String.self, forKey: .worktreePath))

        case .benchUpdateAll:
            return .benchUpdateAll(
                repoPath: try container.decode(String.self, forKey: .repoPath),
                sourceBranch: try container.decode(String.self, forKey: .sourceBranch))

        case .worktreeSetStage:
            return .worktreeSetStage(
                repoPath: try container.decode(String.self, forKey: .repoPath),
                worktreePath: try container.decode(String.self, forKey: .worktreePath),
                // decodeIfPresent, because an explicit null CLEARS the stage.
                stage: try container.decodeIfPresent(String.self, forKey: .stage))

        case .benchReorderMember:
            return .benchReorderMember(
                repoPath: try container.decode(String.self, forKey: .repoPath),
                sourceBranch: try container.decode(String.self, forKey: .sourceBranch),
                worktreePath: try container.decode(String.self, forKey: .worktreePath),
                toIndex: try container.decode(Int.self, forKey: .toIndex))

        case .benchAddMember:
            return .benchAddMember(
                repoPath: try container.decode(String.self, forKey: .repoPath),
                sourceBranch: try container.decode(String.self, forKey: .sourceBranch),
                worktreePath: try container.decode(String.self, forKey: .worktreePath),
                branchName: try container.decode(String.self, forKey: .branchName))

        case .benchRemoveMember:
            return .benchRemoveMember(
                repoPath: try container.decode(String.self, forKey: .repoPath),
                sourceBranch: try container.decode(String.self, forKey: .sourceBranch),
                worktreePath: try container.decode(String.self, forKey: .worktreePath))

        case .worktreeRetireLanded:
            return .worktreeRetireLanded(
                repoPath: try container.decode(String.self, forKey: .repoPath))

        case .worktreeCreate:
            return .worktreeCreate(
                repoPath: try container.decode(String.self, forKey: .repoPath),
                sourceBranch: try container.decode(String.self, forKey: .sourceBranch))

        case .worktreeConvertConversation:
            return .worktreeConvertConversation(
                tabId: try container.decode(String.self, forKey: .tabId))

        case .worktreeRename:
            return .worktreeRename(
                repoPath: try container.decode(String.self, forKey: .repoPath),
                worktreePath: try container.decode(String.self, forKey: .worktreePath),
                title: try container.decode(String.self, forKey: .title))

        case .worktreeReprovision:
            return .worktreeReprovision(
                repoPath: try container.decode(String.self, forKey: .repoPath),
                worktreePath: try container.decode(String.self, forKey: .worktreePath))

        case .benchRecoverConflict:
            return .benchRecoverConflict(
                repoPath: try container.decode(String.self, forKey: .repoPath),
                sourceBranch: try container.decode(String.self, forKey: .sourceBranch))

        case .benchAnalyseVerification:
            return .benchAnalyseVerification(
                repoPath: try container.decode(String.self, forKey: .repoPath),
                sourceBranch: try container.decode(String.self, forKey: .sourceBranch))

        case .benchDiscardMemberRecordings:
            return .benchDiscardMemberRecordings(
                repoPath: try container.decode(String.self, forKey: .repoPath),
                sourceBranch: try container.decode(String.self, forKey: .sourceBranch),
                branchNames: try container.decode([String].self, forKey: .branchNames))

        case .benchDiscardAllRecordings:
            return .benchDiscardAllRecordings(
                repoPath: try container.decode(String.self, forKey: .repoPath),
                sourceBranch: try container.decode(String.self, forKey: .sourceBranch))

        case .worktreeRetire:
            return .worktreeRetire(
                repoPath: try container.decode(String.self, forKey: .repoPath),
                worktreePath: try container.decode(String.self, forKey: .worktreePath),
                branchName: try container.decode(String.self, forKey: .branchName))

        case .worktreeConflictAssist:
            return .worktreeConflictAssist(
                repoPath: try container.decode(String.self, forKey: .repoPath),
                worktreePath: try container.decode(String.self, forKey: .worktreePath))

        case .benchConflictAssist:
            return .benchConflictAssist(
                repoPath: try container.decode(String.self, forKey: .repoPath),
                sourceBranch: try container.decode(String.self, forKey: .sourceBranch))

        case .worktreePipelineStart:
            return .worktreePipelineStart(
                repoPath: try container.decode(String.self, forKey: .repoPath),
                sourceBranch: try container.decode(String.self, forKey: .sourceBranch))

        case .worktreePipelineConfirmAi:
            return .worktreePipelineConfirmAi(
                repoPath: try container.decode(String.self, forKey: .repoPath))

        case .worktreePipelineCancel:
            return .worktreePipelineCancel(
                repoPath: try container.decode(String.self, forKey: .repoPath))

        case .worktreePipelineDismiss:
            return .worktreePipelineDismiss(
                repoPath: try container.decode(String.self, forKey: .repoPath))

        default:
            return nil
        }
    }
}
