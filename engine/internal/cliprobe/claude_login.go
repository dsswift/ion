package cliprobe

import (
	"bufio"
	"context"
	"errors"
	"io"
	"os/exec"
	"regexp"
	"strings"
	"sync"

	"github.com/dsswift/ion/engine/internal/utils"
)

// Claude Code's login is a plain interactive CLI flow, not a JSON-RPC surface
// like codex's app-server or the ACP agents.
//
// What `claude auth login --claudeai` actually does (verified against CLI
// 2.1.206): it starts a loopback callback server, opens the browser itself, and
// ALSO prints a fallback URL for the case where the browser did not open. The
// two URLs differ in their redirect_uri — the opened one points at
// 127.0.0.1:<port>/callback and can complete on its own; the printed fallback
// points at platform.claude.com and cannot, so it hands the user a code to
// paste. The CLI reads that code from stdin ("Paste code here if prompted >").
//
// The engine drives the fallback path: it cannot observe the CLI's loopback
// completion, so it scrapes the printed URL, surfaces it, and feeds the pasted
// code back into the child's stdin. That is why this flow needs the
// await_auth_code stage and the provider_login_code command — the code has to
// travel from the consumer back into a live subprocess.
//
// Because the CLI opens its own browser, consumers must NOT auto-open the
// scraped fallback URL on await_browser: doing so yields two tabs, and the
// scraped one is the tab that cannot self-complete. It is offered as an
// on-demand affordance instead.

// claudeAuthURLPattern matches the fallback authorize URL the CLI prints.
// Anchored on the known host+path so unrelated output can never be mistaken
// for it.
var claudeAuthURLPattern = regexp.MustCompile(`https://claude\.com/cai/oauth/authorize\S*`)

// errClaudeLoginNoCode reports that the flow ended before a code arrived.
var errClaudeLoginNoCode = errors.New("claude login ended before an auth code was supplied")

// errNoAuthCodeChannel reports that no consumer channel was registered to
// deliver the auth code this login needs.
var errNoAuthCodeChannel = errors.New("no auth-code channel registered for this login")

// authCodeCtxKey is the context key carrying an in-flight login's auth-code
// channel. Unexported so only WithAuthCodeChannel can install one.
type authCodeCtxKey struct{}

// WithAuthCodeChannel returns a context carrying the channel a login driver
// reads a consumer-supplied authorization code from.
//
// The channel rides on the context rather than package state so it is scoped to
// exactly one login. A package-level supplier would be a single slot shared by
// every provider: a second concurrent login (a different provider in the same
// settings dialog) would overwrite it, routing the first provider's pasted code
// into the second's subprocess and stranding the first until its ceiling fired.
// Context scoping makes that impossible by construction.
func WithAuthCodeChannel(ctx context.Context, codes <-chan string) context.Context {
	return context.WithValue(ctx, authCodeCtxKey{}, codes)
}

// WaitForAuthCode blocks until the consumer supplies an authorization code for
// this login, or ctx ends. Login drivers call it after emitting the
// await_auth_code stage. Returns an error when the context carries no channel,
// so a driver never blocks forever on something nobody will feed.
func WaitForAuthCode(ctx context.Context) (string, error) {
	codes, ok := ctx.Value(authCodeCtxKey{}).(<-chan string)
	if !ok || codes == nil {
		return "", errNoAuthCodeChannel
	}
	select {
	case code, open := <-codes:
		if !open {
			return "", errNoAuthCodeChannel
		}
		return code, nil
	case <-ctx.Done():
		return "", ctx.Err()
	}
}

// loginClaudeCode drives `claude auth login --claudeai`. It emits started, then
// await_browser with the scraped authorize URL, then await_auth_code, then waits
// for the consumer to supply the code, writes it to the child's stdin, and emits
// completed or failed from the child's exit status.
//
// Every terminal path emits exactly one terminal stage, so a consumer can never
// be left waiting on a login that has already ended.
func loginClaudeCode(ctx context.Context, emit LoginEmit) error {
	bin, err := Find("claude", nil)
	if err != nil {
		emit(LoginStage{Stage: "failed", Error: "claude CLI not installed"})
		return err
	}

	cmd := exec.CommandContext(ctx, bin, "auth", "login", "--claudeai")
	stdin, err := cmd.StdinPipe()
	if err != nil {
		emit(LoginStage{Stage: "failed", Error: err.Error()})
		return err
	}
	// The CLI writes the prompt and the URL across stdout/stderr; merge them so
	// URL scraping does not depend on which stream it chose.
	outR, outW := io.Pipe()
	cmd.Stdout = outW
	cmd.Stderr = outW

	if err := cmd.Start(); err != nil {
		emit(LoginStage{Stage: "failed", Error: err.Error()})
		utils.LogWithFields(utils.LevelError, "cliprobe", "claude-code login start failed", map[string]any{"error": utils.ErrStr(err)})
		return err
	}
	utils.LogWithFields(utils.LevelInfo, "cliprobe", "claude-code login started", map[string]any{"binaryPath": bin})
	emit(LoginStage{Stage: "started"})

	// Close the merged writer when the process exits so the scanner terminates.
	waitErr := make(chan error, 1)
	go func() {
		err := cmd.Wait()
		outW.CloseWithError(io.EOF) //nolint:errcheck // pipe close always succeeds; scanner drains on EOF
		waitErr <- err
	}()

	// Scrape output for the printed fallback authorize URL, emitting
	// await_browser once. The CLI has already opened its own (loopback) tab by
	// this point; this URL is the manual fallback, surfaced for consumers to
	// offer on demand rather than auto-open.
	urlSeen := make(chan string, 1)
	var output strings.Builder
	var outputMu sync.Mutex
	go func() {
		scanner := bufio.NewScanner(outR)
		scanner.Buffer(make([]byte, 0, 64*1024), 512*1024)
		emitted := false
		for scanner.Scan() {
			line := scanner.Text()
			outputMu.Lock()
			output.WriteString(line)
			output.WriteString("\n")
			outputMu.Unlock()
			if !emitted {
				if m := claudeAuthURLPattern.FindString(line); m != "" {
					emitted = true
					select {
					case urlSeen <- m:
					default:
					}
				}
			}
		}
		close(urlSeen)
	}()

	if u, ok := <-urlSeen; ok && u != "" {
		utils.LogWithFields(utils.LevelInfo, "cliprobe", "claude-code login awaiting browser (CLI opened its own tab; surfacing fallback URL)", nil)
		emit(LoginStage{Stage: "await_browser", AuthURL: u})
	} else {
		// The CLI exited (or printed no URL) before reaching the browser step.
		err := <-waitErr
		reason := claudeFailureReason(&output, &outputMu, err)
		utils.LogWithFields(utils.LevelWarn, "cliprobe", "claude-code login ended before browser stage", map[string]any{"error": utils.ErrStr(err), "reason": reason})
		emit(LoginStage{Stage: "failed", Error: reason})
		if err != nil {
			return err
		}
		return errClaudeLoginNoCode
	}

	// The CLI now waits on stdin for the authorization code.
	emit(LoginStage{Stage: "await_auth_code"})
	code, err := WaitForAuthCode(ctx)
	if err != nil {
		_ = stdin.Close() //nolint:errcheck // terminal path; child is killed below
		killLogin(cmd)
		<-waitErr
		if ctx.Err() != nil {
			utils.LogWithFields(utils.LevelInfo, "cliprobe", "claude-code login cancelled awaiting code", nil)
			emit(LoginStage{Stage: "cancelled"})
			return ctx.Err()
		}
		utils.LogWithFields(utils.LevelWarn, "cliprobe", "claude-code login code wait failed", map[string]any{"error": utils.ErrStr(err)})
		emit(LoginStage{Stage: "failed", Error: err.Error()})
		return err
	}

	if _, err := io.WriteString(stdin, strings.TrimSpace(code)+"\n"); err != nil {
		_ = stdin.Close() //nolint:errcheck // terminal path; child is killed below
		killLogin(cmd)
		<-waitErr
		utils.LogWithFields(utils.LevelError, "cliprobe", "claude-code login code write failed", map[string]any{"error": utils.ErrStr(err)})
		emit(LoginStage{Stage: "failed", Error: err.Error()})
		return err
	}
	if err := stdin.Close(); err != nil {
		utils.LogWithFields(utils.LevelDebug, "cliprobe", "claude-code login stdin close", map[string]any{"error": utils.ErrStr(err)})
	}

	if err := <-waitErr; err != nil {
		reason := claudeFailureReason(&output, &outputMu, err)
		utils.LogWithFields(utils.LevelWarn, "cliprobe", "claude-code login failed", map[string]any{"error": utils.ErrStr(err), "reason": reason})
		emit(LoginStage{Stage: "failed", Error: reason})
		return err
	}
	utils.LogWithFields(utils.LevelInfo, "cliprobe", "claude-code login completed", nil)
	emit(LoginStage{Stage: "completed"})
	return nil
}

// killLogin terminates the login subprocess, ignoring an already-exited process.
func killLogin(cmd *exec.Cmd) {
	if cmd.Process == nil {
		return
	}
	if err := cmd.Process.Kill(); err != nil {
		utils.LogWithFields(utils.LevelDebug, "cliprobe", "claude-code login kill", map[string]any{"error": utils.ErrStr(err)})
	}
}

// claudeFailureReason picks the most useful failure string: the CLI's last
// non-empty output line when there is one, else the process error.
func claudeFailureReason(output *strings.Builder, mu *sync.Mutex, err error) string {
	mu.Lock()
	raw := output.String()
	mu.Unlock()
	lines := strings.Split(strings.TrimSpace(raw), "\n")
	for i := len(lines) - 1; i >= 0; i-- {
		if line := strings.TrimSpace(lines[i]); line != "" {
			return line
		}
	}
	if err != nil {
		return err.Error()
	}
	return "claude login failed"
}

// logoutClaudeCode runs `claude auth logout`, which is fully non-interactive.
func logoutClaudeCode(ctx context.Context) error {
	if _, ok := ctx.Deadline(); !ok {
		var cancel context.CancelFunc
		ctx, cancel = context.WithTimeout(ctx, logoutTimeout)
		defer cancel()
	}
	bin, err := Find("claude", nil)
	if err != nil {
		return err
	}
	out, err := exec.CommandContext(ctx, bin, "auth", "logout").CombinedOutput()
	if err != nil {
		utils.LogWithFields(utils.LevelWarn, "cliprobe", "claude-code logout failed", map[string]any{
			"error": utils.ErrStr(err), "output": strings.TrimSpace(string(out)),
		})
		return err
	}
	utils.LogWithFields(utils.LevelInfo, "cliprobe", "claude-code logout completed", nil)
	return nil
}
