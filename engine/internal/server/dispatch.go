package server

// dispatch.go — the command dispatch switch.
//
// dispatch() is the single entry point that routes a parsed ClientCommand to
// the right handler. It is the highest-churn surface in the server package —
// every new wire command adds a case — so it lives in its own file to keep
// server.go (construction, lifecycle, accept/handle loops, broadcast) free of
// the dispatch growth. Larger per-command handlers are extracted further into
// dispatch_*.go siblings (dispatch_data.go, dispatch_plan_content.go,
// dispatch_resources.go); the cases here that delegate to those are one-liners.

import (
	"fmt"
	"net"
	"time"

	"github.com/dsswift/ion/engine/internal/auth"
	"github.com/dsswift/ion/engine/internal/conversation"
	"github.com/dsswift/ion/engine/internal/plugins"
	"github.com/dsswift/ion/engine/internal/protocol"
	"github.com/dsswift/ion/engine/internal/providers"
	"github.com/dsswift/ion/engine/internal/session"
	"github.com/dsswift/ion/engine/internal/tools"
	"github.com/dsswift/ion/engine/internal/types"
	"github.com/dsswift/ion/engine/internal/utils"
)

func (s *Server) dispatch(conn net.Conn, cmd *protocol.ClientCommand) {
	s.dispatchWithRecovery(conn, cmd, s.dispatchCommand)
}

// dispatchWithRecovery keeps one malformed or failing command from taking down
// the client loop. The handler argument makes the recovery boundary directly
// testable without relying on an accidental panic in a command implementation.
func (s *Server) dispatchWithRecovery(
	conn net.Conn,
	cmd *protocol.ClientCommand,
	handler func(net.Conn, *protocol.ClientCommand),
) {
	defer func() {
		if r := recover(); r != nil {
			utils.LogWithFields(utils.LevelError, "server", "panic in dispatch", map[string]any{"status": cmd.Cmd, "session_id": cmd.Key, "error": r})
			s.sendResult(conn, cmd, fmt.Errorf("internal error"), nil)
		}
	}()

	handler(conn, cmd)
}

func (s *Server) dispatchCommand(conn net.Conn, cmd *protocol.ClientCommand) {
	utils.LogWithFields(utils.LevelDebug, "server", "dispatch", map[string]any{"status": cmd.Cmd, "session_id": cmd.Key, "run_id": cmd.RequestID})

	// Test-only: see testDispatchPanicTrigger's doc comment in server.go.
	// Zero-cost in production — the field is always empty and this is a
	// single string comparison per dispatch call. One-shot: disarms itself
	// so a test that issues the same command again afterward (e.g. to prove
	// the connection still works) does not re-trigger.
	if s.testDispatchPanicTrigger != "" && s.testDispatchPanicTrigger == cmd.Cmd {
		s.testDispatchPanicTrigger = ""
		panic("testDispatchPanicTrigger: forced panic for " + cmd.Cmd)
	}

	switch cmd.Cmd {
	case "start_session":
		if cmd.Config == nil {
			s.sendResult(conn, cmd, fmt.Errorf("start_session requires config"), nil)
			break
		}
		if err := s.requireOperatorIdentityForSession(); err != nil {
			s.sendResult(conn, cmd, err, nil)
			break
		}
		result, err := s.manager.StartSession(cmd.Key, *cmd.Config)
		if err == nil {
			s.ownership.claim(conn, cmd.Key)
			if cmd.Config.Pinned {
				s.ownership.pin(cmd.Key)
			}
		}
		s.sendResult(conn, cmd, err, result)

	case "send_prompt":
		if err := s.requireOperatorIdentityForSession(); err != nil {
			s.sendResult(conn, cmd, err, nil)
			break
		}
		if !s.manager.ReserveDeliveryID(cmd.Key, cmd.DeliveryId) {
			utils.LogWithFields(utils.LevelInfo, "server", "send_prompt: idempotent duplicate, skipping run", map[string]any{
				"key":         cmd.Key,
				"delivery_id": cmd.DeliveryId,
			})
			s.sendResult(conn, cmd, nil, map[string]any{
				"accepted":        false,
				"alreadyAccepted": true,
			})
			break
		}
		reservedDelivery := cmd.DeliveryId
		var err error
		defer func() {
			if err != nil {
				s.manager.ReleaseDeliveryID(cmd.Key, reservedDelivery)
			}
		}()
		var overrides *session.PromptOverrides
		resolvedExts := cmd.ResolveExtensions()
		if cmd.Model != "" || cmd.MaxTurns > 0 || cmd.MaxBudgetUsd > 0 || len(resolvedExts) > 0 || cmd.NoExtensions || cmd.AppendSystemPrompt != "" || len(cmd.Attachments) > 0 || cmd.ImplementationPhase || cmd.ThinkingEffort != "" || cmd.EnterPlanModeDescription != "" || cmd.PlanModeSparseReminder != "" || cmd.PlanFilePath != "" || len(cmd.BashAllowlistAdditionsForThisPrompt) > 0 || len(cmd.McpAllowlistAdditionsForThisPrompt) > 0 || cmd.CompactTargetPercent > 0 || cmd.CompactMicroKeepTurns > 0 || cmd.CompactEnabled != nil || cmd.CompactSummaryEnabled != nil || cmd.CompactMemoryEnabled != nil || cmd.ResolveSlash || cmd.ClientWorkspaceContext != nil || cmd.DeliveryId != "" {
			overrides = &session.PromptOverrides{
				Model:                    cmd.Model,
				MaxTurns:                 cmd.MaxTurns,
				MaxBudgetUsd:             cmd.MaxBudgetUsd,
				Extensions:               resolvedExts,
				NoExtensions:             cmd.NoExtensions,
				AppendSystemPrompt:       cmd.AppendSystemPrompt,
				Attachments:              cmd.Attachments,
				ImplementationPhase:      cmd.ImplementationPhase,
				ThinkingEffort:           cmd.ThinkingEffort,
				EnterPlanModeDescription: cmd.EnterPlanModeDescription,
				PlanModeSparseReminder:   cmd.PlanModeSparseReminder,
				PlanFilePath:             cmd.PlanFilePath,
				// Per-prompt bash-allowlist additions. Forwarded to
				// runloop_setup.buildToolDefs which unions them with the
				// session allowlist for this run only. See
				// docs/protocol/client-commands.md § set_plan_mode for the
				// three-layer configuration model (engine config → session
				// override → per-prompt additions).
				BashAllowlistAdditionsForThisPrompt: cmd.BashAllowlistAdditionsForThisPrompt,
				McpAllowlistAdditionsForThisPrompt:  cmd.McpAllowlistAdditionsForThisPrompt,
				CompactTargetPercent:                cmd.CompactTargetPercent,
				CompactMicroKeepTurns:               cmd.CompactMicroKeepTurns,
				CompactEnabled:                      cmd.CompactEnabled,
				CompactSummaryEnabled:               cmd.CompactSummaryEnabled,
				CompactMemoryEnabled:                cmd.CompactMemoryEnabled,
				ResolveSlash:                        cmd.ResolveSlash,
				ClientWorkspaceContext:              cmd.ClientWorkspaceContext,
				DeliveryId:                          cmd.DeliveryId,
			}
		}
		err = s.manager.SendPrompt(cmd.Key, cmd.Text, overrides)
		resultData := map[string]any{"accepted": err == nil, "alreadyAccepted": false}
		if err == nil {
			s.ownership.claim(conn, cmd.Key)
		}
		s.sendResult(conn, cmd, err, resultData)

	case "abort":
		// Fire-and-forget: no response sent (matches TS behavior).
		// An absent/unknown abortScope resolves to "all" inside the session
		// manager, so a client that predates the field is unaffected.
		scope := session.ParseAbortScope(cmd.AbortScope)
		utils.LogWithFields(utils.LevelInfo, "server", "abort", map[string]any{"session_id": cmd.Key, "abort_scope": string(scope)})
		s.manager.SendAbortScoped(cmd.Key, scope)

	case "abort_agent":
		// Compatibility command for name-addressed process handles. The empty-name
		// subtree form retains the historic full descendant reap behavior.
		subtree := cmd.Subtree != nil && *cmd.Subtree
		utils.LogWithFields(utils.LevelInfo, "server", "abort agent", map[string]any{"session_id": cmd.Key, "agent_name": cmd.AgentName, "subtree": subtree})
		s.manager.AbortAgent(cmd.Key, cmd.AgentName, subtree)

	case "abort_dispatch":
		// Fire-and-forget: no response sent (matches the abort
		// cases). AbortDispatch returns whether a live dispatch matched, and
		// both outcomes are logged so a stop that hit nothing is visible from
		// the logs alone (engine-grounding §7) — at parity with the
		// steer_agent delivered/not-delivered convention below.
		utils.LogWithFields(utils.LevelInfo, "server", "abort dispatch", map[string]any{"session_id": cmd.Key, "dispatch_id": cmd.DispatchID})
		if s.manager.AbortDispatch(cmd.Key, cmd.DispatchID, "user abort (dispatch)") {
			utils.LogWithFields(utils.LevelInfo, "server", "abort dispatch recalled", map[string]any{"session_id": cmd.Key, "dispatch_id": cmd.DispatchID})
		} else {
			utils.LogWithFields(utils.LevelWarn, "server", "abort dispatch found no live dispatch", map[string]any{"session_id": cmd.Key, "dispatch_id": cmd.DispatchID})
		}

	case "stop_background_task":
		outcome := tools.StopBackgroundTaskForOwner(cmd.Key, cmd.TaskID)
		utils.LogWithFields(utils.LevelInfo, "server", "stop background task", map[string]any{"session_id": cmd.Key, "task_id": cmd.TaskID, "outcome": outcome})
		s.sendResult(conn, cmd, nil, map[string]any{"status": outcome, "stopped": outcome == "stopped"})

	case "steer_agent":
		// Fire-and-forget: no response sent (matches TS behavior). SteerAgent
		// returns a typed outcome so the steer can never be silently dropped;
		// we log both the attempt and the resolved outcome (engine-grounding
		// §7), at parity with the abort/abort_agent cases above.
		utils.LogWithFields(utils.LevelInfo, "server", "steer agent", map[string]any{"session_id": cmd.Key, "model": cmd.AgentName, "count": len(cmd.Message), "client_message_id": cmd.ClientMessageID})
		outcome := s.manager.SteerAgentWithClientID(cmd.Key, cmd.AgentName, cmd.Message, "", cmd.ClientMessageID)
		if outcome.Delivered() {
			utils.LogWithFields(utils.LevelInfo, "server", "steer agent delivered", map[string]any{"session_id": cmd.Key, "model": cmd.AgentName, "status": outcome})
		} else {
			utils.LogWithFields(utils.LevelWarn, "server", "steer agent not delivered", map[string]any{"session_id": cmd.Key, "model": cmd.AgentName, "status": outcome})
		}

	case "dialog_response":
		// Fire-and-forget: no response sent (matches TS behavior).
		s.manager.SendDialogResponse(cmd.Key, cmd.DialogID, cmd.Value)

	case "command":
		// Fire-and-forget: no response sent (matches TS behavior).
		s.manager.SendCommand(cmd.Key, cmd.Command, cmd.Args)

	case "stop_session":
		err := s.manager.StopSession(cmd.Key)
		s.lanes.evictSession(cmd.Key)
		s.sendResult(conn, cmd, err, nil)

	case "settle_session":
		err := s.manager.SettleSession(cmd.Key)
		s.sendResult(conn, cmd, err, nil)

	case "resume_session":
		err := s.manager.ResumeSession(cmd.Key)
		s.sendResult(conn, cmd, err, nil)

	case "stop_by_prefix":
		s.manager.StopByPrefix(cmd.Prefix)
		s.lanes.evictByPrefix(cmd.Prefix)
		s.sendResult(conn, cmd, nil, nil)

	case "list_sessions":
		sessions := s.manager.ListSessions()
		infos := make([]protocol.SessionInfo, len(sessions))
		for i, si := range sessions {
			infos[i] = protocol.SessionInfo{
				Key:            si.Key,
				HasActiveRun:   si.HasActiveRun,
				ToolCount:      si.ToolCount,
				ConversationID: si.ConversationID,
			}
		}
		if cmd.RequestID != "" {
			// Return as result with requestId (TS parity).
			s.sendResult(conn, cmd, nil, infos)
		} else {
			line := protocol.SerializeServerSessionList(infos)
			s.writeToClient(conn, line)
		}

	case "fork_session":
		idx := 0
		if cmd.MessageIndex != nil {
			idx = *cmd.MessageIndex
		}
		newKey, err := s.manager.ForkSession(cmd.Key, idx)
		s.sendForkResult(conn, cmd, err, newKey)

	case "set_plan_mode":
		enabled := cmd.Enabled != nil && *cmd.Enabled
		// cmd.PlanFilePath is the client's persisted plan path. When enabling
		// plan mode on a session that lost its path (e.g. after a session
		// replacement), the manager restores it (if it exists on disk) so the
		// next prompt reuses the conversation's existing plan instead of
		// allocating a fresh slug. Empty for clients that do not track a path.
		if cmd.PlanFilePath != "" {
			utils.LogWithFields(utils.LevelInfo, "server", "set plan mode", map[string]any{"session_id": cmd.Key, "count": enabled, "path": cmd.PlanFilePath})
		}
		s.manager.SetPlanMode(cmd.Key, enabled, cmd.AllowedTools, cmd.Source, cmd.PlanFilePath)
		// Tri-valued PlanModeAllowedBashCommands per the protocol doc:
		//   - nil   (JSON omitted): no change to existing allowlist
		//   - []    (JSON []):      clear allowlist
		//   - [...] (non-empty):    replace allowlist
		// Go's JSON decoder preserves the nil-vs-empty distinction on
		// []string fields with omitempty, so this guard distinguishes
		// "field absent" from "field present as []" without any new
		// wire surface.
		if cmd.PlanModeAllowedBashCommands != nil {
			s.manager.SetPlanModeBashAllowlist(cmd.Key, cmd.PlanModeAllowedBashCommands)
		}
		if cmd.PlanModeAllowedMcpTools != nil {
			s.manager.SetPlanModeMcpAllowlist(cmd.Key, cmd.PlanModeAllowedMcpTools)
		}
		s.sendResult(conn, cmd, nil, nil)

	case "branch":
		err := s.manager.BranchSession(cmd.Key, cmd.EntryID)
		s.sendResult(conn, cmd, err, nil)

	case "branch_before":
		// Tree-native rewind: move the leaf to the PARENT of the given entry
		// so the next prompt replaces that entry on the active path (a new
		// sibling branch) instead of chaining after the old leaf and
		// duplicating the turn.
		err := s.manager.BranchSessionBefore(cmd.Key, cmd.EntryID)
		s.sendResult(conn, cmd, err, nil)

	case "rewind_session":
		// Exact-entry-addressed tree-native rewind takes priority when the
		// client supplies EntryID (learned from a prior engine_steer_injected
		// confirmation, or from loaded conversation history): the engine
		// validates it names a genuine user turn on the CURRENT context path
		// before branching, rather than trusting a client-computed ordinal
		// that can point at the wrong turn once a queued-but-undelivered
		// steer occupies a row position with no corresponding tree entry.
		// Falls back to the legacy ordinal-addressed path when EntryID is
		// absent, for older clients and external SDK consumers.
		var err error
		if cmd.EntryID != "" {
			err = s.manager.RewindSessionToEntry(cmd.Key, cmd.EntryID)
		} else {
			idx := 0
			if cmd.UserTurnIndex != nil {
				idx = *cmd.UserTurnIndex
			}
			err = s.manager.RewindSession(cmd.Key, idx)
		}
		s.sendResult(conn, cmd, err, nil)

	case "navigate_tree":
		err := s.manager.NavigateSession(cmd.Key, cmd.TargetID)
		s.sendResult(conn, cmd, err, nil)

	case "get_tree":
		tree := s.manager.GetSessionTree(cmd.Key)
		s.sendResult(conn, cmd, nil, tree)

	case "permission_response":
		// Fire-and-forget: no response sent (matches dialog_response pattern).
		s.manager.SendPermissionResponse(cmd.Key, cmd.QuestionID, cmd.OptionID)

	case "tool_gate_response":
		// Fire-and-forget: no response sent. Resolves a pending client
		// tool-gate request (engine_tool_gate_request) so the blocked tool
		// call proceeds with the client's decision (policy kind) or result
		// (tool kind). The tool loop has its own bounded timeout with a
		// client-declared fallback, so a missing or late response is
		// non-fatal — it is logged and dropped.
		s.manager.HandleToolGateResponse(cmd.Key, cmd.GateRequestID, cmd.GateDecision, cmd.GateReason, cmd.GateContent, cmd.GateIsError)

	case "elicitation_response":
		// Fire-and-forget: no response sent. Resolves a pending elicitation
		// raised by ion.elicit() / ctx.Elicit() so the extension Promise resolves.
		s.manager.HandleElicitationResponse(cmd.Key, cmd.ElicitRequestID, cmd.ElicitResponse, cmd.ElicitCancelled, cmd.ElicitDeclined)

	case "early_stop_decision_response":
		// Fire-and-forget: no response sent. Resolves a pending early-stop
		// wire-protocol request so the blocked agent loop proceeds with the
		// supplied decision. The runloop has its own short timeout, so a
		// missing response is non-fatal — it just means the engine falls
		// through to its existing merge logic (typically: no continuation).
		s.manager.HandleEarlyStopDecisionResponse(
			cmd.Key,
			cmd.EarlyStopRequestID,
			cmd.EarlyStopForceContinue,
			cmd.EarlyStopOverrideBudget,
			cmd.EarlyStopOverrideThresholdPct,
			cmd.EarlyStopContinueMessage,
		)

	case "list_stored_sessions":
		limit := cmd.Limit
		if limit <= 0 {
			limit = 50
		}
		results, err := conversation.ListStored("", limit)
		s.sendResult(conn, cmd, err, results)

	case "load_session_history":
		var messages []types.SessionMessage
		var err error
		if len(cmd.SessionIDs) > 0 {
			messages, err = conversation.LoadChainMessages(cmd.SessionIDs, "")
		} else {
			messages, err = conversation.LoadMessages(cmd.Key, "")
		}
		s.sendResult(conn, cmd, err, messages)

	case "save_session_label":
		// Serialized read-modify-write: a label append racing a dispatch
		// record append would otherwise drop whichever save landed first.
		err := conversation.UpdateOnDisk(cmd.Key, "", func(conv *conversation.Conversation) (bool, error) {
			conversation.AddLabelEntry(conv, cmd.Label)
			return true, nil
		})
		s.sendResult(conn, cmd, err, nil)

	case "get_conversation":
		limit := cmd.Limit
		// limit == 0 (or negative) means unbounded: return all messages from
		// offset onward. LoadMessagesPaginated already implements this
		// semantics (limit <= 0 → no page cap), so we pass limit through
		// unchanged. Previously this handler clamped limit <= 0 to 50, which
		// silently truncated callers that passed 0 to mean "all" (e.g. the
		// desktop relay handler for iOS dispatch history). Wire behavior
		// change approved: 0-means-all is additive and consumer-friendly.
		if limit < 0 {
			limit = 0
		}
		offset := cmd.Offset
		if offset < 0 {
			offset = 0
		}
		if limit == 0 {
			utils.LogWithFields(utils.LevelInfo, "server", "get conversation unbounded", map[string]any{"session_id": cmd.Key, "count": offset})
		} else {
			utils.LogWithFields(utils.LevelInfo, "server", "get conversation", map[string]any{"session_id": cmd.Key, "count": offset, "max": limit})
		}
		result, err := conversation.LoadMessagesPaginated(cmd.Key, "", offset, limit)
		s.sendResult(conn, cmd, err, result)

	case "generate_title":
		// Implementation in dispatch_data.go.
		s.dispatchGenerateTitle(conn, cmd)

	case "reconcile_state":
		s.manager.ReconcileState(cmd.Key)
		s.sendResult(conn, cmd, nil, nil)

	case "query_session_status":
		// Phase 2: on-demand engine_status snapshot. The status payload
		// is emitted via the manager's normal event bus (not as the RPC
		// result) so it reaches every attached consumer, not just the
		// one that asked. The RPC result is empty — the caller subscribes
		// via OnEvent / the WebSocket stream and observes the emission
		// through that channel.
		s.manager.QuerySessionStatus(cmd.Key)
		s.sendResult(conn, cmd, nil, nil)

	case "resolve_permission_denials":
		// The consumer resolved a pending AskUserQuestion / ExitPlanMode by
		// its own means (typically the user dismissed the card), which
		// produces neither a prompt nor a /clear — the only two events that
		// previously released the engine's retention. Drop the retention so
		// subsequent status snapshots stop re-publishing a question nobody is
		// waiting on. The resulting snapshot is emitted on the manager's event
		// bus, so every attached consumer converges, not just this caller.
		s.manager.ResolvePermissionDenials(cmd.Key)
		s.sendResult(conn, cmd, nil, nil)

	case "get_agent_state":
		// Full fidelity is explicit and request-driven. Return it to this
		// connection only: broadcasting a 35 MB response would recreate the
		// fan-out the bounded engine_agent_state snapshot prevents.
		s.sendResult(conn, cmd, nil, protocol.AgentStateResponse{Agents: s.manager.GetAgentState(cmd.Key)})

	case "get_context_breakdown":
		// On-demand context breakdown. Reconstructs the full assembly
		// pipeline (system prompt + tools + conversation) outside any
		// active run and emits engine_context_breakdown via the normal event bus.
		// Provider-native token counting may take many seconds, so acknowledge and
		// launch it asynchronously. A synchronous call here blocks this connection's
		// socket read loop, delaying commands queued behind it (including /clear).
		// RPC result is empty; caller observes breakdown on event stream.
		utils.LogWithFields(utils.LevelInfo, "server", "get context breakdown queued", map[string]any{"session_id": cmd.Key})
		s.sendResult(conn, cmd, nil, nil)
		s.startContextBreakdown(cmd.Key)

	case "migrate_conversation":
		// Implementation in dispatch_data.go.
		s.dispatchMigrateConversation(conn, cmd)

	case "list_models":
		// Implementation in dispatch_data.go.
		s.dispatchListModels(conn, cmd)

	case "resolve_model_tier":
		s.dispatchResolveModelTier(conn, cmd)

	case "list_model_tiers":
		s.dispatchListModelTiers(conn, cmd)

	case "set_model_tier":
		s.dispatchSetModelTier(conn, cmd)

	case "remove_model_tier":
		s.dispatchRemoveModelTier(conn, cmd)

	case "get_host_info":
		s.sendResult(conn, cmd, nil, computeHostInfo())

	case "list_directory":
		data, err := listDirectory(cmd.Path, cmd.ShowHidden)
		s.sendResult(conn, cmd, err, data)

	case "discover_slash_commands":
		// Stateless filesystem discovery of .md/skill templates. cmd.Path carries
		// the working directory (optional); user-level roots always apply. The
		// optional cmd.Config carries claudeCompat — when set false (or absent),
		// the engine skips the .claude / ~/.claude roots, matching the
		// resolution + skill-loading gates. The engine holds no opinion on the
		// flag; it honors what the consumer hands it.
		claudeCompat := false
		if cmd.Config != nil {
			claudeCompat = cmd.Config.ClaudeCompat
		}
		listings := s.manager.DiscoverSlashCommands(cmd.Path, claudeCompat)
		s.sendResult(conn, cmd, nil, listings)

	case "store_credential":
		if s.authResolver == nil {
			s.sendResult(conn, cmd, fmt.Errorf("auth resolver not configured"), nil)
			break
		}
		fs := auth.NewFileStore()
		if cmd.Credential == "" {
			// Empty credential means "clear this key"
			if err := fs.DeleteKey(cmd.Provider); err != nil {
				// A failed delete means the key persists while the user is told
				// it was cleared — this must not be silent.
				utils.LogWithFields(utils.LevelError, "server", "credential delete failed", map[string]any{"provider": cmd.Provider, "error": err.Error()})
			}
			providers.SetProviderKey(cmd.Provider, "")
		} else {
			if err := fs.SetKey(cmd.Provider, cmd.Credential); err != nil {
				s.sendResult(conn, cmd, err, nil)
				break
			}
			providers.SetProviderKey(cmd.Provider, cmd.Credential)
			// Trigger model discovery for the newly-authed provider so its
			// models appear in the picker without requiring an engine restart.
			providerConfigs := make(map[string]types.ProviderConfig)
			if s.config != nil {
				providerConfigs = s.config.Providers
			}
			providers.DiscoverProvider(cmd.Provider, cmd.Credential, providerConfigs)
		}
		s.sendResult(conn, cmd, nil, nil)

	case "oidc_begin_login":
		s.dispatchOidcBeginLogin(conn, cmd)

	case "oidc_logout":
		s.dispatchOidcLogout(conn, cmd)

	case "oidc_identity":
		s.dispatchOidcIdentity(conn, cmd)

	case "oidc_token":
		s.dispatchOidcToken(conn, cmd)

	case "mcp_list":
		s.dispatchMcpList(conn, cmd)

	case "mcp_add":
		s.dispatchMcpAdd(conn, cmd)

	case "mcp_remove":
		s.dispatchMcpRemove(conn, cmd)

	case "mcp_login":
		s.dispatchMcpLogin(conn, cmd)

	case "mcp_logout":
		s.dispatchMcpLogout(conn, cmd)

	case "provider_login":
		s.dispatchProviderLogin(conn, cmd)

	case "provider_login_cancel":
		s.dispatchProviderLoginCancel(conn, cmd)

	case "provider_login_code":
		s.dispatchProviderLoginCode(conn, cmd)

	case "provider_logout":
		s.dispatchProviderLogout(conn, cmd)

	case "refresh_models":
		providerConfigs := make(map[string]types.ProviderConfig)
		if s.config != nil {
			providerConfigs = s.config.Providers
		}
		var resolveKey func(string) (string, error)
		if s.authResolver != nil {
			resolveKey = s.authResolver.ResolveKey
		} else {
			resolveKey = func(string) (string, error) { return "", nil }
		}
		// Provider field is optional: empty = refresh all
		providers.RefreshModels(cmd.Provider, true, resolveKey, providerConfigs)
		// Re-probe the delegated CLIs too, so their install/auth state and
		// model lists refresh alongside the HTTP providers.
		s.RefreshProviderProbes()
		s.sendResult(conn, cmd, nil, nil)

	case "clear_conversation_file":
		// Wipes the LLM-visible message history for a stored conversation
		// without requiring a live engine session. Used by consumers that
		// need to reset a conversation file by id when no session is running
		// against it (e.g. a tab that was loaded from disk but never sent a
		// prompt, so no in-memory session exists to receive a dispatchClear).
		// The key field carries the conversationId (sessionId) to wipe.
		utils.LogWithFields(utils.LevelInfo, "server", "clear conversation file", map[string]any{"session_id": cmd.Key})
		err := s.manager.ClearConversationFile(cmd.Key)
		s.sendResult(conn, cmd, err, nil)

	case "delete_stored_conversations":
		activeSessions := s.manager.ListSessions()
		activeIDs := make([]string, 0, len(activeSessions))
		for _, session := range activeSessions {
			if session.ConversationID != "" {
				activeIDs = append(activeIDs, session.ConversationID)
			}
		}
		utils.LogWithFields(utils.LevelInfo, "server", "delete stored conversations", map[string]any{"requested_count": len(cmd.SessionIDs), "active_count": len(activeIDs)})
		deleted, err := conversation.DeleteStoredExact("", cmd.SessionIDs, activeIDs)
		s.sendResult(conn, cmd, err, map[string]int{"deleted": deleted})

	case "delete_stored_sessions":
		maxAge := cmd.MaxAgeDays
		if maxAge <= 0 {
			maxAge = 14
		}
		// Server-side safety guard: collect conversation IDs from all active
		// in-memory sessions so they are never deleted, independent of the
		// client's excludeIDs list.
		activeSessions := s.manager.ListSessions()
		inMemoryActiveIDs := make([]string, 0, len(activeSessions))
		for _, si := range activeSessions {
			if si.ConversationID != "" {
				inMemoryActiveIDs = append(inMemoryActiveIDs, si.ConversationID)
			}
		}

		// Layer-1 expansion (docs/plans/grassy-chirping-crest.md):
		// the desktop's in-process startSession is lazy — it only fires when
		// the user sends the first prompt to a tab. After an engine restart
		// (or in the first 60 seconds before any prompt is sent), the engine
		// has zero in-memory sessions even though the desktop may have 60+
		// persisted tabs whose conversationIds need protection.
		//
		// Read the desktop's session-chains / session-labels files
		// directly (the unified names plus the legacy per-backend
		// twins). Every ID that appears in any of those files is a
		// conversation some tab has resumed or labeled — load-bearing
		// IDs that must survive cleanup even when cmd.ExcludeIDs is
		// empty.
		//
		// Pass "" so the helper resolves ~/.ion/. Reading these files is
		// always safe: missing files contribute zero IDs, malformed JSON
		// is logged and skipped.
		desktopProtectedIDs := loadDesktopProtectedIDs("")

		// Union the two sources into a single activeIDs slice. Dedup
		// happens inside CleanupStored via the exclude map.
		activeIDs := make([]string, 0, len(inMemoryActiveIDs)+len(desktopProtectedIDs))
		activeIDs = append(activeIDs, inMemoryActiveIDs...)
		activeIDs = append(activeIDs, desktopProtectedIDs...)

		utils.LogWithFields(utils.LevelInfo, "server", "delete stored sessions", map[string]any{
			"count": len(cmd.ExcludeIDs), "turn": len(inMemoryActiveIDs), "max": len(desktopProtectedIDs),
		})

		deleted, err := conversation.CleanupStored("", maxAge, cmd.ExcludeIDs, activeIDs, cmd.DryRun)
		s.sendResult(conn, cmd, err, map[string]int{"deleted": deleted})

	case "resource_subscribe":
		s.dispatchResourceSubscribe(conn, cmd)

	case "resource_unsubscribe":
		s.dispatchResourceUnsubscribe(conn, cmd)

	case "resource_publish":
		s.dispatchResourcePublish(conn, cmd)

	case "resource_get":
		s.dispatchResourceGet(conn, cmd)

	case "get_enterprise_policy":
		// Full enterprise policy passthrough (D-004). The engine is the
		// single authoritative reader of MDM/system-level config sources
		// (registry, plist, env, drop-ins); clients receive the merged
		// EnterpriseConfig here instead of parsing OS-specific sources
		// themselves. The blob is a DUMB passthrough: client-specific
		// configuration lives under customFields keyed by convention
		// (e.g. customFields["ion-desktop"]) and the engine neither
		// validates nor interprets it — ownership of those keys is the
		// client's. newConversationDefaults stays duplicated as a
		// top-level key for consumers built against the original
		// single-policy response shape (additive evolution: existing
		// decoders keep working, new consumers read the full policy).
		var newConversationDefaults interface{}
		var enterprisePolicy interface{}
		if s.config != nil && s.config.Enterprise != nil {
			enterprisePolicy = s.config.Enterprise
			if s.config.Enterprise.NewConversationDefaults != nil {
				newConversationDefaults = s.config.Enterprise.NewConversationDefaults
			}
		}
		s.sendResult(conn, cmd, nil, map[string]interface{}{
			"newConversationDefaults": newConversationDefaults,
			"policy":                  enterprisePolicy,
		})

	case "get_plan_content":
		// Implementation in dispatch_plan_content.go.
		s.dispatchGetPlanContent(conn, cmd)

	case "shutdown":
		// dispatch runs inside a command-lane worker. Stop waits for those workers,
		// so calling it here would wait for this dispatch to return and deadlock.
		// Starting shutdown separately lets this command complete before Stop joins
		// the lanes.
		go func() {
			if err := s.Stop(); err != nil {
				utils.LogWithFields(utils.LevelInfo, "server", "shutdown stop returned error", map[string]any{"error": err.Error()})
			}
		}()

	case "plugin_install":
		utils.LogWithFields(utils.LevelInfo, "server", "plugin install", map[string]any{"source": cmd.Source})
		p, err := plugins.Install(cmd.Source, nil)
		if err != nil {
			s.sendResult(conn, cmd, err, nil)
			return
		}
		s.sendResult(conn, cmd, nil, map[string]any{
			"name":    p.Name,
			"source":  p.Source,
			"version": p.Version,
		})

	case "plugin_list":
		installed, err := plugins.ListInstalled()
		if err != nil {
			s.sendResult(conn, cmd, err, nil)
			return
		}
		var infos []map[string]any
		for _, p := range installed {
			infos = append(infos, map[string]any{
				"name":        p.Name,
				"source":      p.Source,
				"version":     p.Version,
				"installedAt": p.InstalledAt,
			})
		}
		s.sendResult(conn, cmd, nil, infos)

	case "plugin_remove":
		utils.LogWithFields(utils.LevelInfo, "server", "plugin remove", map[string]any{"name": cmd.Label})
		if err := plugins.Remove(cmd.Label); err != nil {
			s.sendResult(conn, cmd, err, nil)
			return
		}
		s.sendResult(conn, cmd, nil, map[string]any{"removed": cmd.Label})
	case "health":
		type healthResult struct {
			data map[string]interface{}
		}
		ch := make(chan healthResult, 1)
		go func() {
			ch <- healthResult{data: s.healthSnapshot()}
		}()
		select {
		case r := <-ch:
			s.sendResult(conn, cmd, nil, r.data)
		case <-time.After(5 * time.Second):
			s.sendResult(conn, cmd, nil, map[string]interface{}{
				"ok":    false,
				"error": "health snapshot timed out",
			})
		}

	default:
		utils.LogWithFields(utils.LevelWarn, "server", "unknown command", map[string]any{"status": cmd.Cmd})
		s.sendResult(conn, cmd, fmt.Errorf("unknown command: %s", cmd.Cmd), nil)
	}
}
