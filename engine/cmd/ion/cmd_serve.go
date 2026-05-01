package main

import (
	"fmt"
	"os"
	"os/signal"
	"path/filepath"
	"runtime"
	"strings"
	"syscall"
	"time"

	"github.com/dsswift/ion/engine/internal/auth"
	"github.com/dsswift/ion/engine/internal/backend"
	"github.com/dsswift/ion/engine/internal/config"
	"github.com/dsswift/ion/engine/internal/featureflags"
	"github.com/dsswift/ion/engine/internal/filelock"
	"github.com/dsswift/ion/engine/internal/modelconfig"
	"github.com/dsswift/ion/engine/internal/network"
	"github.com/dsswift/ion/engine/internal/protocol"
	"github.com/dsswift/ion/engine/internal/providers"
	"github.com/dsswift/ion/engine/internal/server"
	"github.com/dsswift/ion/engine/internal/titling"
	"github.com/dsswift/ion/engine/internal/transport"
	"github.com/dsswift/ion/engine/internal/utils"
)

func cmdServe() {
	home, _ := os.UserHomeDir()
	ionDir := filepath.Join(home, ".ion")
	os.MkdirAll(ionDir, 0o700)

	cfg := config.LoadConfig("")
	utils.Log("main", fmt.Sprintf("config loaded: backend=%s model=%s providers=%d mcp=%d",
		cfg.Backend, cfg.DefaultModel, len(cfg.Providers), len(cfg.McpServers)))

	network.InitNetwork(cfg.Network)

	// Load models config (tiers, provider auto-detect) and register
	// user-defined model names so they resolve to the correct provider.
	modelsConfig := modelconfig.LoadModelsConfig()
	for model, info := range modelconfig.UserModels(modelsConfig) {
		providers.RegisterModel(model, info)
	}

	// Resolve provider API keys: env var names (e.g. "ION_API_KEY") are
	// expanded from environment before passing to providers and auth.
	for name, pcfg := range cfg.Providers {
		if pcfg.APIKey != "" && isEnvVarName(pcfg.APIKey) {
			if v := os.Getenv(pcfg.APIKey); v != "" {
				pcfg.APIKey = v
				cfg.Providers[name] = pcfg
			}
		}
	}

	if len(cfg.Providers) > 0 {
		providers.ApplyConfig(cfg.Providers)
	}

	if cfg.FeatureFlags != nil {
		ffCfg := featureflags.Config{
			Source: featureflags.Source(cfg.FeatureFlags.Source),
			Path:   cfg.FeatureFlags.Path,
			URL:    cfg.FeatureFlags.URL,
			Static: cfg.FeatureFlags.Static,
		}
		if cfg.FeatureFlags.Interval > 0 {
			ffCfg.Interval = time.Duration(cfg.FeatureFlags.Interval) * time.Millisecond
		}
		_ = featureflags.New(ffCfg)
		utils.Log("main", "feature flags initialized: source="+cfg.FeatureFlags.Source)
	}

	resolver := auth.NewResolver(cfg.Auth)

	for name, pcfg := range cfg.Providers {
		if pcfg.APIKey != "" {
			resolver.SetProgrammatic(name, pcfg.APIKey)
		}
	}

	var b backend.RunBackend
	switch cfg.Backend {
	case "cli":
		b = backend.NewCliBackend()
	default:
		b = backend.NewApiBackend()
	}

	if apiBackend, ok := b.(*backend.ApiBackend); ok {
		apiBackend.SetAuthResolver(resolver)
	}

	// Wire auth resolver into titling so it can resolve keychain-stored keys
	// without depending on a prior regular prompt having called SetProviderKey.
	titling.SetAuthResolver(func(providerName string) {
		if key, err := resolver.ResolveKey(providerName); err == nil && key != "" {
			providers.SetProviderKey(providerName, key)
		}
	})

	sock := socketPath()
	srv := server.NewServer(sock, b)

	srv.SetConfig(cfg)
	srv.SetVersion(version)

	if err := srv.Start(); err != nil {
		fmt.Fprintf(os.Stderr, "Failed to start: %s\n", err)
		os.Exit(1)
	}

	pidLock, lockErr := filelock.Acquire(pidPath())
	if lockErr != nil {
		fmt.Fprintf(os.Stderr, "Engine already running: %s\n", lockErr)
		os.Exit(1)
	}
	fmt.Printf("Ion Engine v%s started (pid %d)\n", version, os.Getpid())
	if runtime.GOOS == "windows" {
		fmt.Printf("Listening: tcp://%s\n", sock)
	} else {
		fmt.Printf("Socket: %s\n", sock)
	}
	fmt.Printf("Backend: %s\n", cfg.Backend)

	var relay *transport.RelayTransport
	if cfg.Relay != nil && cfg.Relay.URL != "" && cfg.Relay.ChannelID != "" {
		relay = transport.NewRelayTransport(cfg.Relay.URL, cfg.Relay.APIKey, cfg.Relay.ChannelID)

		relay.OnMessage = func(data []byte) {
			line := strings.TrimSpace(string(data))
			if line == "" {
				return
			}
			cmd := protocol.ParseClientCommand(line)
			if cmd == nil {
				utils.Log("Relay", "invalid command from mobile: "+line[:min(len(line), 200)])
				return
			}
			utils.Log("Relay", fmt.Sprintf("dispatch: cmd=%s key=%s", cmd.Cmd, cmd.Key))
			srv.DispatchCommand(cmd)
		}

		srv.OnBroadcast(func(line string) {
			relay.Broadcast([]byte(line))
		})

		if err := relay.Listen(nil); err != nil {
			utils.Log("Relay", fmt.Sprintf("failed to start: %v", err))
		} else {
			fmt.Printf("Relay: %s (channel %s)\n", cfg.Relay.URL, cfg.Relay.ChannelID)
		}
	}

	// Wait for OS signal or shutdown IPC command (TS parity: server.ts calls
	// process.exit(0) on shutdown; we unblock main instead).
	sigCh := make(chan os.Signal, 1)
	signal.Notify(sigCh, syscall.SIGINT, syscall.SIGTERM)
	select {
	case sig := <-sigCh:
		utils.Log("main", fmt.Sprintf("received signal: %s, shutting down", sig))
		// Best-effort durability: persist any in-flight conversation before
		// the run goroutines are cancelled by srv.Stop(). This guarantees the
		// user's most recent prompt and any complete assistant blocks survive
		// graceful shutdown (Electron quit, kill -TERM, Ctrl+C). SIGKILL
		// bypasses this; per-event Save() in the agent loop covers that.
		b.FlushConversations()
		srv.Stop()
	case <-srv.Done():
		utils.Log("main", "shutdown command received, shutting down")
		b.FlushConversations()
		// srv.Stop() already called by the shutdown command handler.
	}

	if relay != nil {
		relay.Close()
	}

	if pidLock != nil {
		pidLock.Release()
	}
	fmt.Println("Engine stopped.")
}
