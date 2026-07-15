package backend

import (
	"strings"
	"testing"

	"github.com/dsswift/ion/engine/internal/conversation"
	"github.com/dsswift/ion/engine/internal/skills"
	"github.com/dsswift/ion/engine/internal/types"
)

// TestBuildSystemPrompt_SkillSectionInjected verifies that when skills are
// registered, buildSystemPrompt appends the skill listing and proactive-
// invocation instruction to the assembled system prompt.
func TestBuildSystemPrompt_SkillSectionInjected(t *testing.T) {
	skills.ClearSkillRegistry()
	defer skills.ClearSkillRegistry()

	skills.RegisterSkill(&skills.Skill{
		Name:        "caveman",
		Description: "Compressed communication mode",
		Content:     "Talk like caveman.",
		WhenToUse:   "Use when user asks for brevity",
	})

	opts := &types.RunOptions{
		SystemPrompt: "You are a helpful assistant.",
		Prompt:       "hello",
	}
	conv := &conversation.Conversation{System: ""}
	result := buildSystemPrompt(opts, conv, RunHooks{}, "req-skill-1", nil)

	// Base system prompt preserved.
	if !strings.Contains(result, "You are a helpful assistant.") {
		t.Errorf("base system prompt missing, got:\n%s", result)
	}
	// Skill section present.
	if !strings.Contains(result, "# Available Skills") {
		t.Errorf("expected '# Available Skills' header in system prompt, got:\n%s", result)
	}
	if !strings.Contains(result, "caveman") {
		t.Errorf("expected skill name 'caveman' in system prompt, got:\n%s", result)
	}
	// Behavioral instruction present.
	if !strings.Contains(result, "BEFORE generating any other response") {
		t.Errorf("expected proactive-invocation instruction in system prompt, got:\n%s", result)
	}
	if !strings.Contains(result, "blocking requirement") {
		t.Errorf("expected 'blocking requirement' in system prompt, got:\n%s", result)
	}
}

// TestBuildSystemPrompt_NoSkillSectionWhenEmpty verifies that when no skills
// are registered, buildSystemPrompt does not inject any skill content.
func TestBuildSystemPrompt_NoSkillSectionWhenEmpty(t *testing.T) {
	skills.ClearSkillRegistry()
	defer skills.ClearSkillRegistry()

	opts := &types.RunOptions{
		SystemPrompt: "Base prompt.",
		Prompt:       "hello",
	}
	conv := &conversation.Conversation{System: ""}
	result := buildSystemPrompt(opts, conv, RunHooks{}, "req-skill-2", nil)

	if strings.Contains(result, "Available Skills") {
		t.Errorf("expected no skill section when registry is empty, got:\n%s", result)
	}
	if strings.Contains(result, "blocking requirement") {
		t.Errorf("expected no skill instruction when registry is empty, got:\n%s", result)
	}
	// Base prompt still present.
	if !strings.Contains(result, "Base prompt.") {
		t.Errorf("base prompt missing, got:\n%s", result)
	}
}

// TestBuildSystemPrompt_SkillSectionAfterCapability verifies that the skill
// section is appended after the capability prompt, not before it.
func TestBuildSystemPrompt_SkillSectionAfterCapability(t *testing.T) {
	skills.ClearSkillRegistry()
	defer skills.ClearSkillRegistry()

	skills.RegisterSkill(&skills.Skill{
		Name:        "myskill",
		Description: "A test skill",
		Content:     "skill body",
	})

	opts := &types.RunOptions{
		SystemPrompt:     "Base.",
		CapabilityPrompt: "Capability instructions.",
		Prompt:           "hello",
	}
	conv := &conversation.Conversation{System: ""}
	result := buildSystemPrompt(opts, conv, RunHooks{}, "req-skill-3", nil)

	capIdx := strings.Index(result, "Capability instructions.")
	skillIdx := strings.Index(result, "# Available Skills")

	if capIdx < 0 {
		t.Fatal("capability prompt missing from result")
	}
	if skillIdx < 0 {
		t.Fatal("skill section missing from result")
	}
	if skillIdx < capIdx {
		t.Errorf("expected skill section after capability prompt; capIdx=%d skillIdx=%d", capIdx, skillIdx)
	}
}

// TestBuildSystemPrompt_SkillSectionGatedByDefault verifies that with the
// zero-value RunOptions (DisableSkillSystemPrompt=false), the skill section is
// injected — i.e. the default is ON. This is the enabled half of the gate and
// fails if the gate is removed such that injection no longer happens by default.
func TestBuildSystemPrompt_SkillSectionGatedByDefault(t *testing.T) {
	skills.ClearSkillRegistry()
	defer skills.ClearSkillRegistry()

	skills.RegisterSkill(&skills.Skill{
		Name:        "caveman",
		Description: "Compressed communication mode",
		Content:     "Talk like caveman.",
	})

	// Zero-value RunOptions: DisableSkillSystemPrompt defaults to false.
	opts := &types.RunOptions{SystemPrompt: "Base.", Prompt: "hello"}
	conv := &conversation.Conversation{System: ""}
	result := buildSystemPrompt(opts, conv, RunHooks{}, "req-skill-gate-on", nil)

	if !strings.Contains(result, "# Available Skills") {
		t.Errorf("expected skill section injected by default (gate on), got:\n%s", result)
	}
	if !strings.Contains(result, "blocking requirement") {
		t.Errorf("expected proactive-invocation directive by default, got:\n%s", result)
	}
}

// TestBuildSystemPrompt_SkillSectionSuppressedByConfig verifies that when
// RunOptions.DisableSkillSystemPrompt is true, the engine skips the skill
// section entirely even though skills are registered. Fails if the gate is
// removed (the section would then always be injected regardless of the flag).
func TestBuildSystemPrompt_SkillSectionSuppressedByConfig(t *testing.T) {
	skills.ClearSkillRegistry()
	defer skills.ClearSkillRegistry()

	skills.RegisterSkill(&skills.Skill{
		Name:        "caveman",
		Description: "Compressed communication mode",
		Content:     "Talk like caveman.",
	})

	opts := &types.RunOptions{
		SystemPrompt:             "Base.",
		Prompt:                   "hello",
		DisableSkillSystemPrompt: true,
	}
	conv := &conversation.Conversation{System: ""}
	result := buildSystemPrompt(opts, conv, RunHooks{}, "req-skill-gate-off", nil)

	if strings.Contains(result, "Available Skills") {
		t.Errorf("expected no skill section when DisableSkillSystemPrompt=true, got:\n%s", result)
	}
	if strings.Contains(result, "blocking requirement") {
		t.Errorf("expected no skill directive when DisableSkillSystemPrompt=true, got:\n%s", result)
	}
	// Base prompt still present.
	if !strings.Contains(result, "Base.") {
		t.Errorf("base prompt missing, got:\n%s", result)
	}
}

// TestBuildSystemPrompt_SkillSectionHookReplace verifies that the system_inject
// hook (kind "skill_listing") can replace the engine's default skill section
// with custom text. Fails if the hook threading is removed (the default
// directive would then survive instead of the replacement).
func TestBuildSystemPrompt_SkillSectionHookReplace(t *testing.T) {
	skills.ClearSkillRegistry()
	defer skills.ClearSkillRegistry()

	skills.RegisterSkill(&skills.Skill{
		Name:        "caveman",
		Description: "Compressed communication mode",
		Content:     "Talk like caveman.",
	})

	const replacement = "# Skills (harness-worded)\nUse skills when they help."
	var sawKind string
	var sawDefault string
	hooks := RunHooks{
		OnSystemInject: func(kind, defaultText string, _, _ int) (string, bool) {
			if kind == "skill_listing" {
				sawKind = kind
				sawDefault = defaultText
				return replacement, false
			}
			return "", false
		},
	}

	opts := &types.RunOptions{SystemPrompt: "Base.", Prompt: "hello"}
	conv := &conversation.Conversation{System: ""}
	result := buildSystemPrompt(opts, conv, hooks, "req-skill-hook-replace", nil)

	if sawKind != "skill_listing" {
		t.Errorf("expected OnSystemInject fired with kind 'skill_listing', got %q", sawKind)
	}
	// The hook received the engine's default section as defaultText.
	if !strings.Contains(sawDefault, "# Available Skills") {
		t.Errorf("expected hook to receive engine default section as defaultText, got:\n%s", sawDefault)
	}
	// The replacement text is present; the engine's default directive is gone.
	if !strings.Contains(result, "harness-worded") {
		t.Errorf("expected harness replacement in system prompt, got:\n%s", result)
	}
	if strings.Contains(result, "blocking requirement") {
		t.Errorf("expected engine default directive replaced by hook, got:\n%s", result)
	}
}

// TestBuildSystemPrompt_SkillSectionHookSuppress verifies that the system_inject
// hook can suppress the skill section entirely (suppress=true), even when
// injection is otherwise enabled and skills are registered.
func TestBuildSystemPrompt_SkillSectionHookSuppress(t *testing.T) {
	skills.ClearSkillRegistry()
	defer skills.ClearSkillRegistry()

	skills.RegisterSkill(&skills.Skill{
		Name:        "caveman",
		Description: "Compressed communication mode",
		Content:     "Talk like caveman.",
	})

	hooks := RunHooks{
		OnSystemInject: func(kind, _ string, _, _ int) (string, bool) {
			if kind == "skill_listing" {
				return "", true // suppress
			}
			return "", false
		},
	}

	opts := &types.RunOptions{SystemPrompt: "Base.", Prompt: "hello"}
	conv := &conversation.Conversation{System: ""}
	result := buildSystemPrompt(opts, conv, hooks, "req-skill-hook-suppress", nil)

	if strings.Contains(result, "Available Skills") {
		t.Errorf("expected skill section suppressed by hook, got:\n%s", result)
	}
	if strings.Contains(result, "blocking requirement") {
		t.Errorf("expected skill directive suppressed by hook, got:\n%s", result)
	}
}
