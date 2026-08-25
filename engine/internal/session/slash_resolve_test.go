package session

import (
	"os"
	"path/filepath"
	"testing"

	"github.com/dsswift/ion/engine/internal/types"
)

// slash_resolve_test.go pins the engine-side slash resolution + expansion
// behavior (verification points 1, 7, 8 of the slash-pipeline plan):
//   - resolution across the conventional roots with precedence
//   - full $ARGUMENTS substitution (full, indexed, shorthand, append-if-absent)
//   - open-frontmatter passthrough of unknown keys

func writeTemplate(t *testing.T, dir, rel, content string) {
	t.Helper()
	full := filepath.Join(dir, rel)
	if err := os.MkdirAll(filepath.Dir(full), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(full, []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}
}

func TestParseSlashInvocation(t *testing.T) {
	cases := []struct {
		in       string
		wantName string
		wantArgs string
		wantOK   bool
	}{
		{"/diagram make a flowchart", "diagram", "make a flowchart", true},
		{"/clear", "clear", "", true},
		{"/e2e:setup foo", "e2e:setup", "foo", true},
		{"  /trimmed  args ", "trimmed", "args", true},
		{"/usr/bin/foo", "usr", "/bin/foo", true}, // name=usr (won't resolve → unknown_command); rest is args
		{"not a slash", "", "", false},
		{"/123 numeric-lead", "", "", false}, // must start with a letter
		{"/^regex$/", "", "", false},
	}
	for _, c := range cases {
		name, args, ok := parseSlashInvocation(c.in)
		if ok != c.wantOK {
			t.Errorf("parseSlashInvocation(%q) ok=%v want %v", c.in, ok, c.wantOK)
			continue
		}
		if ok && (name != c.wantName || args != c.wantArgs) {
			t.Errorf("parseSlashInvocation(%q) = (%q,%q) want (%q,%q)", c.in, name, args, c.wantName, c.wantArgs)
		}
	}
}

func TestResolveSlashCommand_IonPrecedenceAndExpansion(t *testing.T) {
	work := t.TempDir()
	// Project .ion/commands wins over everything else for the same name.
	writeTemplate(t, work, ".ion/commands/greet.md", "---\ndescription: say hi\n---\nHello $ARGUMENTS, welcome.")

	res, ok := resolveSlashCommand("greet", "Ada", work, true)
	if !ok {
		t.Fatal("expected resolution")
	}
	if res.Source != slashSourceIon {
		t.Errorf("source = %q want %q", res.Source, slashSourceIon)
	}
	if res.Command != "/greet" || res.Args != "Ada" {
		t.Errorf("invocation = (%q,%q) want (/greet, Ada)", res.Command, res.Args)
	}
	if res.ExpandedBody != "Hello Ada, welcome." {
		t.Errorf("expanded = %q", res.ExpandedBody)
	}
	if res.Frontmatter["description"] != "say hi" {
		t.Errorf("frontmatter description = %v", res.Frontmatter["description"])
	}
}

func TestResolveSlashCommand_UnknownReturnsNotOK(t *testing.T) {
	work := t.TempDir()
	if _, ok := resolveSlashCommand("does-not-exist", "", work, true); ok {
		t.Error("expected ok=false for unresolved command")
	}
}

func TestResolveSlashCommand_OpenFrontmatterPassthrough(t *testing.T) {
	work := t.TempDir()
	// An unknown key the engine does not bless must survive into the open map
	// so an extension can read it (the extensibility-seam guarantee).
	writeTemplate(t, work, ".ion/commands/x.md", "---\ndescription: d\nmy-extension-key: special-value\nmodel: sonnet\n---\nBody")
	res, ok := resolveSlashCommand("x", "", work, true)
	if !ok {
		t.Fatal("expected resolution")
	}
	if got := res.Frontmatter["my-extension-key"]; got != "special-value" {
		t.Errorf("unknown frontmatter key not preserved: got %v", got)
	}
	if res.Model != "sonnet" {
		t.Errorf("model = %q want sonnet", res.Model)
	}
}

func TestResolveSlashIntoOptsCarriesFrontmatterForPersistence(t *testing.T) {
	work := t.TempDir()
	writeTemplate(t, work, ".ion/commands/x.md", "---\nmy-extension-key: durable-value\nallowed-tools: [Read, Grep]\n---\nBody")
	mgr := NewManager(newMockBackend())
	s := &engineSession{config: types.EngineConfig{WorkingDirectory: work}}
	opts := &types.RunOptions{Prompt: "/x", ResolveSlash: true}

	resolved, failed := mgr.resolveSlashIntoOpts(s, "slash-frontmatter", opts)
	if !resolved || failed != "" {
		t.Fatalf("resolveSlashIntoOpts = (%t, %q), want (true, empty)", resolved, failed)
	}
	if got := opts.ResolvedSlashFrontmatter["my-extension-key"]; got != "durable-value" {
		t.Errorf("ResolvedSlashFrontmatter custom key = %v, want durable-value", got)
	}
	if tools, ok := opts.ResolvedSlashFrontmatter["allowed-tools"].([]string); !ok || len(tools) != 2 {
		t.Errorf("ResolvedSlashFrontmatter allowed-tools = %#v, want parsed list", opts.ResolvedSlashFrontmatter["allowed-tools"])
	}
}

func TestResolveSlashCommand_ForkContext(t *testing.T) {
	work := t.TempDir()
	writeTemplate(t, work, ".ion/commands/heavy.md", "---\ndescription: heavy task\ncontext: fork\n---\nDo the heavy work with $ARGUMENTS")
	res, ok := resolveSlashCommand("heavy", "the payload", work, true)
	if !ok {
		t.Fatal("expected resolution")
	}
	if res.Context != "fork" {
		t.Errorf("context = %q want fork", res.Context)
	}
	if res.ExpandedBody != "Do the heavy work with the payload" {
		t.Errorf("expanded = %q", res.ExpandedBody)
	}
}

func TestResolveSlashCommand_InlineContextDefault(t *testing.T) {
	work := t.TempDir()
	writeTemplate(t, work, ".ion/commands/light.md", "---\ndescription: light\n---\nbody")
	res, ok := resolveSlashCommand("light", "", work, true)
	if !ok {
		t.Fatal("expected resolution")
	}
	if res.Context != "inline" {
		t.Errorf("context = %q want inline (default)", res.Context)
	}
}

func TestSubstituteArguments(t *testing.T) {
	cases := []struct {
		name string
		body string
		args string
		want string
	}{
		{"full", "do $ARGUMENTS now", "the thing", "do the thing now"},
		{"indexed", "first=$ARGUMENTS[0] second=$ARGUMENTS[1]", "a b", "first=a second=b"},
		{"shorthand", "x=$0 y=$1", "a b", "x=a y=b"},
		{"out-of-range", "only=$ARGUMENTS[5]", "a b", "only="},
		{"append-if-no-placeholder", "no placeholder here", "extra args", "no placeholder here\n\nARGUMENTS: extra args"},
		{"no-args-no-append", "plain body", "", "plain body"},
		{"no-args-collapses-placeholder", "x=$ARGUMENTS", "", "x="},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			got := substituteArguments(c.body, c.args)
			if got != c.want {
				t.Errorf("substituteArguments(%q,%q) = %q want %q", c.body, c.args, got, c.want)
			}
		})
	}
}

func TestParseOpenFrontmatter(t *testing.T) {
	content := "---\ndescription: a desc\nallowed-tools: [Read, Write]\ntags:\n  - one\n  - two\n---\nthe body"
	fm, body := parseOpenFrontmatter(content)
	if body != "the body" {
		t.Errorf("body = %q", body)
	}
	if fm["description"] != "a desc" {
		t.Errorf("description = %v", fm["description"])
	}
	if got := frontmatterList(fm, "allowed-tools"); len(got) != 2 || got[0] != "Read" || got[1] != "Write" {
		t.Errorf("allowed-tools = %v", got)
	}
	tags, ok := fm["tags"].([]string)
	if !ok || len(tags) != 2 || tags[0] != "one" {
		t.Errorf("indented list tags = %v", fm["tags"])
	}
}

func TestParseOpenFrontmatter_NoFence(t *testing.T) {
	fm, body := parseOpenFrontmatter("just a plain body, no frontmatter")
	if len(fm) != 0 {
		t.Errorf("expected empty frontmatter, got %v", fm)
	}
	if body != "just a plain body, no frontmatter" {
		t.Errorf("body = %q", body)
	}
}

func TestFrontmatterUserInvocable_SourceDefaults(t *testing.T) {
	// Commands AND skills default to user-invocable (Claude Code lists skills
	// in its slash menu; Ion matches). Explicit user-invocable: false opts out.
	if !frontmatterUserInvocable(map[string]any{}) {
		t.Error("skill should default to user-invocable")
	}
	if !frontmatterUserInvocable(map[string]any{}) {
		t.Error("ion command should default to user-invocable")
	}
	if frontmatterUserInvocable(map[string]any{"user-invocable": "false"}) {
		t.Error("skill with user-invocable: false should be hidden")
	}
	if frontmatterUserInvocable(map[string]any{"user-invocable": "false"}) {
		t.Error("command with user-invocable: false should be hidden")
	}
	if !frontmatterUserInvocable(map[string]any{"user-invocable": "true"}) {
		t.Error("skill with user-invocable: true should be invocable")
	}
}

func TestFrontmatterContext(t *testing.T) {
	if frontmatterContext(map[string]any{}) != "inline" {
		t.Error("absent context should default to inline")
	}
	if frontmatterContext(map[string]any{"context": "fork"}) != "fork" {
		t.Error("context: fork should resolve to fork")
	}
}

// TestResolveSlashCommand_ClaudeCompatGate pins that the `.claude` command and
// skill roots are probed ONLY when claudeCompat is true. With it false, a
// command that exists solely under `.claude/commands` must NOT resolve, while
// an `.ion/commands` peer still resolves regardless of the flag. This is the
// regression guard for the dropped Claude-compat gate: before the fix the
// `.claude` roots were walked unconditionally.
func TestResolveSlashCommand_ClaudeCompatGate(t *testing.T) {
	work := t.TempDir()
	// A command that lives only under .claude/commands.
	writeTemplate(t, work, ".claude/commands/claudeonly.md", "---\ndescription: claude only\n---\nBody")
	// A command that lives only under .ion/commands (never gated).
	writeTemplate(t, work, ".ion/commands/iononly.md", "---\ndescription: ion only\n---\nBody")

	// claudeCompat=false: the .claude command must NOT resolve.
	if _, ok := resolveSlashCommand("claudeonly", "", work, false); ok {
		t.Error("expected .claude command to be gated out when claudeCompat=false")
	}
	// ...but the .ion command still resolves.
	if _, ok := resolveSlashCommand("iononly", "", work, false); !ok {
		t.Error("expected .ion command to resolve regardless of claudeCompat")
	}

	// claudeCompat=true: the .claude command resolves.
	res, ok := resolveSlashCommand("claudeonly", "", work, true)
	if !ok {
		t.Fatal("expected .claude command to resolve when claudeCompat=true")
	}
	if res.Source != slashSourceClaude {
		t.Errorf("source = %q want %q", res.Source, slashSourceClaude)
	}
}

// TestResolveSlashCommand_IonSkillRoots pins the .ion skill roots: skills in
// {workingDir}/.ion/skills and ~/.ion/skills resolve as source "skill" with
// claudeCompat=false — the .ion roots are the product's defaults and are
// never gated behind Claude compatibility.
func TestResolveSlashCommand_IonSkillRoots(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	work := t.TempDir()
	writeTemplate(t, work, ".ion/skills/foo/SKILL.md", "---\ndescription: project skill\n---\nProject skill body")
	writeTemplate(t, home, ".ion/skills/bar/SKILL.md", "---\ndescription: user skill\n---\nUser skill body")

	res, ok := resolveSlashCommand("foo", "", work, false)
	if !ok {
		t.Fatal("expected project .ion skill to resolve with claudeCompat=false")
	}
	if res.Source != slashSourceSkill {
		t.Errorf("source = %q want %q", res.Source, slashSourceSkill)
	}

	res, ok = resolveSlashCommand("bar", "", work, false)
	if !ok {
		t.Fatal("expected user ~/.ion skill to resolve with claudeCompat=false")
	}
	if res.Source != slashSourceSkill {
		t.Errorf("source = %q want %q", res.Source, slashSourceSkill)
	}
}

// TestResolveSlashCommand_IonSkillPrecedence pins the interleaved precedence:
// ion commands beat ion skills; ion skills beat claude commands.
func TestResolveSlashCommand_IonSkillPrecedence(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	work := t.TempDir()

	// Same name as command (~/.ion/commands) and project skill → command wins.
	writeTemplate(t, home, ".ion/commands/x.md", "---\ndescription: command\n---\nCommand body")
	writeTemplate(t, work, ".ion/skills/x/SKILL.md", "---\ndescription: skill\n---\nSkill body")
	res, ok := resolveSlashCommand("x", "", work, true)
	if !ok {
		t.Fatal("expected resolution")
	}
	if res.Source != slashSourceIon {
		t.Errorf("command should shadow skill: source = %q want %q", res.Source, slashSourceIon)
	}

	// Same name as ion skill and claude command → ion skill wins.
	writeTemplate(t, work, ".ion/skills/y/SKILL.md", "---\ndescription: ion skill\n---\nIon skill body")
	writeTemplate(t, home, ".claude/commands/y.md", "---\ndescription: claude command\n---\nClaude body")
	res, ok = resolveSlashCommand("y", "", work, true)
	if !ok {
		t.Fatal("expected resolution")
	}
	if res.Source != slashSourceSkill {
		t.Errorf("ion skill should shadow claude command: source = %q want %q", res.Source, slashSourceSkill)
	}
}

// TestResolveSlashCommand_SkillBodyCarriesBaseDirectory pins the base-dir
// annotation: a resolved skill's expanded body names its base directory so
// the model can resolve relative companion files (references/*.md); a plain
// command's body carries no such line.
func TestResolveSlashCommand_SkillBodyCarriesBaseDirectory(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	work := t.TempDir()
	writeTemplate(t, work, ".ion/skills/withrefs/SKILL.md", "---\ndescription: s\n---\nSee references/spec.md for details.")
	writeTemplate(t, work, ".ion/commands/plain.md", "---\ndescription: c\n---\nCommand body")

	res, ok := resolveSlashCommand("withrefs", "", work, false)
	if !ok {
		t.Fatal("expected skill resolution")
	}
	wantDir := filepath.Join(work, ".ion", "skills", "withrefs")
	// Literal wording (not the constants) so drift against the Skill tool's
	// base-directory lines in tools/skill.go fails a test in this package too.
	wantPrefix := "Base directory for this skill: " + wantDir + "\n" +
		"Relative paths in this skill (e.g. references/...) resolve against this base directory.\n\n"
	if got := res.ExpandedBody; len(got) < len(wantPrefix) || got[:len(wantPrefix)] != wantPrefix {
		t.Errorf("expanded body missing base-dir prefix:\n got: %q\nwant prefix: %q", got, wantPrefix)
	}

	cmdRes, ok := resolveSlashCommand("plain", "", work, false)
	if !ok {
		t.Fatal("expected command resolution")
	}
	if cmdRes.ExpandedBody != "Command body" {
		t.Errorf("plain command body must not be annotated: %q", cmdRes.ExpandedBody)
	}
}

// TestResolveSlashCommand_ColonNameSkipsSkillRoots pins that colon-delimited
// names (e2e:setup) never probe the flat skill roots.
func TestResolveSlashCommand_ColonNameSkipsSkillRoots(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	work := t.TempDir()
	// A pathological skill dir literally named "e2e:setup" must not resolve.
	writeTemplate(t, work, ".ion/skills/e2e:setup/SKILL.md", "---\ndescription: bad\n---\nBody")
	if _, ok := resolveSlashCommand("e2e:setup", "", work, false); ok {
		t.Error("colon-delimited name must not resolve from skill roots")
	}
}
