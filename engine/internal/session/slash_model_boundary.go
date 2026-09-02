package session

import (
	"errors"

	"github.com/dsswift/ion/engine/internal/conversation"
	"github.com/dsswift/ion/engine/internal/extension"
	"github.com/dsswift/ion/engine/internal/types"
	"github.com/dsswift/ion/engine/internal/utils"
)

// slash_model_boundary.go decides whether a slash command's declared `model:`
// tier is allowed to select the serving model for this invocation.
//
// Why a command's tier is not always honored
//
// A provider prompt cache is keyed per exact model. Switching models
// mid-conversation therefore cannot reuse the cache: the entire conversation
// is re-sent as cache-creation input instead of being read back at the much
// cheaper cache-read rate. Measured on real conversations in this repo, a
// switch-back on a large conversation re-writes the whole history in a single
// turn, and the same tokens that would have cost the cache-read rate cost the
// cache-creation rate instead — an order-of-magnitude difference on that turn.
// This holds even when both models come from the same vendor: the cache is
// per-model, not per-account, so a Sonnet-to-Opus hop is no cheaper than a
// cross-vendor hop.
//
// A command that declares a tier is expressing "this work belongs on this
// class of model". That intent is valuable at a phase boundary — the first
// message of a conversation, where there is no history to re-send and the
// declaration protects the operator from running, say, a squash on a reasoning
// model. The same declaration is actively harmful mid-conversation, where it
// silently buys a full-history re-write to serve one turn.
//
// By default the engine honors a command tier only at a fresh boundary and
// retains the serving model otherwise, emitting a notice so the decision is
// never invisible. The mechanism is configurable per engine and per prompt,
// and `before_slash_model_boundary` gives each harness final say. The engine
// therefore owns the cache-aware boundary while consumers own the policy.

// slashModelDecision records what the boundary gate decided, so the caller can
// both act on it and report it without recomputing anything.
type slashModelDecision struct {
	// alias is the tier or model the command declared. Empty when the command
	// declared none, in which case the gate is a no-op.
	alias string
	// applied is true when the declared tier was allowed to select the model.
	applied bool
	// freshBoundary is true when the conversation held no model-visible
	// history at decision time. This is the reason `applied` is what it is.
	freshBoundary bool
}

// evaluateSlashModelBoundary decides whether the command-declared tier may
// select the model for this invocation. A fresh boundary always applies the
// tier. With existing history, engine config supplies the default, a per-prompt
// override may replace it, and before_slash_model_boundary has final say.
func (m *Manager) evaluateSlashModelBoundary(s *engineSession, key string, res *ResolvedSlash, opts *types.RunOptions) slashModelDecision {
	if res == nil || res.Model == "" {
		return slashModelDecision{}
	}

	fresh := m.conversationIsFreshBoundary(s, key)
	decision := slashModelDecision{alias: res.Model, applied: fresh, freshBoundary: fresh}
	if fresh {
		utils.LogWithFields(utils.LevelInfo, "session.slash", "command model tier applied at fresh boundary", map[string]any{
			"session_id": key, "model_alias": res.Model, "fresh_boundary": true, "source": "boundary",
		})
		return decision
	}

	source := "default"
	if m.config != nil && m.config.SlashModelTier != nil {
		decision.applied = m.config.SlashModelTier.ApplyMidConversation
		source = "config"
	}
	if opts != nil && opts.SlashModelTierApplyMidConversation != nil {
		decision.applied = *opts.SlashModelTierApplyMidConversation
		source = "prompt"
	}

	servingModel := m.slashBoundaryServingModel(s, opts)
	if s.extGroup != nil && !s.extGroup.IsEmpty() {
		ctx := m.newExtContext(s, key)
		result := s.extGroup.FireBeforeSlashModelBoundary(ctx, extension.SlashModelBoundaryInfo{
			Command:       res.Command,
			RequestedTier: res.Model,
			ServingModel:  servingModel,
			HasHistory:    true,
			DefaultApply:  decision.applied,
		})
		if result != nil && result.Apply != nil {
			decision.applied = *result.Apply
			source = "hook"
		}
	}

	utils.LogWithFields(utils.LevelInfo, "session.slash", "command model tier decision resolved", map[string]any{
		"session_id": key, "command": res.Command, "model_alias": res.Model,
		"serving_model": servingModel, "fresh_boundary": false,
		"applied": decision.applied, "source": source,
	})
	if !decision.applied && opts != nil && opts.Model == "" {
		opts.Model = servingModel
	}
	return decision
}

func (m *Manager) slashBoundaryServingModel(s *engineSession, opts *types.RunOptions) string {
	if opts != nil && opts.Model != "" {
		return opts.Model
	}
	if s != nil && s.lastModel != "" {
		return s.lastModel
	}
	if m.config != nil {
		return m.config.DefaultModel
	}
	return ""
}

// emitSlashModelTierIgnored publishes the typed notice for a command tier the
// boundary gate declined.
//
// This is the engine's complete fulfillment of its signaling obligation for
// this decision: one typed event, emitted once. The engine does not also
// annotate the prompt, inject a synthetic message, or alter the command body —
// doing so would force every consumer through one UI-shaped interpretation and
// would corrupt a headless pipeline that reads stream content as verbatim model
// output.
//
// No-op when the run carried no declined tier, so ordinary prompts and honored
// tiers emit nothing.
func (m *Manager) emitSlashModelTierIgnored(key string, opts *types.RunOptions) {
	if opts == nil || !opts.SlashModelTierIgnored {
		return
	}
	utils.LogWithFields(utils.LevelInfo, "session.slash", "emitting slash model tier ignored notice", map[string]any{
		"session_id": key, "command": opts.ResolvedSlashCommand,
		"model_alias": opts.ResolvedSlashModelAlias, "model": opts.Model,
	})
	m.emit(key, types.EngineEvent{
		Type:                    "engine_slash_model_tier_ignored",
		Command:                 opts.ResolvedSlashCommand,
		SlashModelTierRequested: opts.ResolvedSlashModelAlias,
		SlashModelTierServing:   opts.Model,
		EventMessage: "command tier " + opts.ResolvedSlashModelAlias +
			" not applied: switching models mid-conversation would re-send the whole conversation. Running on " + opts.Model + ".",
	})
}

// conversationIsFreshBoundary reports whether the session's conversation
// currently holds no model-visible history.
//
// A session with no bound conversation id has never persisted a turn, so it is
// fresh by definition. A conversation file that does not exist yet is the
// pre-minted-id case (an id allocated before the first prompt) and is equally
// fresh. Any other load failure is reported as not-fresh, per the conservative
// direction documented on evaluateSlashModelBoundary.
func (m *Manager) conversationIsFreshBoundary(s *engineSession, key string) bool {
	if s.conversationID == "" {
		utils.LogWithFields(utils.LevelDebug, "session.slash", "boundary check no conversation bound treating as fresh", map[string]any{"session_id": key})
		return true
	}

	conv, err := conversation.Load(s.conversationID, "")
	if err != nil {
		// ErrNotFound is the pre-minted-id case: the id exists but no turn has
		// been persisted against it, which is a genuine fresh boundary. Every
		// other error means the history is unknown, so decline the switch.
		if errors.Is(err, conversation.ErrNotFound) {
			utils.LogWithFields(utils.LevelDebug, "session.slash", "boundary check conversation file absent treating as fresh", map[string]any{
				"session_id": key, "conversation_id": s.conversationID,
			})
			return true
		}
		utils.LogWithFields(utils.LevelInfo, "session.slash", "boundary check load failed treating as having history", map[string]any{
			"session_id": key, "conversation_id": s.conversationID, "error": err,
		})
		return false
	}

	hasHistory := conversation.HasModelVisibleHistory(conv)
	utils.LogWithFields(utils.LevelDebug, "session.slash", "boundary check resolved", map[string]any{
		"session_id": key, "conversation_id": s.conversationID, "has_history": hasHistory,
	})
	return !hasHistory
}
