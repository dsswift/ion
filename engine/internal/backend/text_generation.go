package backend

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync/atomic"
	"time"

	"github.com/dsswift/ion/engine/internal/cliprobe"
	"github.com/dsswift/ion/engine/internal/procctl"
	"github.com/dsswift/ion/engine/internal/providers"
	"github.com/dsswift/ion/engine/internal/utils"
)

// TextGenRequest is one tool-less, single-answer prompt: a system instruction,
// a user prompt, and the model that should answer it.
type TextGenRequest struct {
	Model  string
	System string
	Prompt string
}

// TextGenerator is implemented by a backend that can answer a TextGenRequest
// through its own delegated CLI, authenticated the way its runs are. It exists
// for the engine's small utility prompts (a conversation title), which
// otherwise need a provider API credential a CLI-subscription setup never has.
//
// The call is isolated from any run: no tools, no hooks, no MCP servers, no
// session persistence, and a scratch working directory, so nothing from a
// project checkout reaches the prompt and nothing the model says is acted on.
type TextGenerator interface {
	GenerateText(ctx context.Context, req TextGenRequest) (string, error)
}

// ErrTextGenUnsupported means no delegated CLI serves the request's model, so
// the caller should use the provider API path instead.
var ErrTextGenUnsupported = errors.New("backend: text generation is not served by a delegated CLI for this model")

// textGenTimeout bounds one delegated text-generation subprocess. Stored as
// nanoseconds so SetTextGenTimeout is safe against in-flight calls.
var textGenTimeout atomic.Int64

func init() { textGenTimeout.Store(int64(20 * time.Second)) }

// SetTextGenTimeout overrides the delegated text-generation timeout. Called
// from main.go with the configured timeouts; a non-positive value is ignored.
func SetTextGenTimeout(d time.Duration) {
	if d <= 0 {
		return
	}
	textGenTimeout.Store(int64(d))
	utils.LogWithFields(utils.LevelInfo, "backend.textgen", "timeout configured", map[string]any{"timeout_ms": d.Milliseconds()})
}

// findTextGenBinary and runTextGenCommand are the two process seams, swapped
// by tests so argv and output parsing are exercised without spawning a CLI.
var (
	findTextGenBinary = func(name string) (string, error) { return cliprobe.Find(name, nil) }
	runTextGenCommand = execTextGenCommand
)

// execTextGenCommand runs bin with args in dir, feeding stdin, and returns its
// stdout and stderr.
func execTextGenCommand(ctx context.Context, bin string, args []string, dir, stdin string) ([]byte, []byte, error) {
	cmd := exec.CommandContext(ctx, bin, args...)
	procctl.Configure(cmd)
	cmd.Dir = dir
	cmd.Stdin = strings.NewReader(stdin)
	var stdout, stderr bytes.Buffer
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr
	err := cmd.Run()
	return stdout.Bytes(), stderr.Bytes(), err
}

// runDelegatedTextGen is the shared lifecycle of a delegated text generation:
// resolve the binary, make a scratch directory, run the CLI under the timeout,
// and log the outcome. buildArgs receives the scratch directory; readResult
// turns the finished process into the answer text.
func runDelegatedTextGen(
	ctx context.Context,
	kind, binary string,
	req TextGenRequest,
	stdin string,
	buildArgs func(dir string) []string,
	readResult func(dir string, stdout []byte) (string, error),
) (string, error) {
	started := time.Now()
	bin, err := findTextGenBinary(binary)
	if err != nil {
		utils.LogWithFields(utils.LevelWarn, "backend.textgen", "cli binary not found", map[string]any{
			"kind": kind, "model": req.Model, "error": utils.ErrStr(err),
		})
		return "", fmt.Errorf("%s text generation: %w", kind, err)
	}
	dir, err := os.MkdirTemp("", "ion-textgen-")
	if err != nil {
		utils.LogWithFields(utils.LevelWarn, "backend.textgen", "scratch directory failed", map[string]any{
			"kind": kind, "model": req.Model, "error": utils.ErrStr(err),
		})
		return "", fmt.Errorf("%s text generation: scratch directory: %w", kind, err)
	}
	defer func() {
		if rmErr := os.RemoveAll(dir); rmErr != nil {
			utils.LogWithFields(utils.LevelWarn, "backend.textgen", "scratch directory not removed", map[string]any{
				"kind": kind, "dir": dir, "error": utils.ErrStr(rmErr),
			})
		}
	}()

	runCtx, cancel := context.WithTimeout(ctx, time.Duration(textGenTimeout.Load()))
	defer cancel()
	utils.LogWithFields(utils.LevelInfo, "backend.textgen", "spawning", map[string]any{
		"kind": kind, "model": req.Model, "bin": bin, "prompt_len": len(req.Prompt),
	})
	stdout, stderr, runErr := runTextGenCommand(runCtx, bin, buildArgs(dir), dir, stdin)
	if runErr != nil {
		detail := strings.TrimSpace(string(stderr))
		if detail == "" {
			detail = strings.TrimSpace(string(stdout))
		}
		utils.LogWithFields(utils.LevelWarn, "backend.textgen", "cli failed", map[string]any{
			"kind": kind, "model": req.Model, "error": utils.ErrStr(runErr),
			"detail": truncatePreview(detail, 500), "duration_ms": time.Since(started).Milliseconds(),
		})
		return "", fmt.Errorf("%s text generation: %w", kind, runErr)
	}
	text, err := readResult(dir, stdout)
	if err != nil {
		utils.LogWithFields(utils.LevelWarn, "backend.textgen", "cli output unusable", map[string]any{
			"kind": kind, "model": req.Model, "error": utils.ErrStr(err),
			"duration_ms": time.Since(started).Milliseconds(),
		})
		return "", fmt.Errorf("%s text generation: %w", kind, err)
	}
	utils.LogWithFields(utils.LevelInfo, "backend.textgen", "generated", map[string]any{
		"kind": kind, "model": req.Model, "text_len": len(text),
		"duration_ms": time.Since(started).Milliseconds(),
	})
	return text, nil
}

// claudeTextGenSettings turns off hooks and extended thinking for the one-shot.
const claudeTextGenSettings = `{"disableAllHooks":true,"alwaysThinkingEnabled":false}`

// buildClaudeTextGenArgs assembles the argv for a `claude -p` one-shot that
// can only answer in text.
func buildClaudeTextGenArgs(req TextGenRequest) []string {
	args := []string{
		"-p",
		"--output-format", "json",
		"--tools", "",
		"--disable-slash-commands",
		"--strict-mcp-config",
		"--no-session-persistence",
		"--settings", claudeTextGenSettings,
	}
	if req.Model != "" {
		args = append(args, "--model", providers.WireModelID(req.Model))
	}
	if req.System != "" {
		args = append(args, "--system-prompt", req.System)
	}
	return args
}

// parseClaudeTextGenResult reads the result envelope `claude -p
// --output-format json` prints.
func parseClaudeTextGenResult(stdout []byte) (string, error) {
	var envelope struct {
		IsError bool   `json:"is_error"`
		Result  string `json:"result"`
	}
	if err := json.Unmarshal(bytes.TrimSpace(stdout), &envelope); err != nil {
		return "", fmt.Errorf("decode result envelope: %w", err)
	}
	if envelope.IsError {
		return "", fmt.Errorf("cli reported an error: %s", truncatePreview(envelope.Result, 300))
	}
	return envelope.Result, nil
}

// GenerateText answers req with a `claude -p` one-shot on the CLI's own login.
func (b *ClaudeCodeBackend) GenerateText(ctx context.Context, req TextGenRequest) (string, error) {
	return runDelegatedTextGen(ctx, "claude-code", "claude", req, req.Prompt,
		func(string) []string { return buildClaudeTextGenArgs(req) },
		func(_ string, stdout []byte) (string, error) { return parseClaudeTextGenResult(stdout) },
	)
}

// codexTextGenOutputFile is where `codex exec` is told to write its answer.
const codexTextGenOutputFile = "last-message.txt"

// buildCodexTextGenArgs assembles the argv for a `codex exec` one-shot that
// reads its prompt from stdin and writes its answer into dir.
func buildCodexTextGenArgs(req TextGenRequest, dir string) []string {
	args := []string{
		"exec",
		"--skip-git-repo-check",
		"--ephemeral",
		"--ignore-rules",
		"--sandbox", "read-only",
		"-c", "model_reasoning_effort=low",
		"--output-last-message", filepath.Join(dir, codexTextGenOutputFile),
	}
	if req.Model != "" {
		args = append(args, "--model", providers.WireModelID(req.Model))
	}
	return append(args, "-")
}

// codexTextGenStdin joins the system instruction and the prompt: `codex exec`
// takes one prompt and has no separate system-prompt input.
func codexTextGenStdin(req TextGenRequest) string {
	if req.System == "" {
		return req.Prompt
	}
	return req.System + "\n\n" + req.Prompt
}

// GenerateText answers req with a `codex exec` one-shot on the CLI's own login.
func (b *CodexBackend) GenerateText(ctx context.Context, req TextGenRequest) (string, error) {
	return runDelegatedTextGen(ctx, "codex", codexBinaryName, req, codexTextGenStdin(req),
		func(dir string) []string { return buildCodexTextGenArgs(req, dir) },
		func(dir string, _ []byte) (string, error) {
			out, err := os.ReadFile(filepath.Join(dir, codexTextGenOutputFile))
			if err != nil {
				return "", fmt.Errorf("read answer file: %w", err)
			}
			return string(out), nil
		},
	)
}

// GenerateText routes req to the delegated CLI that would serve a run of its
// model. A model that routes to the API backend, or to a CLI kind with no
// one-shot mode, returns ErrTextGenUnsupported.
func (h *HybridBackend) GenerateText(ctx context.Context, req TextGenRequest) (string, error) {
	kind := h.resolveKind(req.Model, false, nil)
	if kind == "api" {
		utils.LogWithFields(utils.LevelDebug, "backend.textgen", "model routes to api, not delegated", map[string]any{"model": req.Model})
		return "", ErrTextGenUnsupported
	}
	generator, ok := h.get(kind).(TextGenerator)
	if !ok {
		utils.LogWithFields(utils.LevelInfo, "backend.textgen", "backend kind has no text generation", map[string]any{
			"model": req.Model, "kind": kind,
		})
		return "", ErrTextGenUnsupported
	}
	utils.LogWithFields(utils.LevelDebug, "backend.textgen", "routing to delegated cli", map[string]any{"model": req.Model, "kind": kind})
	return generator.GenerateText(ctx, req)
}
