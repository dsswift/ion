package cliprobe

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"time"

	"github.com/dsswift/ion/engine/internal/codexrpc"
	"github.com/dsswift/ion/engine/internal/procctl"
	"github.com/dsswift/ion/engine/internal/rpcstdio"
	"github.com/dsswift/ion/engine/internal/types"
	"github.com/dsswift/ion/engine/internal/utils"
)

// usageTimeout bounds one CLI usage read.
const usageTimeout = 20 * time.Second

// claudeUsageRequestID correlates the one control request a usage read sends.
const claudeUsageRequestID = "ion-usage"

// UsageFunc reads the usage limits a backend kind's CLI reports for its
// signed-in account.
type UsageFunc func(kind string) ([]types.ProviderUsageLimit, error)

// ErrNoUsage means the backend kind has no usage read.
var ErrNoUsage = errors.New("this backend reports no usage limits")

// DefaultUsage dispatches to the per-kind usage read. The CLI itself talks
// to its provider; the engine never handles the account's credential.
func DefaultUsage(kind string) ([]types.ProviderUsageLimit, error) {
	switch kind {
	case "claude-code":
		return readClaudeUsage()
	case "codex":
		return readCodexUsage()
	default:
		return nil, ErrNoUsage
	}
}

// claudeUsageRunner starts the claude CLI in stream-json mode, sends the
// get_usage control request, and returns the matching control_response line.
// A package var so tests can inject a payload instead of spawning the CLI.
var claudeUsageRunner = func(ctx context.Context, bin string) ([]byte, error) {
	cmd := exec.CommandContext(ctx, bin, "-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose", "--no-session-persistence")
	// A neutral working directory: the read needs no project context.
	cmd.Dir = os.TempDir()
	procctl.Configure(cmd)
	stdin, err := cmd.StdinPipe()
	if err != nil {
		return nil, fmt.Errorf("claude stdin: %w", err)
	}
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return nil, fmt.Errorf("claude stdout: %w", err)
	}
	if err := cmd.Start(); err != nil {
		return nil, fmt.Errorf("start claude: %w", err)
	}
	defer func() {
		stdin.Close()         //nolint:errcheck // the process is being torn down
		procctl.KillTree(cmd) //nolint:errcheck // already exited is fine
		cmd.Wait()            //nolint:errcheck // reaped; its exit status is the kill
		procctl.Release(cmd)
	}()
	if err := procctl.AfterStart(cmd); err != nil {
		return nil, fmt.Errorf("track claude: %w", err)
	}
	req, err := json.Marshal(map[string]any{
		"type":       "control_request",
		"request_id": claudeUsageRequestID,
		"request":    map[string]any{"subtype": "get_usage"},
	})
	if err != nil {
		return nil, err
	}
	if _, err := stdin.Write(append(req, '\n')); err != nil {
		return nil, fmt.Errorf("write usage request: %w", err)
	}
	sc := bufio.NewScanner(stdout)
	sc.Buffer(make([]byte, 0, 64*1024), 4*1024*1024)
	for sc.Scan() {
		var head struct {
			Type     string `json:"type"`
			Response struct {
				RequestID string `json:"request_id"`
			} `json:"response"`
		}
		line := sc.Bytes()
		if json.Unmarshal(line, &head) != nil || head.Type != "control_response" || head.Response.RequestID != claudeUsageRequestID {
			continue
		}
		return append([]byte(nil), line...), nil
	}
	if err := sc.Err(); err != nil {
		return nil, fmt.Errorf("read claude output: %w", err)
	}
	if ctx.Err() != nil {
		return nil, fmt.Errorf("claude did not answer the usage request: %w", ctx.Err())
	}
	return nil, errors.New("claude exited without answering the usage request")
}

// claudeUsageWindow is one window of the claude usage answer. Utilization is
// a percentage (0..100).
type claudeUsageWindow struct {
	Utilization *float64 `json:"utilization"`
	ResetsAt    string   `json:"resets_at"`
}

// claudeUsageResponse is the control_response to get_usage. Only the fields
// the read projects are declared; the CLI emits more.
type claudeUsageResponse struct {
	Response struct {
		Subtype  string `json:"subtype"`
		Error    string `json:"error"`
		Response struct {
			RateLimitsAvailable bool `json:"rate_limits_available"`
			RateLimits          *struct {
				FiveHour    *claudeUsageWindow `json:"five_hour"`
				SevenDay    *claudeUsageWindow `json:"seven_day"`
				ModelScoped []struct {
					DisplayName string   `json:"display_name"`
					Utilization *float64 `json:"utilization"`
					ResetsAt    string   `json:"resets_at"`
				} `json:"model_scoped"`
				Spend *struct {
					Enabled bool     `json:"enabled"`
					Percent *float64 `json:"percent"`
				} `json:"spend"`
			} `json:"rate_limits"`
		} `json:"response"`
	} `json:"response"`
}

func readClaudeUsage() ([]types.ProviderUsageLimit, error) {
	bin, err := claudeFinder()
	if err != nil {
		return nil, fmt.Errorf("claude is not installed: %w", err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), usageTimeout)
	defer cancel()
	raw, err := claudeUsageRunner(ctx, bin)
	if err != nil {
		utils.LogWithFields(utils.LevelWarn, "cliprobe", "claude-code usage read failed", map[string]any{"binaryPath": bin, "error": err.Error()})
		return nil, err
	}
	limits, err := parseClaudeUsage(raw)
	if err != nil {
		utils.LogWithFields(utils.LevelWarn, "cliprobe", "claude-code usage answer not understood", map[string]any{"binaryPath": bin, "error": err.Error()})
		return nil, err
	}
	utils.LogWithFields(utils.LevelInfo, "cliprobe", "claude-code usage read", map[string]any{"binaryPath": bin, "limit_count": len(limits)})
	return limits, nil
}

// parseClaudeUsage projects the get_usage answer onto usage limits. An
// account with no subscription windows (an API-key login) yields none.
func parseClaudeUsage(raw []byte) ([]types.ProviderUsageLimit, error) {
	var res claudeUsageResponse
	if err := json.Unmarshal(raw, &res); err != nil {
		return nil, fmt.Errorf("decode usage answer: %w", err)
	}
	if res.Response.Subtype != "success" {
		return nil, fmt.Errorf("claude refused the usage request: %s", firstNonEmpty(res.Response.Error, res.Response.Subtype))
	}
	rl := res.Response.Response.RateLimits
	limits := []types.ProviderUsageLimit{}
	if rl == nil {
		return limits, nil
	}
	add := func(kind, label string, pct *float64, resetsAt string) {
		if pct == nil {
			return
		}
		limits = append(limits, types.ProviderUsageLimit{Kind: kind, Label: label, Percent: *pct, ResetsAt: resetsAt})
	}
	if w := rl.FiveHour; w != nil {
		add(types.UsageLimitSession, "", w.Utilization, w.ResetsAt)
	}
	if w := rl.SevenDay; w != nil {
		add(types.UsageLimitWeekly, "", w.Utilization, w.ResetsAt)
	}
	for _, m := range rl.ModelScoped {
		add(types.UsageLimitWeeklyModel, m.DisplayName, m.Utilization, m.ResetsAt)
	}
	if s := rl.Spend; s != nil && s.Enabled {
		add(types.UsageLimitSpend, "", s.Percent, "")
	}
	return limits, nil
}

// codexUsageReader spawns `codex app-server` and reads the account's rate
// limits. A package var so tests can inject a snapshot.
var codexUsageReader = func(ctx context.Context, bin string) (*codexrpc.AccountRateLimitsResult, error) {
	proc, err := rpcstdio.Spawn(ctx, bin, []string{"app-server"}, nil, rpcstdio.Options{Tag: "cliprobe.codex.usage"})
	if err != nil {
		return nil, fmt.Errorf("start codex: %w", err)
	}
	defer proc.Kill()
	client := codexrpc.NewClientFromRPC(proc.Client, codexrpc.Handlers{})
	if _, err := client.Initialize(ctx, codexrpc.ClientInfo{Name: "ion-engine-probe", Version: "1"}); err != nil {
		return nil, err
	}
	return client.AccountRateLimitsRead(ctx)
}

// codexFinder resolves the codex binary; a package var for tests.
var codexFinder = func() (string, error) {
	return Find("codex", nil)
}

func readCodexUsage() ([]types.ProviderUsageLimit, error) {
	bin, err := codexFinder()
	if err != nil {
		return nil, fmt.Errorf("codex is not installed: %w", err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), usageTimeout)
	defer cancel()
	res, err := codexUsageReader(ctx, bin)
	if err != nil {
		utils.LogWithFields(utils.LevelWarn, "cliprobe", "codex usage read failed", map[string]any{"binaryPath": bin, "error": err.Error()})
		return nil, err
	}
	limits := codexLimits(res.RateLimits)
	utils.LogWithFields(utils.LevelInfo, "cliprobe", "codex usage read", map[string]any{"binaryPath": bin, "limit_count": len(limits)})
	return limits, nil
}

// codexWeeklyMins is the shortest window the read calls weekly: anything
// longer than a day.
const codexWeeklyMins = 24 * 60

// codexLimits projects a codex snapshot onto usage limits. A window's kind
// comes from its length; with no length, primary is the session window and
// secondary the weekly one.
func codexLimits(s codexrpc.RateLimitSnapshot) []types.ProviderUsageLimit {
	limits := []types.ProviderUsageLimit{}
	add := func(w *codexrpc.RateLimitWindow, fallback string) {
		if w == nil {
			return
		}
		kind := fallback
		if w.WindowDurationMins != nil {
			kind = types.UsageLimitSession
			if *w.WindowDurationMins > codexWeeklyMins {
				kind = types.UsageLimitWeekly
			}
		}
		l := types.ProviderUsageLimit{Kind: kind, Percent: w.UsedPercent}
		if w.ResetsAt != nil {
			l.ResetsAt = time.Unix(*w.ResetsAt, 0).UTC().Format(time.RFC3339)
		}
		limits = append(limits, l)
	}
	add(s.Primary, types.UsageLimitSession)
	add(s.Secondary, types.UsageLimitWeekly)
	return limits
}

func firstNonEmpty(values ...string) string {
	for _, v := range values {
		if v != "" {
			return v
		}
	}
	return ""
}
