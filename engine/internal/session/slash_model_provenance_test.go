package session

import (
	"testing"

	"github.com/dsswift/ion/engine/internal/types"
)

// TestTranslateUserTurnPersisted_SlashModelProvenance pins the wire contract:
// UserTurnPersistedEvent model provenance fields must arrive on the
// corresponding EngineEvent wire fields.
func TestTranslateUserTurnPersisted_SlashModelProvenance(t *testing.T) {
	t.Run("both fields present", func(t *testing.T) {
		ev := types.NormalizedEvent{Data: &types.UserTurnPersistedEvent{
			EntryID:             "entry-1",
			SlashModelAlias:     "claude-sonnet",
			SlashModelEffective: "claude-sonnet-4-20250514",
		}}
		eng := translateToEngineEvent(ev, 200000)

		if eng.UserTurnEntryID != "entry-1" {
			t.Errorf("UserTurnEntryID = %q, want %q", eng.UserTurnEntryID, "entry-1")
		}
		if eng.UserTurnSlashModelAlias != "claude-sonnet" {
			t.Errorf("UserTurnSlashModelAlias = %q, want %q", eng.UserTurnSlashModelAlias, "claude-sonnet")
		}
		if eng.UserTurnSlashModelEffective != "claude-sonnet-4-20250514" {
			t.Errorf("UserTurnSlashModelEffective = %q, want %q", eng.UserTurnSlashModelEffective, "claude-sonnet-4-20250514")
		}
	})

	t.Run("empty when non-slash turn", func(t *testing.T) {
		ev := types.NormalizedEvent{Data: &types.UserTurnPersistedEvent{
			EntryID: "entry-2",
		}}
		eng := translateToEngineEvent(ev, 200000)

		if eng.UserTurnSlashModelAlias != "" {
			t.Errorf("UserTurnSlashModelAlias = %q, want empty", eng.UserTurnSlashModelAlias)
		}
		if eng.UserTurnSlashModelEffective != "" {
			t.Errorf("UserTurnSlashModelEffective = %q, want empty", eng.UserTurnSlashModelEffective)
		}
	})

	t.Run("alias without effective", func(t *testing.T) {
		ev := types.NormalizedEvent{Data: &types.UserTurnPersistedEvent{
			EntryID:         "entry-3",
			SlashModelAlias: "fast-model",
		}}
		eng := translateToEngineEvent(ev, 200000)

		if eng.UserTurnSlashModelAlias != "fast-model" {
			t.Errorf("UserTurnSlashModelAlias = %q, want %q", eng.UserTurnSlashModelAlias, "fast-model")
		}
		if eng.UserTurnSlashModelEffective != "" {
			t.Errorf("UserTurnSlashModelEffective = %q, want empty", eng.UserTurnSlashModelEffective)
		}
	})
}

// TestApplySlashModelHint verifies production hint capture semantics. Effective
// model is intentionally stamped later by SendPrompt after tier resolution.
func TestApplySlashModelHint(t *testing.T) {
	t.Run("frontmatter model applied when no explicit override", func(t *testing.T) {
		opts := &types.RunOptions{
			Prompt: "/test-cmd",
		}
		applySlashModelHint(opts, "claude-sonnet")

		if opts.ResolvedSlashModelAlias != "claude-sonnet" {
			t.Errorf("ResolvedSlashModelAlias = %q, want %q", opts.ResolvedSlashModelAlias, "claude-sonnet")
		}
		if opts.Model != "claude-sonnet" {
			t.Errorf("Model = %q, want %q (frontmatter should apply)", opts.Model, "claude-sonnet")
		}
		if opts.ResolvedSlashModelEffective != "" {
			t.Errorf("ResolvedSlashModelEffective = %q, want empty before tier resolution", opts.ResolvedSlashModelEffective)
		}
	})

	t.Run("explicit per-prompt override wins over frontmatter", func(t *testing.T) {
		opts := &types.RunOptions{
			Prompt: "/test-cmd",
			Model:  "claude-opus",
		}
		applySlashModelHint(opts, "claude-sonnet")

		if opts.ResolvedSlashModelAlias != "claude-sonnet" {
			t.Errorf("ResolvedSlashModelAlias = %q, want %q", opts.ResolvedSlashModelAlias, "claude-sonnet")
		}
		if opts.Model != "claude-opus" {
			t.Errorf("Model = %q, want %q (explicit override should win)", opts.Model, "claude-opus")
		}
		if opts.ResolvedSlashModelEffective != "" {
			t.Errorf("ResolvedSlashModelEffective = %q, want empty before final resolution", opts.ResolvedSlashModelEffective)
		}
	})

	t.Run("no frontmatter model", func(t *testing.T) {
		opts := &types.RunOptions{
			Prompt: "/test-cmd",
			Model:  "claude-opus",
		}
		applySlashModelHint(opts, "")

		if opts.ResolvedSlashModelAlias != "" {
			t.Errorf("ResolvedSlashModelAlias = %q, want empty", opts.ResolvedSlashModelAlias)
		}
		if opts.ResolvedSlashModelEffective != "" {
			t.Errorf("ResolvedSlashModelEffective = %q, want empty before final resolution", opts.ResolvedSlashModelEffective)
		}
	})

	t.Run("no model at all", func(t *testing.T) {
		opts := &types.RunOptions{
			Prompt: "/test-cmd",
		}
		applySlashModelHint(opts, "")

		if opts.ResolvedSlashModelAlias != "" {
			t.Errorf("ResolvedSlashModelAlias = %q, want empty", opts.ResolvedSlashModelAlias)
		}
		if opts.ResolvedSlashModelEffective != "" {
			t.Errorf("ResolvedSlashModelEffective = %q, want empty", opts.ResolvedSlashModelEffective)
		}
	})
}

func TestFinalizeSlashModelProvenance(t *testing.T) {
	opts := &types.RunOptions{
		Model:                   "dci-marketing/gpt-5.6-terra",
		ResolvedSlashModelAlias: "standard",
	}
	finalizeSlashModelProvenance(opts, "test-session")
	if opts.ResolvedSlashModelEffective != "dci-marketing/gpt-5.6-terra" {
		t.Fatalf("ResolvedSlashModelEffective = %q, want resolved concrete model", opts.ResolvedSlashModelEffective)
	}

	plain := &types.RunOptions{Model: "dci-marketing/claude-opus-5"}
	finalizeSlashModelProvenance(plain, "test-session")
	if plain.ResolvedSlashModelEffective != "" {
		t.Fatalf("plain prompt effective provenance = %q, want empty", plain.ResolvedSlashModelEffective)
	}
}
