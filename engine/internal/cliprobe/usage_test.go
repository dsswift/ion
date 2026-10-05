package cliprobe

import (
	"context"
	"os"
	"path/filepath"
	"runtime"
	"testing"

	"github.com/dsswift/ion/engine/internal/codexrpc"
	"github.com/dsswift/ion/engine/internal/types"
)

// The verified shape of the Claude CLI's get_usage answer, trimmed to the
// fields the read projects plus neighbors it must ignore.
const claudeUsageAnswer = `{"type":"control_response","response":{"subtype":"success","request_id":"ion-usage","response":{"subscription_type":"max","rate_limits_available":true,"rate_limits":{"five_hour":{"utilization":16,"resets_at":"2026-10-03T17:20:00.494881+00:00"},"seven_day":{"utilization":63,"resets_at":"2026-10-05T21:00:00.494900+00:00"},"seven_day_opus":null,"extra_usage":{"is_enabled":false},"spend":{"percent":0,"enabled":false},"model_scoped":[{"display_name":"Example Model","utilization":76,"resets_at":"2026-10-05T21:00:00.495055+00:00"}]}}}}`

func TestParseClaudeUsage(t *testing.T) {
	limits, err := parseClaudeUsage([]byte(claudeUsageAnswer))
	if err != nil {
		t.Fatal(err)
	}
	want := []types.ProviderUsageLimit{
		{Kind: types.UsageLimitSession, Percent: 16, ResetsAt: "2026-10-03T17:20:00.494881+00:00"},
		{Kind: types.UsageLimitWeekly, Percent: 63, ResetsAt: "2026-10-05T21:00:00.494900+00:00"},
		{Kind: types.UsageLimitWeeklyModel, Label: "Example Model", Percent: 76, ResetsAt: "2026-10-05T21:00:00.495055+00:00"},
	}
	if len(limits) != len(want) {
		t.Fatalf("limits = %+v", limits)
	}
	for i := range want {
		if limits[i] != want[i] {
			t.Errorf("limit %d = %+v, want %+v", i, limits[i], want[i])
		}
	}
}

func TestParseClaudeUsageWithoutSubscription(t *testing.T) {
	limits, err := parseClaudeUsage([]byte(`{"type":"control_response","response":{"subtype":"success","request_id":"ion-usage","response":{"rate_limits_available":false,"rate_limits":null}}}`))
	if err != nil || len(limits) != 0 {
		t.Fatalf("limits = %+v, err = %v", limits, err)
	}
}

func TestParseClaudeUsageRefused(t *testing.T) {
	if _, err := parseClaudeUsage([]byte(`{"type":"control_response","response":{"subtype":"error","request_id":"ion-usage","error":"unsupported"}}`)); err == nil {
		t.Fatal("a refused request parsed as limits")
	}
}

// The real runner against a fake claude: a script that prints other stream
// lines, reads the control request from stdin, and answers it.
func TestReadClaudeUsageAgainstFakeCLI(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("the fake CLI is a shell script")
	}
	dir := t.TempDir()
	bin := filepath.Join(dir, "claude")
	script := "#!/bin/sh\n" +
		"echo '{\"type\":\"system\",\"subtype\":\"init\"}'\n" +
		"read -r line\n" +
		"case \"$line\" in *get_usage*) ;; *) exit 3;; esac\n" +
		"cat <<'JSON'\n" + claudeUsageAnswer + "\nJSON\n" +
		"sleep 30\n"
	if err := os.WriteFile(bin, []byte(script), 0o755); err != nil {
		t.Fatal(err)
	}
	prev := claudeFinder
	claudeFinder = func() (string, error) { return bin, nil }
	t.Cleanup(func() { claudeFinder = prev })

	limits, err := readClaudeUsage()
	if err != nil {
		t.Fatalf("readClaudeUsage: %v", err)
	}
	if len(limits) != 3 || limits[2].Label != "Example Model" {
		t.Fatalf("limits = %+v", limits)
	}
}

func TestCodexLimits(t *testing.T) {
	reset := int64(1791048000)
	short, long := int64(300), int64(10080)
	limits := codexLimits(codexrpc.RateLimitSnapshot{
		Primary:   &codexrpc.RateLimitWindow{UsedPercent: 17, ResetsAt: &reset, WindowDurationMins: &short},
		Secondary: &codexrpc.RateLimitWindow{UsedPercent: 42, WindowDurationMins: &long},
	})
	if len(limits) != 2 {
		t.Fatalf("limits = %+v", limits)
	}
	if limits[0].Kind != types.UsageLimitSession || limits[0].Percent != 17 || limits[0].ResetsAt != "2026-10-03T17:20:00Z" {
		t.Errorf("primary = %+v", limits[0])
	}
	if limits[1].Kind != types.UsageLimitWeekly || limits[1].ResetsAt != "" {
		t.Errorf("secondary = %+v", limits[1])
	}
}

func TestReadCodexUsageThroughReader(t *testing.T) {
	prevFinder, prevReader := codexFinder, codexUsageReader
	codexFinder = func() (string, error) { return "/fake/codex", nil }
	codexUsageReader = func(context.Context, string) (*codexrpc.AccountRateLimitsResult, error) {
		return &codexrpc.AccountRateLimitsResult{RateLimits: codexrpc.RateLimitSnapshot{Primary: &codexrpc.RateLimitWindow{UsedPercent: 5}}}, nil
	}
	t.Cleanup(func() { codexFinder, codexUsageReader = prevFinder, prevReader })
	limits, err := readCodexUsage()
	if err != nil || len(limits) != 1 || limits[0].Kind != types.UsageLimitSession {
		t.Fatalf("limits = %+v, err = %v", limits, err)
	}
}
