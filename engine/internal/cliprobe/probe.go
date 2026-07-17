package cliprobe

import (
	"context"
	"os"
	"os/exec"
	"strings"
	"time"

	"github.com/dsswift/ion/engine/internal/acp"
	"github.com/dsswift/ion/engine/internal/codexrpc"
	"github.com/dsswift/ion/engine/internal/rpcstdio"
	"github.com/dsswift/ion/engine/internal/types"
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

// probeClaudeCode reports install + version. Claude Code manages its own auth;
// the engine treats an installed binary as usable (matching prior behavior).
func probeClaudeCode() Probe {
	p := Probe{Kind: "claude-code"}
	bin, err := Find("claude", nil)
	if err != nil {
		return p
	}
	p.Installed = true
	p.BinaryPath = bin
	p.Version = cliVersion(bin)
	p.Authenticated = true
	p.AuthMethod = "subscription"
	return p
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
		if a.PlanType == "" || a.PlanType == "unknown" {
			return "ChatGPT"
		}
		return "ChatGPT " + strings.Title(strings.ReplaceAll(a.PlanType, "_", " ")) //nolint:staticcheck // ASCII plan labels
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
