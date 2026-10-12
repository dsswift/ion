package cliprobe

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"regexp"
	"strings"
	"sync"
	"time"

	"github.com/dsswift/ion/engine/internal/procctl"
	"github.com/dsswift/ion/engine/internal/utils"
)

// A Claude Code login by long-lived token carries no profile: `claude auth
// status` names no email, organization, or plan for it. The organization is
// still knowable, because the provider names it on every response. The read
// here has the CLI run one small turn with its HTTP client's debug log on,
// and takes the organization from what the CLI printed. The CLI alone sends
// the credential; the engine never reads or transmits it.

// DefaultClaudeOrgModel is the model the organization read runs its turn on
// when the configuration names none.
const DefaultClaudeOrgModel = "claude-haiku-4-5-20251001"

const (
	// claudeOrgTimeout bounds the one turn of an organization read.
	claudeOrgTimeout = 60 * time.Second
	// claudeOrgFresh is how long a resolved organization stands before it is
	// read again: the login behind an unchanged auth method can change.
	claudeOrgFresh = 24 * time.Hour
	// claudeOrgRetry is how long a failed read waits before the next one, so
	// a login that cannot run a turn is not asked on every usage read.
	claudeOrgRetry = time.Hour
)

// claudeOrgSettings turns off hooks and extended thinking for the turn.
const claudeOrgSettings = `{"disableAllHooks":true,"alwaysThinkingEnabled":false}`

// claudeOrgHeader matches the organization header in the CLI's debug log of
// a response.
var claudeOrgHeader = regexp.MustCompile(`"anthropic-organization-id":\s*"([0-9A-Za-z_-]+)"`)

// claudeOrgRunner runs one tool-less turn on model with the CLI's HTTP debug
// log on and returns everything it printed. A package var so tests can
// inject output instead of spawning the CLI.
var claudeOrgRunner = func(ctx context.Context, bin, model string) ([]byte, error) {
	cmd := exec.CommandContext(ctx, bin,
		"-p",
		"--output-format", "json",
		"--tools", "",
		"--disable-slash-commands",
		"--strict-mcp-config",
		"--no-session-persistence",
		"--settings", claudeOrgSettings,
		"--model", model,
		"--system-prompt", "Reply with ok.",
	)
	// A neutral working directory: the turn needs no project context.
	cmd.Dir = os.TempDir()
	cmd.Env = append(os.Environ(), "ANTHROPIC_LOG=debug")
	cmd.Stdin = strings.NewReader("ok")
	procctl.Configure(cmd)
	var out bytes.Buffer
	cmd.Stdout = &out
	cmd.Stderr = &out
	if err := cmd.Start(); err != nil {
		return nil, fmt.Errorf("start claude: %w", err)
	}
	defer procctl.Release(cmd)
	if err := procctl.AfterStart(cmd); err != nil {
		procctl.KillTree(cmd) //nolint:errcheck // already exited is fine
		cmd.Wait()            //nolint:errcheck // reaped; its exit status is the kill
		return nil, fmt.Errorf("track claude: %w", err)
	}
	err := cmd.Wait()
	if ctx.Err() != nil {
		procctl.KillTree(cmd) //nolint:errcheck // already exited is fine
		return out.Bytes(), fmt.Errorf("claude did not finish the turn: %w", ctx.Err())
	}
	return out.Bytes(), err
}

// parseClaudeOrg takes the organization id from the CLI's debug log.
func parseClaudeOrg(out []byte) (string, error) {
	m := claudeOrgHeader.FindSubmatch(out)
	if m == nil {
		return "", errors.New("the cli's debug log names no organization")
	}
	return string(m[1]), nil
}

// ClaudeOrgResolver reads and remembers the organization of a Claude Code
// login whose auth status names none. One read spends one small model turn,
// so an answer stands for claudeOrgFresh and a failure for claudeOrgRetry.
type ClaudeOrgResolver struct {
	mu         sync.Mutex
	authMethod string
	orgID      string
	nextRead   time.Time
	now        func() time.Time
}

// NewClaudeOrgResolver returns a resolver that has read nothing yet.
func NewClaudeOrgResolver() *ClaudeOrgResolver {
	return &ClaudeOrgResolver{now: time.Now}
}

// Resolve returns the organization of the login with authMethod, reading it
// on model when no fresh answer is held. It returns "" when the read fails.
// A changed auth method is a different login and is read at once.
func (r *ClaudeOrgResolver) Resolve(authMethod, model string) string {
	r.mu.Lock()
	defer r.mu.Unlock()
	now := r.now()
	if r.authMethod == authMethod && now.Before(r.nextRead) {
		utils.LogWithFields(utils.LevelDebug, "cliprobe", "claude-code organization held", map[string]any{
			"authMethod": authMethod, "resolved": r.orgID != "",
		})
		return r.orgID
	}
	if model == "" {
		model = DefaultClaudeOrgModel
	}
	r.authMethod = authMethod
	orgID, err := readClaudeOrg(model)
	if err != nil {
		// The last good answer for this login stands until a read succeeds.
		r.nextRead = now.Add(claudeOrgRetry)
		return r.orgID
	}
	r.orgID = orgID
	r.nextRead = now.Add(claudeOrgFresh)
	return orgID
}

func readClaudeOrg(model string) (string, error) {
	bin, err := claudeFinder()
	if err != nil {
		utils.LogWithFields(utils.LevelWarn, "cliprobe", "claude-code organization read failed", map[string]any{"error": err.Error()})
		return "", fmt.Errorf("claude is not installed: %w", err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), claudeOrgTimeout)
	defer cancel()
	started := time.Now()
	out, runErr := claudeOrgRunner(ctx, bin, model)
	// The organization is in the log of the first response, so a turn that
	// ended badly after it still answers the read.
	orgID, err := parseClaudeOrg(out)
	if err != nil {
		utils.LogWithFields(utils.LevelWarn, "cliprobe", "claude-code organization read failed", map[string]any{
			"binaryPath": bin, "model": model, "error": err.Error(), "run_error": utils.ErrStr(runErr),
			"output_bytes": len(out), "duration_ms": time.Since(started).Milliseconds(),
		})
		return "", err
	}
	utils.LogWithFields(utils.LevelInfo, "cliprobe", "claude-code organization read", map[string]any{
		"binaryPath": bin, "model": model, "org_id": orgID, "duration_ms": time.Since(started).Milliseconds(),
	})
	return orgID, nil
}
