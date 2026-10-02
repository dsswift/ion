package extcontext

import (
	"errors"

	"github.com/dsswift/ion/engine/internal/conversation"
	"github.com/dsswift/ion/engine/internal/extension"
	"github.com/dsswift/ion/engine/internal/types"
	"github.com/dsswift/ion/engine/internal/utils"
)

// BuildReadDispatchConversationFunc returns the Context.ReadDispatchConversation
// implementation for the context owned by ownerDispatchID (empty for the root
// context). Authorization is settled against the registry before the
// conversation store is touched, so a refused read opens no file.
//
// Page bounds come from the engine config's dispatchConversationRead block,
// read on every call.
func BuildReadDispatchConversationFunc(sa SessionAccessor, registry *DispatchRegistry, ownerDispatchID string) func(extension.ReadDispatchConversationOpts) (*extension.DispatchConversationResult, error) {
	return func(opts extension.ReadDispatchConversationOpts) (*extension.DispatchConversationResult, error) {
		fields := map[string]any{
			"owner_dispatch_id": ownerDispatchID, "conversation_id": opts.ConversationID, "dispatch_id": opts.DispatchID,
		}
		owned, ok := registry.ResolveOwnedConversation(ownerDispatchID, opts.ConversationID, opts.DispatchID)
		if !ok {
			utils.LogWithFields(utils.LevelInfo, "session.extcontext", "dispatch conversation read: unauthorized", fields)
			return &extension.DispatchConversationResult{Outcome: extension.DispatchConversationUnauthorized}, nil
		}

		result := &extension.DispatchConversationResult{
			ConversationID: owned.ConversationID,
			DispatchID:     owned.DispatchID,
			AgentName:      owned.Name,
			Status:         owned.Status,
			Terminal:       owned.Terminal,
			Reason:         owned.Reason,
			ExitCode:       owned.ExitCode,
		}
		fields["resolved_dispatch_id"] = owned.DispatchID
		fields["status"] = owned.Status
		if owned.ConversationID == "" {
			utils.LogWithFields(utils.LevelInfo, "session.extcontext", "dispatch conversation read: unavailable, no conversation created", fields)
			result.Outcome = extension.DispatchConversationUnavailable
			result.UnavailableReason = extension.DispatchConversationNotCreated
			return result, nil
		}
		fields["conversation_id"] = owned.ConversationID

		var configured *types.DispatchConversationReadConfig
		if cfg := sa.EngineConfig(); cfg != nil {
			configured = cfg.DispatchConversationRead
		}
		limits := configured.Resolved()
		maxEntries, maxBytes := limits.Clamp(opts.Limit, opts.MaxBytes)
		page, err := conversation.ReadTranscriptPage(owned.ConversationID, "", conversation.TranscriptPageRequest{
			Cursor: opts.Cursor, MaxEntries: maxEntries, MaxBytes: maxBytes,
		})
		switch {
		case errors.Is(err, conversation.ErrNotFound):
			utils.LogWithFields(utils.LevelInfo, "session.extcontext", "dispatch conversation read: unavailable, conversation not in store", fields)
			result.Outcome = extension.DispatchConversationUnavailable
			result.UnavailableReason = extension.DispatchConversationNotFound
			return result, nil
		case errors.Is(err, conversation.ErrInvalidCursor):
			utils.LogWithFields(utils.LevelInfo, "session.extcontext", "dispatch conversation read: invalid cursor", fields)
			result.Outcome = extension.DispatchConversationInvalidCursor
			return result, nil
		case err != nil:
			fields["error"] = err.Error()
			utils.LogWithFields(utils.LevelError, "session.extcontext", "dispatch conversation read: load failed", fields)
			return nil, err
		}

		result.Outcome = extension.DispatchConversationOK
		result.Entries = page.Entries
		result.NextCursor = page.NextCursor
		result.HasMore = page.HasMore
		result.TotalEntries = page.TotalEntries
		result.Limits = &extension.DispatchConversationLimits{
			Entries: maxEntries, Bytes: maxBytes, MaxEntries: limits.MaxEntries, MaxBytes: limits.MaxBytes,
		}
		fields["count"] = len(page.Entries)
		fields["bytes"] = page.Bytes
		fields["has_more"] = page.HasMore
		utils.LogWithFields(utils.LevelInfo, "session.extcontext", "dispatch conversation read: ok", fields)
		return result, nil
	}
}
