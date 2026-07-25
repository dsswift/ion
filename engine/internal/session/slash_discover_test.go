package session

import (
	"testing"
)

// TestDiscoverSlashCommands pins the engine-side discovery feed that replaces
// per-consumer filesystem walks: project + user .ion/.claude command templates
// surface (name-sorted, de-duplicated by precedence), with description /
// argument-hint / source metadata, and model-only skills are excluded.
func TestDiscoverSlashCommands(t *testing.T) {
	work := t.TempDir()
	writeTemplate(t, work, ".ion/commands/alpha.md", "---\ndescription: alpha cmd\nargument-hint: \"[name]\"\n---\nbody")
	writeTemplate(t, work, ".claude/commands/beta.md", "---\ndescription: beta cmd\n---\nbody")
	// Colon-nested command.
	writeTemplate(t, work, ".ion/commands/e2e/setup.md", "---\ndescription: e2e setup\n---\nbody")

	got := discoverSlashCommands(work, true)

	byName := map[string]bool{}
	for _, l := range got {
		byName[l.Name] = true
	}
	if !byName["alpha"] || !byName["beta"] || !byName["e2e:setup"] {
		t.Fatalf("expected alpha, beta, e2e:setup; got %+v", got)
	}

	// Metadata + source for alpha.
	for _, l := range got {
		if l.Name == "alpha" {
			if l.Description != "alpha cmd" || l.ArgumentHint != "[name]" || l.Source != slashSourceIon {
				t.Errorf("alpha listing = %+v", l)
			}
		}
		if l.Name == "beta" && l.Source != slashSourceClaude {
			t.Errorf("beta source = %q want claude", l.Source)
		}
	}

	// Name-sorted.
	for i := 1; i < len(got); i++ {
		if got[i-1].Name > got[i].Name {
			t.Errorf("listing not name-sorted: %q before %q", got[i-1].Name, got[i].Name)
		}
	}
}

func TestDiscoverSlashCommands_PrecedenceDedup(t *testing.T) {
	work := t.TempDir()
	// Same name in project .ion (higher) and via a user root would dedup; here
	// we just assert a duplicate name within the scanned set appears once.
	writeTemplate(t, work, ".ion/commands/dup.md", "---\ndescription: project\n---\nbody")
	writeTemplate(t, work, ".claude/commands/dup.md", "---\ndescription: claude\n---\nbody")

	got := discoverSlashCommands(work, true)
	count := 0
	var src string
	for _, l := range got {
		if l.Name == "dup" {
			count++
			src = l.Source
		}
	}
	if count != 1 {
		t.Fatalf("expected dup once (precedence dedup), got %d", count)
	}
	if src != slashSourceIon {
		t.Errorf("dup should resolve to higher-precedence .ion root, got %q", src)
	}
}

// TestDiscoverSlashCommands_ClaudeCompatGate pins that discovery omits the
// `.claude` command roots when claudeCompat is false (and includes them when
// true). The `.ion` roots are never gated. Regression guard for the dropped
// gate in the autocomplete feed.
func TestDiscoverSlashCommands_ClaudeCompatGate(t *testing.T) {
	work := t.TempDir()
	writeTemplate(t, work, ".ion/commands/iononly.md", "---\ndescription: ion\n---\nbody")
	writeTemplate(t, work, ".claude/commands/claudeonly.md", "---\ndescription: claude\n---\nbody")

	// claudeCompat=false: only the .ion command appears.
	off := discoverSlashCommands(work, false)
	offNames := map[string]bool{}
	for _, l := range off {
		offNames[l.Name] = true
	}
	if !offNames["iononly"] {
		t.Error("expected iononly present when claudeCompat=false")
	}
	if offNames["claudeonly"] {
		t.Error("expected claudeonly ABSENT when claudeCompat=false")
	}

	// claudeCompat=true: both appear.
	on := discoverSlashCommands(work, true)
	onNames := map[string]bool{}
	for _, l := range on {
		onNames[l.Name] = true
	}
	if !onNames["iononly"] || !onNames["claudeonly"] {
		t.Errorf("expected both commands when claudeCompat=true; got %+v", on)
	}
}

// TestDiscoverSlashCommands_IonSkillsRoots pins the .ion skill roots in the
// autocomplete feed: skills under {workingDir}/.ion/skills and ~/.ion/skills
// surface with source "skill" at claudeCompat=false — never gated behind
// Claude compatibility.
func TestDiscoverSlashCommands_IonSkillsRoots(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	work := t.TempDir()
	writeTemplate(t, work, ".ion/skills/projskill/SKILL.md", "---\ndescription: project skill\n---\nbody")
	writeTemplate(t, home, ".ion/skills/userskill/SKILL.md", "---\ndescription: user skill\n---\nbody")

	got := discoverSlashCommands(work, false)
	bySource := map[string]string{}
	for _, l := range got {
		bySource[l.Name] = l.Source
	}
	if bySource["projskill"] != slashSourceSkill {
		t.Errorf("projskill source = %q want %q (listings %+v)", bySource["projskill"], slashSourceSkill, got)
	}
	if bySource["userskill"] != slashSourceSkill {
		t.Errorf("userskill source = %q want %q", bySource["userskill"], slashSourceSkill)
	}
}

// TestDiscoverSlashCommands_SkillsListedByDefault pins the user-invocable
// default flip: a SKILL.md with no `user-invocable` key IS listed (matching
// Claude Code's slash menu); an explicit `user-invocable: false` is hidden.
func TestDiscoverSlashCommands_SkillsListedByDefault(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	work := t.TempDir()
	writeTemplate(t, home, ".ion/skills/plainskill/SKILL.md", "---\ndescription: no key\n---\nbody")
	writeTemplate(t, home, ".ion/skills/hiddenskill/SKILL.md", "---\ndescription: hidden\nuser-invocable: false\n---\nbody")

	got := discoverSlashCommands(work, false)
	names := map[string]bool{}
	for _, l := range got {
		names[l.Name] = true
	}
	if !names["plainskill"] {
		t.Error("skill without user-invocable key should be listed by default")
	}
	if names["hiddenskill"] {
		t.Error("skill with user-invocable: false must be hidden")
	}
}

// TestDiscoverSlashCommands_InterleavedPrecedence pins dedup across the
// interleaved root order: a name in ~/.ion/skills shadows the same name in
// {workingDir}/.claude/commands.
func TestDiscoverSlashCommands_InterleavedPrecedence(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	work := t.TempDir()
	writeTemplate(t, home, ".ion/skills/shared/SKILL.md", "---\ndescription: ion skill\n---\nbody")
	writeTemplate(t, work, ".claude/commands/shared.md", "---\ndescription: claude cmd\n---\nbody")

	got := discoverSlashCommands(work, true)
	count := 0
	var src string
	for _, l := range got {
		if l.Name == "shared" {
			count++
			src = l.Source
		}
	}
	if count != 1 {
		t.Fatalf("expected shared once, got %d", count)
	}
	if src != slashSourceSkill {
		t.Errorf("shared should come from the higher-precedence ion skill root, got %q", src)
	}
}
