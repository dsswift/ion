package main

import (
	"context"
	"fmt"
	"os"
	"time"

	"github.com/dsswift/ion/engine/internal/acpagent"
	"github.com/dsswift/ion/engine/internal/config"
	"github.com/dsswift/ion/engine/internal/types"
	"github.com/dsswift/ion/engine/internal/utils"
)

// configProfile is the settings.json profile row the options are built from.
type configProfile = types.EngineProfileConfig

// cmdAcp implements `ion acp [--profile <name|id>] [--model <id>]`: the
// engine served as an Agent Client Protocol agent over this process's
// stdio. An ACP client (T3 Code's Local ACP command provider, Zed, any ACP
// editor) spawns it; every session it opens is an ordinary session in the
// running daemon, which is started when it is not already up.
//
// stdout is the JSON-RPC channel, so every diagnostic goes to engine.jsonl
// under tag `acp`, never to stdout. stderr carries only a startup failure
// the client can show.
func cmdAcp(flags map[string]string) {
	sock := socketPathOrExit()
	spawned := ensureServer(sock)
	releaseSpawnedServer(spawned)
	engine, err := acpagent.DialEngine(dialNetwork(sock), sock)
	if err != nil {
		fmt.Fprintf(os.Stderr, "ion acp: %v\n", err)
		os.Exit(1)
	}
	opts := acpOptions(flags, config.LoadProfiles(), config.LoadConfig("").DefaultModel)
	agent := acpagent.New(engine, os.Stdout, os.Stdin, opts)
	utils.LogWithFields(utils.LevelInfo, "acp", "agent started", map[string]any{"profile": opts.Profile, "model": opts.Model, "profiles": len(opts.Profiles)})
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
