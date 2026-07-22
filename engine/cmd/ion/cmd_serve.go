package main

import (
	"context"
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
	"github.com/dsswift/ion/engine/internal/compaction"
	"github.com/dsswift/ion/engine/internal/config"
	"github.com/dsswift/ion/engine/internal/extension"
	"github.com/dsswift/ion/engine/internal/featureflags"
	"github.com/dsswift/ion/engine/internal/filelock"
	"github.com/dsswift/ion/engine/internal/mcp"
	"github.com/dsswift/ion/engine/internal/modelconfig"
	"github.com/dsswift/ion/engine/internal/network"
	"github.com/dsswift/ion/engine/internal/plugins"
	"github.com/dsswift/ion/engine/internal/protocol"
	"github.com/dsswift/ion/engine/internal/providers"
	"github.com/dsswift/ion/engine/internal/server"
	"github.com/dsswift/ion/engine/internal/telemetry"
	"github.com/dsswift/ion/engine/internal/titling"
	"github.com/dsswift/ion/engine/internal/transport"
	"github.com/dsswift/ion/engine/internal/utils"
)

func cmdServe() {
	home, _ := os.UserHomeDir() //nolint:errcheck // empty home falls back to a relative .ion dir
	ionDir := filepath.Join(home, ".ion")
	if err := os.MkdirAll(ionDir, 0o700); err != nil {
		utils.LogWithFields(utils.LevelError, "main", "failed to create ion data dir", map[string]any{"path": ionDir, "error": utils.ErrStr(err)})
	}
	utils.LogWithFields(utils.LevelInfo, "main", "=== engine process start ===", map[string]any{"run_id": os.Getpid(), "version": version})

	// Read back any pre-existing exit breadcrumb so the prior exit is
	// observable in the log immediately after startup. Then write our own
	// "running" record so an unclean termination is detectable by the next start.
	logPriorExit(exitPath())
	writeRunning(exitPath())

	cfg := config.LoadConfig("")
	utils.LogWithFields(utils.LevelInfo, "main", "config loaded", map[string]any{"backend": cfg.Backend, "model": cfg.DefaultModel, "count": len(cfg.Providers), "max": len(cfg.McpServers)})

	// Reconcile plugins: install any force-installed sources, enforce enterprise
	// allowlist/denylist against the registry. Runs synchronously so that all
	// sessions started after boot operate against the authoritative plugin set.
	// Install is idempotent — already-cached SHAs skip the network round-trip.
	plugins.ReconcilePlugins(cfg, func(msg string) {
		utils.Log("plugins", msg)
	})

	// Wire engine.jsonl rotation from the loaded config so the log file rotates
	// at the configured size limit (default 50 MB in the logger) rather than
	// growing unbounded. Without this call, ConfigureLogging is never invoked
	// with the engine.json Logging section and its compiled defaults stand
	// regardless of what engine.json specifies. ConfigureLogging is nil-safe.
	if cfg.Logging != nil {
		utils.ConfigureLogging(cfg.Logging)
		utils.LogWithFields(utils.LevelInfo, "main", "logging configured", map[string]any{"max_size_m_b": cfg.Logging.MaxSizeMB, "disable_rotation": cfg.Logging.DisableRotation, "output_mode": cfg.Logging.OutputMode, "log_dir": cfg.Logging.LogDir})
	}

	// Hydrate the engine process PATH from the user's login shell so that every
	// subprocess the engine spawns (extension node hosts, esbuild, npm, and
	// extension child_process calls like `ion prompt`) inherits the full PATH.
	// The engine runs as a launchd agent whose PATH is stripped to
	// /usr/bin:/bin:/usr/sbin:/sbin; without this step, tools installed in
	// /opt/homebrew/bin and similar locations are not found. HydrateProcessPath
	// is nil-safe and a no-op when useLoginShell is false.
	cfg.Shell.HydrateProcessPath()

	// Apply a soft heap ceiling (GOMEMLIMIT) so the GC holds resident memory below
	// the level where the OS memory-pressure killer (macOS jetsam / Linux OOM) would
	// SIGKILL this single daemon and take every hosted session down at once. The
	// returned limit is reported by the memory monitor started below. This is a soft
	// limit (GC pressure), never a hard cap, and it never overrides an operator's
	// explicit GOMEMLIMIT env var. See cmd/ion/memlimit.go.
	memLimitBytes := applyMemoryLimit(cfg)

	network.InitNetwork(cfg.Network)

	// Materialize the macOS Local Network privacy verdict for this process so
	// LAN connections work for the engine and every subprocess it spawns.
	// Without this, a launchd-hosted engine (and its bash tool children:
	// kubectl, ssh, curl) gets silent EHOSTUNREACH on all LAN targets. Async —
	// never blocks daemon startup. No-op off darwin. See
	// internal/network/lanwarmup.go for the full mechanics.
	go network.WarmLocalNetwork(cfg.Network)

	// Load models config (tiers, provider auto-detect) and register
	// user-defined model names so they resolve to the correct provider.
	// When a user model overlaps with a catalog model, merge: catalog
	// metadata (context window, costs, capabilities) serves as the default
	// and user-config values overlay only what the user explicitly set.
	modelsConfig := modelconfig.LoadModelsConfig()
	for model, info := range modelconfig.UserModels(modelsConfig) {
		if existing := providers.GetModelInfo(model); existing != nil {
			info = providers.MergeModelInfo(*existing, info)
			utils.LogWithFields(utils.LevelDebug, "config", "user model merged with catalog ()", map[string]any{"model": model, "context_window": info.ContextWindow})
		}
		info.IsCustom = true
		providers.RegisterModel(model, info)
	}

	// Resolve provider API keys: env var names (e.g. "OPENROUTER_API_KEY") are
	// expanded from environment before passing to providers and auth.
	// If the env var is not set, the reference is cleared so it doesn't get
	// used as a literal API key value.
	for name, pcfg := range cfg.Providers {
		if pcfg.APIKey != "" && isEnvVarName(pcfg.APIKey) {
			if v := os.Getenv(pcfg.APIKey); v != "" {
				pcfg.APIKey = v
			} else {
				utils.LogWithFields(utils.LevelInfo, "config", "provider : env var not set, skipping", map[string]any{"model": name, "a_p_i_key": pcfg.APIKey})
				pcfg.APIKey = ""
			}
			cfg.Providers[name] = pcfg
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
		utils.LogWithFields(utils.LevelInfo, "main", "feature flags initialized: source=", map[string]any{"source": cfg.FeatureFlags.Source})
	}

	resolver := auth.NewResolver(cfg.Auth)

	// Wire configurable timeouts into MCP and extension subsystems.
	if cfg.Timeouts != nil {
		mcp.SetDefaultCallTimeout(cfg.Timeouts.McpCall())
		mcp.SetDefaultMetadataTimeout(cfg.Timeouts.McpMetadata())
		mcp.SetDefaultWriteTimeout(cfg.Timeouts.McpWrite())
		extension.ConfiguredDefaultTimeout = cfg.Timeouts.HookDefault()
	}

	for name, pcfg := range cfg.Providers {
		if pcfg.APIKey != "" {
			resolver.SetProgrammatic(name, pcfg.APIKey)
		}
	}

	var b backend.RunBackend
	switch cfg.Backend {
	case "claude-code", "cli":
		// "cli" is the legacy input alias for "claude-code". Config load
		// normalizes it to "claude-code", but the switch accepts both so a
		// raw/unnormalized value still resolves the same backend.
		b = backend.NewClaudeCodeBackend()
	case "hybrid":
		// Hybrid backend owns per-kind inner backends (api / claude-code /
		// codex / grok / cursor) and routes each run by resolved provider ID,
		// honoring per-provider backend preferences from engine.json and
		// falling back to the default rule. See internal/backend/hybrid_backend.go.
		prefs := config.ProviderBackendPrefs(cfg)
		utils.LogWithFields(utils.LevelInfo, "main", "hybrid backend provider preferences", map[string]any{"count": len(prefs)})
		b = backend.NewHybridBackendWithPrefs(prefs)
	default:
		b = backend.NewApiBackend()
	}

	// Attach the auth resolver to whatever backend implementation we built.
	// HybridBackend forwards the resolver to its inner *ApiBackend; plain
	// ClaudeCodeBackend does not need a resolver (subscription path).
	switch v := b.(type) {
	case *backend.ApiBackend:
		v.SetAuthResolver(resolver)
	case *backend.HybridBackend:
		v.SetAuthResolver(resolver)
	}

	// Wire auth resolver into titling so it can resolve keychain-stored keys
	// without depending on a prior regular prompt having called SetProviderKey.
	titling.SetAuthResolver(func(providerName string) {
		if key, err := resolver.ResolveKey(providerName); err == nil && key != "" {
			providers.SetProviderKey(providerName, key)
		}
	})

	// Wire auth resolver into compaction so LLM-based summarization can
	// resolve keychain-stored keys (same pattern as titling above).
	compaction.SetAuthResolver(func(providerName string) {
		if key, err := resolver.ResolveKey(providerName); err == nil && key != "" {
			providers.SetProviderKey(providerName, key)
		}
	})

	sock := socketPath()
	srv := server.NewServer(sock, b)

	srv.SetConfig(cfg)
	srv.SetVersion(version)
	srv.SetAuthResolver(resolver)

	// Engine-owned operator OIDC identity: when auth.identityProvider names
	// an oauth entry, the engine owns the login flow, grant persistence,
	// silent refresh, and per-scope token minting. Consumers (SDK HTTP, MCP
	// token forwarding, authenticated egress, desktop/iOS login UI) resolve
	// through this manager -- never through a client-held token.
	if cfg.Auth != nil && cfg.Auth.IdentityProvider != "" {
		if oauthCfg, ok := cfg.Auth.OAuth[cfg.Auth.IdentityProvider]; ok {
			im := auth.NewIdentityManager(cfg.Auth.IdentityProvider, oauthCfg, cfg.Auth.RefreshThresholdMs)
			srv.SetIdentityManager(im)
			// Package-level registry: the seam the extension SDK's
			// pre-authenticated HTTP, MCP token forwarding, and
			// authenticated egress resolve tokens through.
			auth.SetOperator(im)
			utils.LogWithFields(utils.LevelInfo, "main", "operator identity manager configured", map[string]any{
				"provider":  cfg.Auth.IdentityProvider,
				"signed_in": im.SignedIn(),
			})
			// Stamp attribution for a grant that survived restart. Live
			// transitions (login/logout) restamp via the identity broadcast
			// path in internal/server/dispatch_oidc.go.
			if id := im.Identity(); id != nil {
				utils.SetEgressUser(id.AttributionValue())
				telemetry.SetUserIdentity(id.AttributionValue())
			}
		} else {
			utils.LogWithFields(utils.LevelError, "main", "auth.identityProvider names a missing auth.oauth entry", map[string]any{
				"provider": cfg.Auth.IdentityProvider,
			})
		}
	}

	// Authenticated log egress: when egressTokenScope is configured, every
	// flush mints a fresh operator token for that scope. Installed after the
	// identity manager so the closure resolves through the live registry.
	if cfg.Logging != nil && cfg.Logging.EgressTokenScope != "" {
		scope := cfg.Logging.EgressTokenScope
		audience := cfg.Logging.EgressTokenAudience
		utils.SetEgressAuthHeaderProvider(func() map[string]string {
			op := auth.Operator()
			if op == nil {
				return nil
			}
			token, err := op.GetTokenWithAudience(context.Background(), scope, audience)
			if err != nil {
				utils.LogWithFields(utils.LevelError, "main", "egress token mint failed; flush proceeds with static headers", map[string]any{"error": err.Error()})
				return nil
			}
			return map[string]string{"Authorization": "Bearer " + token}
		})
		utils.LogWithFields(utils.LevelInfo, "main", "egress auth header provider installed", map[string]any{"tag": scope})
	}

	// Shipping-responsibility matrix: when the matrix assigns the engine
	// non-engine sources (desktop / ios / telemetry files), start the file
	// tailer that feeds them through the authenticated forwarder.
	if cfg.Logging != nil {
		sources := utils.EngineShipSources(*cfg.Logging)
		var tailed []string
		for _, s := range sources {
			if s != "engine" {
				tailed = append(tailed, s)
			}
		}
		if len(tailed) > 0 {
			if tailer := utils.StartEgressTailer(tailed, utils.ActiveEgressForwarder()); tailer != nil {
				defer tailer.Stop()
			}
		}
	}

	// Stamp the engine version into the telemetry package so every emitted
	// event carries the correct version string (R21). Must be called after the
	// version var is set (cmd/ion/main.go) and before any NewCollector call
	// (SetConfig above may trigger NewCollector via server.SetTelemetry, so
	// this is belt-and-suspenders — the version var is set at link time and
	// is already correct before cmdServe runs).
	telemetry.SetEngineVersion(version)

	// Drain load-time enterprise enforcement actions into the telemetry
	// collector (feature 0010 audit clause / D-018 rider #2). EnforceEnterprise
	// runs at config load, before any collector exists, and records its prune/pin
	// actions into config's package-level recorder. Now that telemetry is
	// initialized, drain them so each enforcement action becomes one audit event.
	drainEnforcementActions(srv.Telemetry())

	// Start async model discovery (fetches /v1/models from each provider).
	// Results cached and used by list_models; falls back to hardcoded catalog.
	providers.StartModelDiscovery(resolver.ResolveKey, cfg.Providers)

	// Acquire PID lock before binding the socket. If we get the lock, no
	// other engine process is alive, so any existing socket file is stale
	// and can be removed without probing. This prevents crash-loop
	// scenarios where net.Dial succeeds on a stale socket whose listen
	// backlog hasn't drained yet.
	pidLock, lockErr := filelock.Acquire(pidPath())
	if lockErr != nil {
		fmt.Fprintf(os.Stderr, "Engine already running: %s\n", lockErr)
		os.Exit(1)
	}

	utils.LogWithFields(utils.LevelInfo, "main", "binding socket at", map[string]any{"sock": sock})
	if err := srv.Start(); err != nil {
		fmt.Fprintf(os.Stderr, "Failed to start: %s\n", err)
		os.Exit(1)
	}
	fmt.Printf("Ion Engine v%s started (pid %d)\n", version, os.Getpid())

	// Heartbeat: update lastBeat every 5 s so an unclean death leaves a
	// dateable breadcrumb. The goroutine is daemon-style -- no sync needed
	// on shutdown because writeClean/writePanic overwrite the record before
	// the process exits on the graceful path.
	go func() {
		t := time.NewTicker(beatInterval)
		defer t.Stop()
		for range t.C {
			beat(exitPath())
		}
	}()

	// Memory-pressure monitor: periodically logs heap footprint against the soft
	// ceiling and the live session count, escalating to ERROR near the high-water
	// mark. Closes the observability blind spot — before this, nothing recorded
	// memory pressure approaching the level where the OS kills the daemon. The
	// session-count closure avoids a cmd→internal/server import concern.
	startMemoryMonitor(memLimitBytes, func() int {
		return len(srv.SessionManager().ListSessions())
	})
	if runtime.GOOS == "windows" {
		fmt.Printf("Listening: tcp://%s\n", sock)
	} else {
		fmt.Printf("Socket: %s\n", sock)
	}
	fmt.Printf("Backend: %s\n", cfg.Backend)

	var relay *transport.RelayTransport
	if cfg.Relay != nil && cfg.Relay.URL != "" && cfg.Relay.ChannelID != "" {
		relay = transport.NewRelayTransport(cfg.Relay.URL, cfg.Relay.APIKey, cfg.Relay.ChannelID)
		if cfg.Timeouts != nil {
			relay.SetWriteTimeout(cfg.Timeouts.RelayWrite())
		}

		relay.OnMessage = func(data []byte) {
			line := strings.TrimSpace(string(data))
			if line == "" {
				return
			}
			cmd := protocol.ParseClientCommand(line)
			if cmd == nil {
				utils.LogWithFields(utils.LevelInfo, "relay", "invalid command from mobile", map[string]any{"line[:min]": line[:min(len(line), 200)]})
				return
			}
			utils.LogWithFields(utils.LevelInfo, "relay", "dispatch", map[string]any{"cmd": cmd.Cmd, "key": cmd.Key})
			srv.DispatchCommand(cmd)
		}

		srv.OnBroadcast(func(line string) {
			relay.Broadcast([]byte(line))
		})

		if err := relay.Listen(nil); err != nil {
			utils.LogWithFields(utils.LevelInfo, "relay", "failed to start", map[string]any{"error": err})
		} else {
			fmt.Printf("Relay: %s (channel %s)\n", cfg.Relay.URL, cfg.Relay.ChannelID)
		}
	}

	// Wait for OS signal or shutdown IPC command (TS parity: server.ts calls
	// process.exit(0) on shutdown; we unblock main instead).
	// SIGHUP is included so that launchctl bootout (which sends SIGTERM) and
	// parent-process death (which sends SIGHUP to non-detached children) both
	// produce a graceful, breadcrumb-clean shutdown rather than an abrupt kill.
	sigCh := make(chan os.Signal, 1)
	signal.Notify(sigCh, syscall.SIGINT, syscall.SIGTERM, syscall.SIGHUP)
	select {
	case sig := <-sigCh:
		utils.LogWithFields(utils.LevelInfo, "main", "received signal: , shutting down", map[string]any{"sig": sig})
		writeClean(exitPath(), sig.String())
		// Best-effort durability: persist any in-flight conversation before
		// the run goroutines are cancelled by srv.Stop(). This guarantees the
		// user's most recent prompt and any complete assistant blocks survive
		// graceful shutdown (Electron quit, kill -TERM, Ctrl+C). SIGKILL
		// bypasses this; per-event Save() in the agent loop covers that.
		b.FlushConversations()
		if err := srv.Stop(); err != nil {
			utils.LogWithFields(utils.LevelError, "main", "server stop failed during shutdown", map[string]any{"error": utils.ErrStr(err)})
		}
	case <-srv.Done():
		utils.Log("main", "shutdown command received, shutting down")
		writeClean(exitPath(), "shutdown-cmd")
		b.FlushConversations()
		// srv.Stop() already called by the shutdown command handler.
	}

	if relay != nil {
		if err := relay.Close(); err != nil {
			utils.LogWithFields(utils.LevelWarn, "main", "relay close failed during shutdown", map[string]any{"error": utils.ErrStr(err)})
		}
	}

	if pidLock != nil {
		if err := pidLock.Release(); err != nil {
			utils.LogWithFields(utils.LevelWarn, "main", "pid lock release failed during shutdown", map[string]any{"error": utils.ErrStr(err)})
		}
	}
	fmt.Println("Engine stopped.")
}
