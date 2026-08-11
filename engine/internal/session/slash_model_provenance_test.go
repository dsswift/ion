package session

import (
	"os"
	"path/filepath"
	"testing"

	"github.com/dsswift/ion/engine/internal/extension"
	"github.com/dsswift/ion/engine/internal/providers"
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
		applySlashModelHint(opts, "claude-sonnet", false)

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

	t.Run("explicit per-prompt model wins over command frontmatter", func(t *testing.T) {
		opts := &types.RunOptions{
			Prompt: "/test-cmd",
			Model:  "claude-opus",
		}
		applySlashModelHint(opts, "claude-sonnet", true)

		if opts.ResolvedSlashModelAlias != "claude-sonnet" {
			t.Errorf("ResolvedSlashModelAlias = %q, want %q", opts.ResolvedSlashModelAlias, "claude-sonnet")
		}
		if opts.Model != "claude-opus" {
			t.Errorf("Model = %q, want %q (explicit per-prompt override must win)", opts.Model, "claude-opus")
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
		applySlashModelHint(opts, "", false)

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
		applySlashModelHint(opts, "", false)

		if opts.ResolvedSlashModelAlias != "" {
			t.Errorf("ResolvedSlashModelAlias = %q, want empty", opts.ResolvedSlashModelAlias)
		}
		if opts.ResolvedSlashModelEffective != "" {
			t.Errorf("ResolvedSlashModelEffective = %q, want empty", opts.ResolvedSlashModelEffective)
		}
	})
}

func TestSlashModelProvenance_PromptPrecedence(t *testing.T) {
	workingDir := t.TempDir()
	commandsDir := filepath.Join(workingDir, ".ion", "commands")
	if err := os.MkdirAll(commandsDir, 0o755); err != nil {
		t.Fatalf("MkdirAll: %v", err)
	}
	if err := os.WriteFile(filepath.Join(commandsDir, "tier.md"), []byte("---\nmodel: standard\n---\ninspect $ARGUMENTS"), 0o600); err != nil {
		t.Fatalf("WriteFile: %v", err)
	}

	mb := newMockBackend()
	mgr := NewManager(mb)
	mgr.SetConfig(&types.EngineRuntimeConfig{DefaultModel: "standard"})
	if _, err := mgr.StartSession("slash-model", types.EngineConfig{ProfileID: "test", WorkingDirectory: workingDir}); err != nil {
		t.Fatalf("StartSession: %v", err)
	}

	if err := mgr.SendPrompt("slash-model", "/tier explicit", &PromptOverrides{Model: "explicit-model", ResolveSlash: true}); err != nil {
		t.Fatalf("SendPrompt explicit: %v", err)
	}
	mgr.mu.RLock()
	explicitRun := mgr.sessions["slash-model"].requestID
	mgr.mu.RUnlock()
	explicit, ok := mb.getStarted(explicitRun)
	if !ok {
		t.Fatal("explicit prompt never reached backend")
	}
	if explicit.Model != "explicit-model" {
		t.Fatalf("explicit prompt model = %q, want explicit-model", explicit.Model)
	}
	if explicit.ResolvedSlashModelAlias != "standard" || explicit.ResolvedSlashModelEffective != "explicit-model" {
		t.Fatalf("explicit provenance = (%q, %q), want (standard, explicit-model)", explicit.ResolvedSlashModelAlias, explicit.ResolvedSlashModelEffective)
	}

	mgr.handleRunExit(explicitRun, intPtr(0), nil, "")
	mgr.mu.Lock()
	mgr.sessions["slash-model"].lastModel = "previous-conversation-model"
	mgr.mu.Unlock()
	if err := mgr.SendPrompt("slash-model", "/tier continuity", &PromptOverrides{ResolveSlash: true}); err != nil {
		t.Fatalf("SendPrompt frontmatter: %v", err)
	}
	mgr.mu.RLock()
	frontmatterRun := mgr.sessions["slash-model"].requestID
	mgr.mu.RUnlock()
	frontmatter, ok := mb.getStarted(frontmatterRun)
	if !ok {
		t.Fatal("frontmatter prompt never reached backend")
	}
	if frontmatter.Model != "standard" {
		t.Fatalf("frontmatter prompt model = %q, want standard", frontmatter.Model)
	}
	if frontmatter.ResolvedSlashModelAlias != "standard" || frontmatter.ResolvedSlashModelEffective != "standard" {
		t.Fatalf("frontmatter provenance = (%q, %q), want (standard, standard)", frontmatter.ResolvedSlashModelAlias, frontmatter.ResolvedSlashModelEffective)
	}
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

func TestNormalizeSlashThinkingForResolvedModel(t *testing.T) {
	register := func(id, mode string, efforts []string) {
		providers.RegisterModel(id, types.ModelInfo{ThinkingMode: mode, ThinkingEfforts: efforts})
		t.Cleanup(func() { providers.UnregisterModel(id) })
	}

	t.Run("adaptive is cleared for an effort model", func(t *testing.T) {
		register("slash-effort", "reasoning_effort", []string{"low"})
		opts := &types.RunOptions{
			Model: "slash-effort", ResolvedSlashModelAlias: "standard",
			Thinking: &types.ThinkingConfig{Enabled: true},
		}
		normalizeSlashThinkingForResolvedModel(opts, &PromptOverrides{ThinkingEffort: types.ThinkingEffortAdaptive})
		if opts.Thinking != nil || !opts.ThinkingCleared {
			t.Fatalf("thinking = %+v, cleared = %t; want cleared unsupported adaptive effort", opts.Thinking, opts.ThinkingCleared)
		}
	})

	t.Run("adaptive remains enabled for an adaptive model", func(t *testing.T) {
		register("slash-adaptive", "adaptive", []string{"low", "high"})
		opts := &types.RunOptions{
			Model: "slash-adaptive", ResolvedSlashModelAlias: "standard",
			Thinking: &types.ThinkingConfig{Enabled: true},
		}
		normalizeSlashThinkingForResolvedModel(opts, &PromptOverrides{ThinkingEffort: types.ThinkingEffortAdaptive})
		if opts.Thinking == nil || opts.ThinkingCleared {
			t.Fatalf("thinking = %+v, cleared = %t; want adaptive thinking retained", opts.Thinking, opts.ThinkingCleared)
		}
	})

	t.Run("unsupported level is cleared for final tier model", func(t *testing.T) {
		register("slash-low-only", "reasoning_effort", []string{"low"})
		opts := &types.RunOptions{
			Model: "slash-low-only", ResolvedSlashModelAlias: "fast",
			Thinking: &types.ThinkingConfig{Enabled: true, Effort: "high"},
		}
		normalizeSlashThinkingForResolvedModel(opts, &PromptOverrides{ThinkingEffort: "high"})
		if opts.Thinking != nil || !opts.ThinkingCleared {
			t.Fatalf("thinking = %+v, cleared = %t; want cleared unsupported effort", opts.Thinking, opts.ThinkingCleared)
		}
	})
}

func TestRefreshSlashModelProvenanceAfterModelSelect(t *testing.T) {
	const selected = "slash-selected-model"
	mgr := NewManager(newMockBackend())
	s := &engineSession{}
	host := extension.NewHost()
	host.SDK().On(extension.HookModelSelect, func(_ *extension.Context, _ interface{}) (interface{}, error) {
		return selected, nil
	})
	group := extension.NewExtensionGroup()
	group.Add(host)

	opts := types.RunOptions{
		Model:                       "slash-tier-model",
		ResolvedSlashModelAlias:     "standard",
		ResolvedSlashModelEffective: "slash-tier-model",
	}
	mgr.fireModelSelect(s, "slash-model-select", group, false, &opts)
	if opts.Model != selected {
		t.Fatalf("model_select model = %q, want %q", opts.Model, selected)
	}
	refreshSlashModelProvenance(&opts, "slash-model-select")
	if opts.ResolvedSlashModelEffective != selected {
		t.Fatalf("slash effective model = %q, want final selected model %q", opts.ResolvedSlashModelEffective, selected)
	}
}
