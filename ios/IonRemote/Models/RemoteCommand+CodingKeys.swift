import Foundation

/// Wire field names for `RemoteCommand`.
///
/// Extracted from RemoteCommand.swift to keep that file under the 600-line
/// cap. The enum is the single namespace for every command's payload keys, so
/// it grows with the wire and would otherwise keep pushing the type past the
/// limit.
///
/// Keys are shared across commands where the wire genuinely uses the same
/// field name; the comments below record the cases where sharing was
/// deliberately REFUSED, which is the part that prevents type confusion.
extension RemoteCommand {
  enum CodingKeys: String, CodingKey {
    case scope, dispatchId, taskId
    case type
    case workingDirectory, tabId, text, questionId, optionId, mode, before, origin, url, pageSize
    case instanceId, data, cols, rows, customTitle, label, messageId, clientMsgId
    case dialogId, value, profileId, model, groupId
    // `pinToGroupId` is the distinct wire-level key for the optional
    // create_tab extension. We deliberately do NOT reuse `groupId` here
    // — `groupId` already names the destination on move_tab_to_group,
    // and conflating the two would invite type confusion if a future
    // command needs both (e.g. a hypothetical "create_tab_in_group_and_send"
    // that names a target group AND a separate pin source).
    case pinToGroupId
    // `extensions` carries the optional list of extension IDs for
    // engine-hosted tabs created via the unified desktop_create_tab shape.
    case extensions
    // `clientCmdId` correlates create commands to their desktop_tab_created
    // echo for the confirm-or-resend delivery loop (create-tab reliability).
    case clientCmdId
    case directory, path, staged, paths, skip, limit, message, filePath, content, includeHidden,
      hash
    case repoPath, worktreePath, worktreeBranch, sourceBranch, branchName
    // fs_rename payload — both paths are absolute and live under a
    // project root. New CodingKeys (no collision with existing entries);
    // checked against the full enum above before adding.
    case oldPath, newPath
    case attachments, dataUrl, name, correlationId, orderedIds, implementationPhase
    case systemPrompt, stage, toIndex, newConversation, enabled
    case logs, pairingId, nextSeq
    case sourceTabId, targetTabId
    case useWorktree
    case assignments, orderKey
    case customName, customIcon, updatedAt
    // setDesktopSetting payload. `key` is unique to this command;
    // `value` is shared with engineDialogResponse (both carry a
    // type-erased payload, both use the same wire field name) so
    // we declare only `key` here and reuse the existing `value`
    // CodingKey above.
    case key
    case conversationIds
    // requestThemeAsset payload — theme-pack id + asset slot
    // ("background" | "logo").
    case themeId, slot
    // setPillColor / setPillIcon payloads.
    case pillColor, pillIcon
    // reportFocus payload. `interceptEnabled` is the iOS-local
    // "Allow conversation intercepts" preference. `tabId` is already
    // declared above (shared with many commands); `interceptEnabled`
    // is new and unique to this command.
    case interceptEnabled
    case accountUsername, accountName, subject, tenantId, signedInAt, clearIdentity, accessStatus,
      accessReason, reportedAt
    // requestResourceContent payload. `kind` identifies the resource
    // type (any extension-declared kind); `resourceId` is the item ID.
    // These share no wire key with any existing command field.
    case resourceId
    case kind
    case producer
    // engine_rewind payload. `tabId`/`instanceId`/`messageId` are shared
    // with other commands above; `userTurnIndex` is unique to this command
    // — the 0-based ordinal among user messages the desktop uses to resolve
    // the rewind point when its id lookup misses.
    case userTurnIndex
    // implement_plan payload. `questionId`/`tabId`/`instanceId` are shared
    // above. `clearContext` is the flag for the "clear context" variant —
    // omitted on the wire when false (encodeIfPresent pattern).
    case clearContext
    // request_plan_content payload. `tabId`/`questionId`/`planFilePath` are
    // shared above (`filePath` already covers `planFilePath` in other cmds;
    // the wire key here is literally "planFilePath" so we add a distinct
    // CodingKey that serialises to the canonical wire name).
    case planFilePath
    case offset
    // `length` is unique to request_plan_content — no collision in the existing set.
    case length
    // setThinkingEffort payload. `tabId` is shared above; `effort` is the
    // canonical wire key ("off"|"low"|"medium"|"high"), unique here.
    case effort
    // tabSnooze payload: absolute wake time in unix ms.
    case untilMs
    // respondElicitation payload. `tabId` is shared above. `requestId`
    // identifies the elicitation; `response` carries the approval payload
    // (type-erased map, distinct from the shared `value` key); `cancelled`
    // is the decline flag. All three are unique to this command.
    case requestId, response, cancelled, declined
    // requestResend payload — the inclusive wire-frame seq range to replay.
    case fromSeq, toSeq
    // Guided Questions payloads: a nested revisioned patch or action object
    // (see QuestionsModels.swift). `tabId` is shared above.
    case patch, action
    case title, branchNames
  }
}
