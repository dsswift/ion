package backend

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"slices"
	"testing"
	"time"
)

// textGenCall records one runTextGenCommand invocation.
type textGenCall struct {
	bin   string
	args  []string
	dir   string
	stdin string
}

// stubTextGenProcess replaces the binary lookup and the process runner. run
// decides what the "CLI" does; every invocation is recorded.
func stubTextGenProcess(t *testing.T, run func(call textGenCall) ([]byte, []byte, error)) *[]textGenCall {
	t.Helper()
	priorFind, priorRun := findTextGenBinary, runTextGenCommand
	t.Cleanup(func() { findTextGenBinary, runTextGenCommand = priorFind, priorRun })

	calls := &[]textGenCall{}
	findTextGenBinary = func(name string) (string, error) { return "/fake/bin/" + name, nil }
	runTextGenCommand = func(_ context.Context, bin string, args []string, dir, stdin string) ([]byte, []byte, error) {
		call := textGenCall{bin: bin, args: args, dir: dir, stdin: stdin}
		*calls = append(*calls, call)
		return run(call)
	}
	return calls
}

// argValue returns the argument following flag, or fails the test.
func argValue(t *testing.T, args []string, flag string) string {
	t.Helper()
	i := slices.Index(args, flag)
	if i < 0 || i+1 >= len(args) {
		t.Fatalf("args %v have no value for %s", args, flag)
	}
	return args[i+1]
}

func TestClaudeGenerateText_IsolatedOneShot(t *testing.T) {
	calls := stubTextGenProcess(t, func(textGenCall) ([]byte, []byte, error) {
		return []byte(`{"type":"result","is_error":false,"result":"Fix Token Expiry Check"}` + "\n"), nil, nil
	})

	text, err := NewClaudeCodeBackend().GenerateText(context.Background(), TextGenRequest{
		Model: "claude-test-sonnet", System: "be a title generator", Prompt: "the prompt",
	})
	if err != nil {
		t.Fatalf("GenerateText() error = %v", err)
	}
	if text != "Fix Token Expiry Check" {
		t.Errorf("GenerateText() = %q, want the envelope's result", text)
	}
	if len(*calls) != 1 {
		t.Fatalf("spawned %d processes, want 1", len(*calls))
	}
	call := (*calls)[0]
	if call.bin != "/fake/bin/claude" {
		t.Errorf("bin = %q, want the resolved claude binary", call.bin)
	}
	if call.stdin != "the prompt" {
		t.Errorf("stdin = %q, want the prompt", call.stdin)
	}
	// The isolation contract: nothing executable, nothing from user config.
	if got := argValue(t, call.args, "--tools"); got != "" {
		t.Errorf("--tools = %q, want empty (no tools)", got)
	}
	for _, flag := range []string{"-p", "--disable-slash-commands", "--strict-mcp-config", "--no-session-persistence"} {
		if !slices.Contains(call.args, flag) {
			t.Errorf("args %v missing %s", call.args, flag)
		}
	}
	if got := argValue(t, call.args, "--settings"); got != claudeTextGenSettings {
		t.Errorf("--settings = %q, want hooks and thinking disabled", got)
	}
	if got := argValue(t, call.args, "--model"); got != "claude-test-sonnet" {
		t.Errorf("--model = %q", got)
	}
	if got := argValue(t, call.args, "--system-prompt"); got != "be a title generator" {
		t.Errorf("--system-prompt = %q", got)
	}
	// A scratch directory, gone once the call returns.
	if call.dir == "" {
		t.Fatal("process ran with no working directory")
	}
	if _, statErr := os.Stat(call.dir); !os.IsNotExist(statErr) {
		t.Errorf("scratch directory %q still exists after the call", call.dir)
	}
}

func TestClaudeGenerateText_Failures(t *testing.T) {
	cases := map[string]func(textGenCall) ([]byte, []byte, error){
		"process error": func(textGenCall) ([]byte, []byte, error) {
			return nil, []byte("not logged in"), errors.New("exit status 1")
		},
		"error envelope": func(textGenCall) ([]byte, []byte, error) {
			return []byte(`{"is_error":true,"result":"Invalid API key"}`), nil, nil
		},
		"not json": func(textGenCall) ([]byte, []byte, error) { return []byte("plain text"), nil, nil },
	}
	for name, run := range cases {
		t.Run(name, func(t *testing.T) {
			stubTextGenProcess(t, run)
			text, err := NewClaudeCodeBackend().GenerateText(context.Background(), TextGenRequest{Prompt: "p"})
			if err == nil || text != "" {
				t.Errorf("GenerateText() = %q, %v; want an error and no text", text, err)
			}
		})
	}
}

func TestCodexGenerateText_ReadsAnswerFile(t *testing.T) {
	calls := stubTextGenProcess(t, func(call textGenCall) ([]byte, []byte, error) {
		out := argValue(t, call.args, "--output-last-message")
		if err := os.WriteFile(out, []byte("Auth Fails After Clock Change\n"), 0o600); err != nil {
			t.Fatalf("write answer file: %v", err)
		}
		return []byte("progress noise"), nil, nil
	})

	text, err := NewCodexBackend().GenerateText(context.Background(), TextGenRequest{
		Model: "gpt-test-4o", System: "be a title generator", Prompt: "the prompt",
	})
	if err != nil {
		t.Fatalf("GenerateText() error = %v", err)
	}
	if text != "Auth Fails After Clock Change\n" {
		t.Errorf("GenerateText() = %q, want the answer file's content", text)
	}
	call := (*calls)[0]
	if call.bin != "/fake/bin/codex" || call.args[0] != "exec" {
		t.Errorf("spawned %q %v, want codex exec", call.bin, call.args)
	}
	if call.stdin != "be a title generator\n\nthe prompt" {
		t.Errorf("stdin = %q, want system instruction then prompt", call.stdin)
	}
	if got := argValue(t, call.args, "--sandbox"); got != "read-only" {
		t.Errorf("--sandbox = %q, want read-only", got)
	}
	for _, flag := range []string{"--skip-git-repo-check", "--ephemeral", "--ignore-rules"} {
		if !slices.Contains(call.args, flag) {
			t.Errorf("args %v missing %s", call.args, flag)
		}
	}
	if got := argValue(t, call.args, "--model"); got != "gpt-test-4o" {
		t.Errorf("--model = %q", got)
	}
	if got := argValue(t, call.args, "--output-last-message"); filepath.Dir(got) != call.dir {
		t.Errorf("answer file %q is outside the scratch directory %q", got, call.dir)
	}
	if call.args[len(call.args)-1] != "-" {
		t.Errorf("args %v do not end with - (prompt from stdin)", call.args)
	}
}

func TestCodexGenerateText_MissingAnswerFileIsAnError(t *testing.T) {
	stubTextGenProcess(t, func(textGenCall) ([]byte, []byte, error) { return nil, nil, nil })
	if text, err := NewCodexBackend().GenerateText(context.Background(), TextGenRequest{Prompt: "p"}); err == nil || text != "" {
		t.Errorf("GenerateText() = %q, %v; want an error and no text", text, err)
	}
}

// The hybrid backend serves text generation from the same backend a run of
// that model would use.
func TestHybridGenerateText_FollowsRunRouting(t *testing.T) {
	registerHybridTestModels(t)
	envelope := func(textGenCall) ([]byte, []byte, error) {
		return []byte(`{"is_error":false,"result":"A Title"}`), nil, nil
	}

	t.Run("no key, cli authed: delegated", func(t *testing.T) {
		calls := stubTextGenProcess(t, envelope)
		h := hybridWith(newFakeKeys(), newFakeCliAuth("claude-code"), nil)
		text, err := h.GenerateText(context.Background(), TextGenRequest{Model: "claude-test-sonnet", Prompt: "p"})
		if err != nil || text != "A Title" {
			t.Fatalf("GenerateText() = %q, %v; want the cli's answer", text, err)
		}
		if len(*calls) != 1 || (*calls)[0].bin != "/fake/bin/claude" {
			t.Errorf("calls = %+v, want one claude spawn", *calls)
		}
	})

	t.Run("api key present: not delegated", func(t *testing.T) {
		calls := stubTextGenProcess(t, envelope)
		h := hybridWith(newFakeKeys("anthropic"), newFakeCliAuth("claude-code"), nil)
		_, err := h.GenerateText(context.Background(), TextGenRequest{Model: "claude-test-sonnet", Prompt: "p"})
		if !errors.Is(err, ErrTextGenUnsupported) {
			t.Fatalf("GenerateText() error = %v, want ErrTextGenUnsupported", err)
		}
		if len(*calls) != 0 {
			t.Errorf("spawned %d processes, want none", len(*calls))
		}
	})

	t.Run("cli kind without a one-shot mode: not delegated", func(t *testing.T) {
		calls := stubTextGenProcess(t, envelope)
		h := hybridWith(newFakeKeys(), nil, map[string]string{"anthropic": "grok"})
		_, err := h.GenerateText(context.Background(), TextGenRequest{Model: "claude-test-sonnet", Prompt: "p"})
		if !errors.Is(err, ErrTextGenUnsupported) {
			t.Fatalf("GenerateText() error = %v, want ErrTextGenUnsupported", err)
		}
		if len(*calls) != 0 {
			t.Errorf("spawned %d processes, want none", len(*calls))
		}
	})
}

func TestSetTextGenTimeout_BoundsTheProcess(t *testing.T) {
	prior := textGenTimeout.Load()
	t.Cleanup(func() { textGenTimeout.Store(prior) })
	priorFind, priorRun := findTextGenBinary, runTextGenCommand
	t.Cleanup(func() { findTextGenBinary, runTextGenCommand = priorFind, priorRun })

	SetTextGenTimeout(1234 * time.Millisecond)
	SetTextGenTimeout(0) // ignored: a zero value must not unbound the call

	var remaining time.Duration
	findTextGenBinary = func(name string) (string, error) { return "/fake/bin/" + name, nil }
	runTextGenCommand = func(ctx context.Context, _ string, _ []string, _, _ string) ([]byte, []byte, error) {
		deadline, ok := ctx.Deadline()
		if !ok {
			t.Fatal("process context has no deadline")
		}
		remaining = time.Until(deadline)
		return []byte(`{"is_error":false,"result":"A Title"}`), nil, nil
	}

	if _, err := NewClaudeCodeBackend().GenerateText(context.Background(), TextGenRequest{Prompt: "p"}); err != nil {
		t.Fatalf("GenerateText() error = %v", err)
	}
	if remaining <= 0 || remaining > 1234*time.Millisecond {
		t.Errorf("process deadline in %v, want within the configured 1234ms", remaining)
	}
}
