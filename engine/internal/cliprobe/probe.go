package cliprobe

import (
	"context"
	"encoding/json"
	"os"
	"os/exec"
	"strings"
	"time"

	"github.com/dsswift/ion/engine/internal/acp"
	"github.com/dsswift/ion/engine/internal/codexrpc"
	"github.com/dsswift/ion/engine/internal/rpcstdio"
	"github.com/dsswift/ion/engine/internal/types"
	"github.com/dsswift/ion/engine/internal/utils"
)

// probeTimeout bounds each CLI interrogation so a hung binary cannot stall the
// probe registry refresh.
const probeTimeout = 8 * time.Second

// Probe is a snapshot of a delegated CLI's install and auth state, plus any
// models it advertised during the probe.
type Probe struct {
	Kind          string
	Installed     bool
	BinaryPath    string
	Version       string
	Authenticated bool
	AuthMethod    string
	PlanType      string
	Email         string
	Label         string
	Models        []types.ModelEntry
}

// ProbeFunc interrogates one backend kind and returns its Probe.
type ProbeFunc func(kind string) Probe

// DefaultProbe dispatches to the per-kind probe implementation.
func DefaultProbe(kind string) Probe {
	switch kind {
	case "codex":
		return probeCodex()
	case "grok":
		return probeACP(kind, "grok", []string{"agent", "stdio"}, []string{"GROK_OAUTH2_REFERRER=ion"}, "xai")
	case "cursor":
		return probeACP(kind, "agent", []string{"acp"}, nil, "cursor")
	case "claude-code":
		return probeClaudeCode()
	default:
		return Probe{Kind: kind}
	}
}

// claudeAuthStatus is the payload of `claude auth status --json`. Only the
// fields the probe projects are declared; the CLI may emit more.
type claudeAuthStatus struct {
	LoggedIn         bool   `json:"loggedIn"`
	AuthMethod       string `json:"authMethod"`
	APIProvider      string `json:"apiProvider"`
	Email            string `json:"email"`
	OrgName          string `json:"orgName"`
	SubscriptionType string `json:"subscriptionType"`
}

// claudeAuthRunner runs `claude auth status --json` and returns raw stdout. A
// package var so tests can inject a deterministic payload instead of spawning
// the real CLI.
var claudeAuthRunner = func(ctx context.Context, bin string) ([]byte, error) {
	return exec.CommandContext(ctx, bin, "auth", "status", "--json").Output()
}

// claudeFinder resolves the claude binary. A package var so tests can exercise
// the auth-parsing branches on a machine (or CI runner) with no claude
// installed — without it the probe's behavior would only ever be asserted on
// developer machines that happen to have the CLI.
var claudeFinder = func() (string, error) {
	return Find("claude", nil)
}

// probeClaudeCode reports install + version, then interrogates real auth state
// via `claude auth status --json`. Authentication is never inferred from install
// state: a binary on disk says nothing about whether the user is signed in, and
// reporting a false authed state both paints a green "ready" badge over a
// non-functional provider and lets routing send runs to a signed-out CLI.
//
// Fails closed — any spawn error, non-zero exit, or unparseable payload leaves
// Authenticated false.
func probeClaudeCode() Probe {
	p := Probe{Kind: "claude-code"}
	bin, err := claudeFinder()
	if err != nil {
		utils.LogWithFields(utils.LevelInfo, "cliprobe", "claude-code not installed", map[string]any{"error": utils.ErrStr(err)})
		return p
	}
	p.Installed = true
	p.BinaryPath = bin
	p.Version = cliVersion(bin)

	ctx, cancel := context.WithTimeout(context.Background(), probeTimeout)
	defer cancel()
	// A signed-out CLI exits non-zero while still writing the status JSON, so
	// the output is parsed regardless of exit status; only a missing payload is
	// treated as a hard failure.
	out, runErr := claudeAuthRunner(ctx, bin)
	if len(out) == 0 {
		utils.LogWithFields(utils.LevelWarn, "cliprobe", "claude-code auth status produced no output", map[string]any{
			"binaryPath": bin, "error": utils.ErrStr(runErr),
		})
		return p
	}
	var st claudeAuthStatus
	if err := json.Unmarshal(out, &st); err != nil {
		utils.LogWithFields(utils.LevelWarn, "cliprobe", "claude-code auth status decode failed", map[string]any{
			"binaryPath": bin, "error": utils.ErrStr(err),
		})
		return p
	}

	p.Authenticated = st.LoggedIn
	p.AuthMethod = st.AuthMethod
	p.PlanType = st.SubscriptionType
	p.Email = st.Email
	p.Label = claudeLabel(st)
	utils.LogWithFields(utils.LevelInfo, "cliprobe", "claude-code auth status resolved", map[string]any{
		"binaryPath": bin, "authenticated": st.LoggedIn, "authMethod": st.AuthMethod,
		"apiProvider": st.APIProvider, "planType": st.SubscriptionType, "label": p.Label,
	})
	return p
}

// titleCaseWords upper-cases the first letter of each space-separated word,
// leaving the rest untouched. Plan identifiers are ASCII (`max`, `team_premium`),
// so a byte-wise pass is correct and avoids the deprecated strings.Title.
func titleCaseWords(s string) string {
	words := strings.Split(s, " ")
	for i, w := range words {
		if w == "" {
			continue
		}
		words[i] = strings.ToUpper(w[:1]) + w[1:]
	}
	return strings.Join(words, " ")
}

// planLabel renders "<prefix> <Humanized Plan>" for a subscription plan, or the
// bare prefix when the CLI reported no usable plan. Shared by the claude-code and
// codex label builders so both surfaces humanize plans identically.
func planLabel(prefix, plan string) string {
	if plan == "" || plan == "unknown" {
		return prefix
	}
	return prefix + " " + titleCaseWords(strings.ReplaceAll(plan, "_", " "))
}

// claudeLabel renders a human-friendly auth label for a Claude Code account,
// mirroring codexLabel's role for the codex CLI. Empty when signed out.
func claudeLabel(st claudeAuthStatus) string {
	if !st.LoggedIn {
		return ""
	}
	switch st.AuthMethod {
	case "console":
		return "Anthropic Console"
	default:
		// claude.ai subscription: surface the plan when the CLI reports one.
		return planLabel("Claude", st.SubscriptionType)
	}
}

// probeCodex spawns `codex app-server`, initializes, and reads the account.
func probeCodex() Probe {
	p := Probe{Kind: "codex"}
	bin, err := Find("codex", nil)
	if err != nil {
		return p
	}
	p.Installed = true
	p.BinaryPath = bin
	p.Version = cliVersion(bin)

	ctx, cancel := context.WithTimeout(context.Background(), probeTimeout)
	defer cancel()
	proc, err := rpcstdio.Spawn(ctx, bin, []string{"app-server"}, nil, rpcstdio.Options{Tag: "cliprobe.codex"})
	if err != nil {
		return p
	}
	defer proc.Kill()
	client := codexrpc.NewClientFromRPC(proc.Client, codexrpc.Handlers{})
	if _, err := client.Initialize(ctx, codexrpc.ClientInfo{Name: "ion-engine-probe", Version: "1"}); err != nil {
		return p
	}
	acct, err := client.AccountRead(ctx, false)
	if err == nil && acct.Account != nil {
		p.Authenticated = !acct.RequiresOpenaiAuth || acct.Account.Type != ""
		p.AuthMethod = acct.Account.Type
		p.PlanType = acct.Account.PlanType
		p.Email = acct.Account.Email
		p.Label = codexLabel(acct.Account)
	}
	if models, err := client.ModelListAll(ctx, ""); err == nil {
		p.Models = codexModelsToEntries("openai", models)
	}
	return p
}

// probeACP spawns an ACP agent, initializes, and reads session models. It does
// not authenticate (that is the login flow's job); an agent that returns
// models from session/new is treated as usable.
func probeACP(kind, binary string, args, envExtra []string, providerID string) Probe {
	p := Probe{Kind: kind}
	bin, err := Find(binary, nil)
	if err != nil {
		return p
	}
	p.Installed = true
	p.BinaryPath = bin
	p.Version = cliVersion(bin)

	ctx, cancel := context.WithTimeout(context.Background(), probeTimeout)
	defer cancel()
	env := envExtra
	if env != nil {
		env = append([]string{}, envExtra...)
	}
	proc, err := rpcstdio.Spawn(ctx, bin, args, appendEnviron(env), acp.SpawnOptions(kind, acp.Handlers{}))
	if err != nil {
		return p
	}
	defer proc.Kill()
	client := acp.NewClientFromRPC(proc.Client, kind, acp.Handlers{})
	init, err := client.Initialize(ctx, acp.ClientInfo{Name: "ion-engine-probe", Version: "1"})
	if err != nil {
		return p
	}
	if init.Meta != nil && init.Meta.ModelState != nil {
		p.Authenticated = true
		p.Models = acpModelsToEntries(providerID, init.Meta.ModelState.AvailableModels)
	}
	if kind == "cursor" {
		if res, err := client.CursorListModels(ctx); err == nil && len(res.Models) > 0 {
			p.Authenticated = true
			p.Models = cursorModelsToEntries(providerID, res.Models)
		}
	}
	return p
}

// cliVersion runs `<bin> --version` and returns the trimmed first line.
func cliVersion(bin string) string {
	ctx, cancel := context.WithTimeout(context.Background(), 4*time.Second)
	defer cancel()
	out, err := exec.CommandContext(ctx, bin, "--version").Output()
	if err != nil {
		return ""
	}
	line := strings.TrimSpace(string(out))
	if i := strings.IndexByte(line, '\n'); i >= 0 {
		line = line[:i]
	}
	return line
}

// codexLabel renders a human-friendly auth label for a codex account.
func codexLabel(a *codexrpc.Account) string {
	if a == nil {
		return ""
	}
	switch a.Type {
	case "apiKey":
		return "OpenAI API Key"
	case "chatgpt":
		return planLabel("ChatGPT", a.PlanType)
	default:
		return ""
	}
}

func codexModelsToEntries(providerID string, models []codexrpc.Model) []types.ModelEntry {
	out := make([]types.ModelEntry, 0, len(models))
	for _, m := range models {
		out = append(out, types.ModelEntry{ID: m.Model, ProviderID: providerID})
	}
	return out
}

func acpModelsToEntries(providerID string, models []acp.ModelInfo) []types.ModelEntry {
	out := make([]types.ModelEntry, 0, len(models))
	for _, m := range models {
		out = append(out, types.ModelEntry{ID: m.ModelID, ProviderID: providerID})
	}
	return out
}

func cursorModelsToEntries(providerID string, models []acp.CursorModel) []types.ModelEntry {
	out := make([]types.ModelEntry, 0, len(models))
	for _, m := range models {
		out = append(out, types.ModelEntry{ID: m.Value, ProviderID: providerID})
	}
	return out
}

// appendEnviron merges extra env onto the process environment. Returns nil when
// there is nothing extra, so Spawn inherits os.Environ() unchanged.
func appendEnviron(extra []string) []string {
	if len(extra) == 0 {
		return nil
	}
	return append(os.Environ(), extra...)
}
