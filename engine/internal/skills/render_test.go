package skills

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"
	"unicode/utf8"

	"github.com/dsswift/ion/engine/internal/types"
)

// fakeExec records commands and answers from a table.
type fakeExec struct {
	ran     []string
	results map[string]ExecOutcome
}

func (f *fakeExec) exec(_ context.Context, cmd, _ string, _ time.Duration) (ExecOutcome, error) {
	f.ran = append(f.ran, cmd)
	if r, ok := f.results[cmd]; ok {
		return r, nil
	}
	return ExecOutcome{Output: "out:" + cmd}, nil
}

func render(t *testing.T, in RenderInput) (string, error) {
	t.Helper()
	if in.Name == "" {
		in.Name = "demo"
	}
	return Render(context.Background(), in)
}

func TestRender_InlineCommandReplacedByOutput(t *testing.T) {
	fx := &fakeExec{}
	got, err := render(t, RenderInput{Body: "Status: !`git status`\nend", Exec: fx.exec})
	if err != nil {
		t.Fatal(err)
	}
	if got != "Status: out:git status\nend" {
		t.Fatalf("got %q", got)
	}
	if strings.Contains(got, "!`") {
		t.Fatal("command text reached the model")
	}
}

func TestRender_FencedBlockRuns(t *testing.T) {
	fx := &fakeExec{}
	got, err := render(t, RenderInput{Body: "Env:\n```!\nnode --version\ngit status\n```\nafter", Exec: fx.exec})
	if err != nil {
		t.Fatal(err)
	}
	if len(fx.ran) != 1 || fx.ran[0] != "node --version\ngit status" {
		t.Fatalf("fenced block ran as %q", fx.ran)
	}
	if got != "Env:\nout:node --version\ngit status\nafter" {
		t.Fatalf("got %q", got)
	}
}

func TestRender_PlaceholderWithoutLeadingWhitespaceIsLiteral(t *testing.T) {
	fx := &fakeExec{}
	body := "KEY=!`echo x`"
	got, err := render(t, RenderInput{Body: body, Exec: fx.exec})
	if err != nil {
		t.Fatal(err)
	}
	if got != body || len(fx.ran) != 0 {
		t.Fatalf("placeholder after a non-space character must stay literal: %q ran=%v", got, fx.ran)
	}
}

func TestRender_OutputIsNotRescanned(t *testing.T) {
	fx := &fakeExec{results: map[string]ExecOutcome{"emit": {Output: "!`rm -rf x`"}}}
	got, err := render(t, RenderInput{Body: "!`emit`", Exec: fx.exec})
	if err != nil {
		t.Fatal(err)
	}
	if len(fx.ran) != 1 || got != "!`rm -rf x`" {
		t.Fatalf("output was re-executed: ran=%v got=%q", fx.ran, got)
	}
}

func TestRender_PlainCodeFenceExamplesAreLiteral(t *testing.T) {
	fx := &fakeExec{}
	body := "```md\nUse !`git status` like this\n```\n"
	got, err := render(t, RenderInput{Body: body, Exec: fx.exec})
	if err != nil || got != body || len(fx.ran) != 0 {
		t.Fatalf("example inside a code fence ran: got=%q ran=%v err=%v", got, fx.ran, err)
	}
}

func TestRender_FailingCommandAborts(t *testing.T) {
	fx := &fakeExec{results: map[string]ExecOutcome{"false": {ExitCode: 3, Output: "boom"}}}
	_, err := render(t, RenderInput{Body: "!`false`", Exec: fx.exec})
	var re *RenderError
	if !errors.As(err, &re) || re.Kind != "command_failed" {
		t.Fatalf("want command_failed, got %v", err)
	}
	if !strings.Contains(re.Message, "exited 3") || !strings.Contains(re.Message, "false") || !strings.Contains(re.Message, "boom") {
		t.Fatalf("error must name the command, exit code, and output: %q", re.Message)
	}
}

func TestRender_TimeoutAborts(t *testing.T) {
	fx := &fakeExec{results: map[string]ExecOutcome{"sleep": {TimedOut: true}}}
	_, err := render(t, RenderInput{Body: "!`sleep`", Exec: fx.exec})
	var re *RenderError
	if !errors.As(err, &re) || !strings.Contains(re.Message, "timed out") {
		t.Fatalf("want timeout abort, got %v", err)
	}
}

func TestRender_DisableShellReplacesAndRunsNothing(t *testing.T) {
	fx := &fakeExec{}
	got, err := render(t, RenderInput{Body: "a !`x`\n```!\ny\n```\n", Exec: fx.exec, DisableShell: true})
	if err != nil {
		t.Fatal(err)
	}
	if len(fx.ran) != 0 || strings.Count(got, ShellDisabledMarker) != 2 {
		t.Fatalf("disabled shell ran=%v got=%q", fx.ran, got)
	}
}

func TestRender_PermitRefusalAborts(t *testing.T) {
	fx := &fakeExec{}
	_, err := render(t, RenderInput{
		Body:   "!`deploy`",
		Exec:   fx.exec,
		Permit: func(string) (bool, string) { return false, "denied by policy" },
	})
	var re *RenderError
	if !errors.As(err, &re) || re.Kind != "permission" || len(fx.ran) != 0 {
		t.Fatalf("refused command must abort before running: err=%v ran=%v", err, fx.ran)
	}
}

func TestRender_HookDenyBlocksBeforeAnyCommand(t *testing.T) {
	fx := &fakeExec{}
	no := false
	var seen LoadEvent
	_, err := render(t, RenderInput{
		Body: "!`one`\n!`two`", Exec: fx.exec,
		OnLoad: func(ev LoadEvent) LoadDecision { seen = ev; return LoadDecision{Allow: &no, Reason: "not here"} },
	})
	var re *RenderError
	if !errors.As(err, &re) || re.Kind != "denied_by_hook" || len(fx.ran) != 0 {
		t.Fatalf("hook deny must stop everything: err=%v ran=%v", err, fx.ran)
	}
	if len(seen.Commands) != 2 || seen.Commands[0] != "one" {
		t.Fatalf("hook should see the commands: %+v", seen.Commands)
	}
}

func TestRender_HookReplacementIsRenderedAndAppendIsVerbatim(t *testing.T) {
	fx := &fakeExec{}
	got, err := render(t, RenderInput{
		Body: "original !`old`", Exec: fx.exec,
		OnLoad: func(LoadEvent) LoadDecision {
			return LoadDecision{Content: "replaced !`new`", AppendContent: "tail !`notrun`"}
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(fx.ran) != 1 || fx.ran[0] != "new" || got != "replaced out:new\n\ntail !`notrun`" {
		t.Fatalf("got=%q ran=%v", got, fx.ran)
	}
}

func TestRender_SkillDirSubstituted(t *testing.T) {
	fx := &fakeExec{}
	_, err := render(t, RenderInput{Body: "!`${CLAUDE_SKILL_DIR}/run.sh` !`${ION_SKILL_DIR}/x`", BaseDir: "/skills/demo", Exec: fx.exec})
	if err != nil {
		t.Fatal(err)
	}
	if fx.ran[0] != "/skills/demo/run.sh" || fx.ran[1] != "/skills/demo/x" {
		t.Fatalf("skill dir not substituted: %v", fx.ran)
	}
}

func TestRender_OutputCapped(t *testing.T) {
	fx := &fakeExec{results: map[string]ExecOutcome{"big": {Output: strings.Repeat("x", 50)}}}
	got, err := render(t, RenderInput{Body: "!`big`", Exec: fx.exec, OutputBudget: 10})
	if err != nil {
		t.Fatal(err)
	}
	if !strings.HasPrefix(got, strings.Repeat("x", 10)+"\n[output truncated: 10 of 50") {
		t.Fatalf("got %q", got)
	}
}

func TestParseAllowedTools(t *testing.T) {
	got := ParseAllowedTools([]string{"Bash(git add *) Bash(${CLAUDE_SKILL_DIR}/s.sh *), Read", "Read(docs/**)\n- Grep"}, "/sk")
	want := []types.PermissionRule{
		{Tool: "Bash", Decision: "allow", CommandPatterns: []string{"git add *"}},
		{Tool: "Bash", Decision: "allow", CommandPatterns: []string{"/sk/s.sh *"}},
		{Tool: "Read", Decision: "allow"},
		{Tool: "Read", Decision: "allow", PathPatterns: []string{"docs/**"}},
		{Tool: "Grep", Decision: "allow"},
	}
	if len(got) != len(want) {
		t.Fatalf("got %d rules: %+v", len(got), got)
	}
	for i := range want {
		g, w := got[i], want[i]
		if g.Tool != w.Tool || strings.Join(g.CommandPatterns, "|") != strings.Join(w.CommandPatterns, "|") || strings.Join(g.PathPatterns, "|") != strings.Join(w.PathPatterns, "|") {
			t.Fatalf("rule %d = %+v, want %+v", i, g, w)
		}
	}
}

// A cut that lands inside a multi-byte character backs up to the rune start,
// so the prompt never carries invalid UTF-8.
func TestRender_OutputCapKeepsRunesWhole(t *testing.T) {
	fx := &fakeExec{results: map[string]ExecOutcome{"big": {Output: "ab€cd"}}} // € is 3 bytes at 2..4
	got, err := render(t, RenderInput{Body: "!`big`", Exec: fx.exec, OutputBudget: 4})
	if err != nil {
		t.Fatal(err)
	}
	if !utf8.ValidString(got) || !strings.HasPrefix(got, "ab\n[output truncated: 2 of") {
		t.Fatalf("got %q", got)
	}
	if tl := tail("ab€cd", 4); !utf8.ValidString(tl) || tl != "...cd" {
		t.Fatalf("tail = %q", tl)
	}
}

// Windows shells end output with CRLF; the whole line ending is dropped, not
// just the LF, so no stray carriage return lands in the prompt.
func TestRender_TrailingCRLFTrimmed(t *testing.T) {
	fx := &fakeExec{results: map[string]ExecOutcome{"echo hi": {Output: "hi\r\n"}}}
	got, err := render(t, RenderInput{Body: "Value: !`echo hi`\nDone.", Exec: fx.exec})
	if err != nil {
		t.Fatal(err)
	}
	if got != "Value: hi\nDone." {
		t.Fatalf("got %q", got)
	}
}
