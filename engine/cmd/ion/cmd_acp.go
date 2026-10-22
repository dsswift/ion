package main

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/dsswift/ion/engine/internal/acpagent"
	"github.com/dsswift/ion/engine/internal/config"
	"github.com/dsswift/ion/engine/internal/extension"
	"github.com/dsswift/ion/engine/internal/types"
	"github.com/dsswift/ion/engine/internal/utils"
)

// configProfile is the settings.json profile row the options are built from.
type configProfile = types.EngineProfileConfig

// cmdAcp implements `ion acp [--profile <name|id>] [--model <id>]` and
// `ion acp --harness <path> [--title <text>] [--model <id>]`: the engine
// served as an Agent Client Protocol agent over this process's stdio. An ACP
// client (T3 Code's Local ACP command provider, Zed, any ACP editor) spawns
// it; every session it opens is an ordinary session in the running daemon,
// which is started when it is not already up. With --harness the agent is
// that one extension: it names itself after it and offers no profile choice.
//
// stdout is the JSON-RPC channel, so every diagnostic goes to engine.jsonl
// under tag `acp`, never to stdout. stderr carries only a startup failure
// the client can show.
func cmdAcp(flags map[string]string) {
	harness, err := acpHarness(flags)
	if err != nil {
		fmt.Fprintf(os.Stderr, "ion acp: %v\n", err)
		os.Exit(2)
	}
	sock := socketPathOrExit()
	spawned := ensureServer(sock)
	releaseSpawnedServer(spawned)
	engine, err := acpagent.DialEngine(dialNetwork(sock), sock)
	if err != nil {
		fmt.Fprintf(os.Stderr, "ion acp: %v\n", err)
		os.Exit(1)
	}
	cfg := config.LoadConfig("")
	opts := acpOptions(flags, config.LoadProfiles(), cfg.DefaultModel)
	opts.Harness = harness
	if cfg.Auth != nil && cfg.Auth.IdentityProvider != "" {
		opts.SignIn = &acpagent.SignIn{Provider: providerTitle(cfg.Auth.IdentityProvider), OpenURL: openBrowser}
	}
	agent := acpagent.New(engine, os.Stdout, os.Stdin, opts)
	fields := map[string]any{"profile": opts.Profile, "model": opts.Model, "profiles": len(opts.Profiles), "sign_in": opts.SignIn != nil}
	if harness != nil {
		fields["harness"] = harness.Name
		fields["harness_path"] = harness.Path
	}
	utils.LogWithFields(utils.LevelInfo, "acp", "agent started", fields)
	select {
	case <-agent.Done():
	case <-engine.Closed():
		utils.LogWithFields(utils.LevelWarn, "acp", "engine went away; agent exiting", map[string]any{"error": utils.ErrStr(engine.Err())})
	}
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	agent.Shutdown(ctx)
	if err := engine.Close(); err != nil {
		utils.LogWithFields(utils.LevelDebug, "acp", "engine connection close failed", map[string]any{"error": err.Error()})
	}
	utils.LogWithFields(utils.LevelInfo, "acp", "agent stopped", nil)
}

// acpOptions builds the agent options from the flags and the profile
// catalog. Pure, so the flag handling is testable without a daemon.
func acpOptions(flags map[string]string, profiles []configProfile, defaultModel string) acpagent.Options {
	opts := acpagent.Options{Version: version, Profile: flags["profile"], Model: flags["model"], DefaultModel: defaultModel}
	for _, p := range profiles {
		exts := make([]string, 0, len(p.Extensions)+1)
		for _, e := range p.Extensions {
			exts = append(exts, resolveExtensionPath(e))
		}
		if p.ExtensionDir != "" && len(exts) == 0 {
			exts = append(exts, resolveExtensionPath(p.ExtensionDir))
		}
		opts.Profiles = append(opts.Profiles, acpagent.Profile{ID: p.ID, Name: p.Name, Extensions: exts})
	}
	return opts
}

// acpHarness resolves --harness into the one extension a pinned agent
// serves, named by its manifest (else its directory). Nil without the flag.
// --profile picks from the catalog a pinned agent does not offer, so the
// two flags are refused together.
func acpHarness(flags map[string]string) (*acpagent.Harness, error) {
	path := flags["harness"]
	if path == "" {
		if flags["title"] != "" {
			return nil, fmt.Errorf("--title names a harness; pass --harness with it")
		}
		return nil, nil
	}
	if flags["profile"] != "" {
		return nil, fmt.Errorf("--harness and --profile are exclusive: a harness agent loads only its harness")
	}
	path = resolveExtensionPath(path)
	info, err := os.Stat(path)
	if err != nil {
		return nil, fmt.Errorf("harness %s: %w", path, err)
	}
	dir := path
	if !info.IsDir() {
		dir = filepath.Dir(path)
	}
	manifest, err := extension.LoadManifest(dir)
	if err != nil {
		return nil, fmt.Errorf("harness %s: %w", path, err)
	}
	name := filepath.Base(dir)
	if manifest != nil && manifest.Name != "" {
		name = manifest.Name
	}
	return &acpagent.Harness{Name: name, Title: flags["title"], Path: path}, nil
}

// providerTitle capitalizes an identity provider key ("entra") for the
// sign-in text a client shows.
func providerTitle(provider string) string {
	if provider == "" {
		return provider
	}
	return strings.ToUpper(provider[:1]) + provider[1:]
}
