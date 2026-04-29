package main

import (
	"bufio"
	"encoding/json"
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"net"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"sync/atomic"
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

var version = "dev"

var requestCounter int64

func socketPath() string {
	if v := os.Getenv("ION_SOCKET_PATH"); v != "" {
		return v
	}
	if runtime.GOOS == "windows" {
		return "127.0.0.1:21017"
	}
	home, _ := os.UserHomeDir()
	return filepath.Join(home, ".ion", "engine.sock")
}

// dialNetwork returns the network type for the current platform.
// Windows uses TCP loopback; all other platforms use Unix domain sockets.
func dialNetwork() string {
	if runtime.GOOS == "windows" {
		return "tcp"
	}
	return "unix"
}

func pidPath() string {
	if v := os.Getenv("ION_PID_PATH"); v != "" {
		return v
	}
	home, _ := os.UserHomeDir()
	return filepath.Join(home, ".ion", "engine.pid")
}

func nextRequestID() string {
	n := atomic.AddInt64(&requestCounter, 1)
	return fmt.Sprintf("cli-%d-%d", os.Getpid(), n)
}

// boolFlags lists flags that never consume the next argument as a value.
var boolFlags = map[string]bool{
	"no-extensions": true,
	"attach":        true,
}

// multiFlags lists flags that can be specified multiple times.
var multiFlags = map[string]bool{"extension": true}

// parseArgs extracts command, flags, list flags, and positional args from os.Args.
func parseArgs() (command string, flags map[string]string, listFlags map[string][]string, positional []string) {
	args := os.Args[1:]
	flags = make(map[string]string)
	listFlags = make(map[string][]string)

	if len(args) == 0 || strings.HasPrefix(args[0], "--") {
		command = "serve"
	} else {
		command = args[0]
		args = args[1:]
	}

	for i := 0; i < len(args); i++ {
		if strings.HasPrefix(args[i], "--") {
			key := strings.TrimPrefix(args[i], "--")
			if boolFlags[key] {
				flags[key] = "true"
			} else if i+1 < len(args) && !strings.HasPrefix(args[i+1], "--") {
				val := args[i+1]
				if multiFlags[key] {
					listFlags[key] = append(listFlags[key], val)
				}
				flags[key] = val
				i++
			} else {
				flags[key] = "true"
			}
		} else {
			positional = append(positional, args[i])
		}
	}
	return
}

// resolveExtensionPath expands ~ and resolves to an absolute path.
// isEnvVarName returns true if s looks like an environment variable name
// (all uppercase letters, digits, and underscores, at least 3 chars).
func isEnvVarName(s string) bool {
	if len(s) < 3 {
		return false
	}
	for _, c := range s {
		if !((c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9') || c == '_') {
			return false
		}
	}
	return true
}

func resolveExtensionPath(path string) string {
	if strings.HasPrefix(path, "~") {
		home, err := os.UserHomeDir()
		if err == nil {
			path = filepath.Join(home, path[1:])
		}
	}
	abs, err := filepath.Abs(path)
	if err != nil {
		return path
	}
	return abs
}

// connectAndSend connects to the engine socket, sends a command, waits for response.
func connectAndSend(sock string, msg map[string]interface{}) (map[string]interface{}, error) {
	reqID := nextRequestID()
	msg["requestId"] = reqID

	conn, err := net.Dial(dialNetwork(), sock)
	if err != nil {
		return nil, fmt.Errorf("cannot connect to engine at %s: %w", sock, err)
	}
	defer conn.Close()

	data, _ := json.Marshal(msg)
	conn.Write(append(data, '\n'))

	scanner := bufio.NewScanner(conn)
	for scanner.Scan() {
		line := strings.TrimSpace(scanner.Text())
		if line == "" {
			continue
		}
		var parsed map[string]interface{}
		if err := json.Unmarshal([]byte(line), &parsed); err != nil {
			continue
		}
		if rid, _ := parsed["requestId"].(string); rid == reqID {
			return parsed, nil
		}
	}
	return nil, fmt.Errorf("connection closed before receiving response")
}

// attachStream connects to engine and streams all events to stdout.
func attachStream(sock string, key string) {
	conn, err := net.Dial(dialNetwork(), sock)
	if err != nil {
		fmt.Fprintf(os.Stderr, "Connection error: %s\n", err)
		os.Exit(1)
	}
	defer conn.Close()

	scanner := bufio.NewScanner(conn)
	for scanner.Scan() {
		line := strings.TrimSpace(scanner.Text())
		if line != "" {
			fmt.Println(line)
		}
	}
}

func cmdServe() {
	// Ensure ~/.ion/ exists
	home, _ := os.UserHomeDir()
	ionDir := filepath.Join(home, ".ion")
	os.MkdirAll(ionDir, 0o700)

	// Load layered config (defaults < user < project < enterprise)
	cfg := config.LoadConfig("")
	utils.Log("main", fmt.Sprintf("config loaded: backend=%s model=%s providers=%d mcp=%d",
		cfg.Backend, cfg.DefaultModel, len(cfg.Providers), len(cfg.McpServers)))

	// Initialize network (proxy, custom CA, TLS)
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

	// Apply provider config overrides (baseURL, authHeader, resolved apiKey)
	if len(cfg.Providers) > 0 {
		providers.ApplyConfig(cfg.Providers)
	}

	// Wire feature flags if configured
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

	// Create auth resolver for API key resolution
	resolver := auth.NewResolver(cfg.Auth)

	// Wire resolved provider keys into the auth resolver
	for name, pcfg := range cfg.Providers {
		if pcfg.APIKey != "" {
			resolver.SetProgrammatic(name, pcfg.APIKey)
		}
	}

	// Create backend based on config
	var b backend.RunBackend
	switch cfg.Backend {
	case "cli":
		b = backend.NewCliBackend()
	default:
		b = backend.NewApiBackend()
	}

	// Wire auth resolver into API backend
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

	// Expose config to server/session layer
	srv.SetConfig(cfg)

	// Start server (handles stale socket, platform-specific listen)
	if err := srv.Start(); err != nil {
		fmt.Fprintf(os.Stderr, "Failed to start: %s\n", err)
		os.Exit(1)
	}

	// Acquire PID lock (replaces raw PID file write)
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

	// Start relay transport if configured.
	var relay *transport.RelayTransport
	if cfg.Relay != nil && cfg.Relay.URL != "" && cfg.Relay.ChannelID != "" {
		relay = transport.NewRelayTransport(cfg.Relay.URL, cfg.Relay.APIKey, cfg.Relay.ChannelID)

		// Incoming messages from mobile: parse as commands, dispatch to session manager.
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

		// Outbound events: forward engine broadcasts to mobile via relay.
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
		srv.Stop()
	case <-srv.Done():
		utils.Log("main", "shutdown command received, shutting down")
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

func cmdStart(flags map[string]string, listFlags map[string][]string) {
	profile := flags["profile"]
	dir := flags["dir"]
	if profile == "" {
		fmt.Fprintln(os.Stderr, "Error: --profile <name> required")
		os.Exit(1)
	}
	if dir == "" {
		fmt.Fprintln(os.Stderr, "Error: --dir <path> required")
		os.Exit(1)
	}

	key := flags["key"]
	if key == "" {
		key = profile
	}

	cfg := map[string]interface{}{
		"profileId":        profile,
		"workingDirectory": dir,
	}
	if exts := listFlags["extension"]; len(exts) > 0 {
		resolved := make([]string, len(exts))
		for i, e := range exts {
			resolved[i] = resolveExtensionPath(e)
		}
		cfg["extensions"] = resolved
	}

	result, err := connectAndSend(socketPath(), map[string]interface{}{
		"cmd":    "start_session",
		"key":    key,
		"config": cfg,
	})
	if err != nil {
		fmt.Fprintf(os.Stderr, "Error: %s\n", err)
		os.Exit(1)
	}
	data, _ := json.MarshalIndent(result, "", "  ")
	fmt.Println(string(data))
}

func cmdPrompt(positional []string, flags map[string]string, listFlags map[string][]string) {
	text := strings.Join(positional, " ")
	if text == "" {
		fmt.Fprintln(os.Stderr, "Error: prompt text required")
		os.Exit(1)
	}

	// Auto-start server if not running
	sock := socketPath()
	serverStarted := ensureServer(sock)

	key := flags["key"]
	ephemeral := key == ""
	if ephemeral {
		b := make([]byte, 8)
		rand.Read(b)
		key = "prompt-" + hex.EncodeToString(b)

		// Auto-start an ephemeral session
		cwd, _ := os.Getwd()
		startMsg := map[string]interface{}{
			"cmd": "start_session",
			"key": key,
			"config": map[string]interface{}{
				"workingDirectory": cwd,
			},
		}
		if m := flags["model"]; m != "" {
			startMsg["config"].(map[string]interface{})["model"] = m
		}
		if exts := listFlags["extension"]; len(exts) > 0 {
			resolved := make([]string, len(exts))
			for i, e := range exts {
				resolved[i] = resolveExtensionPath(e)
			}
			startMsg["config"].(map[string]interface{})["extensions"] = resolved
		}
		result, err := connectAndSend(sock, startMsg)
		if err != nil {
			fmt.Fprintf(os.Stderr, "Error starting session: %s\n", err)
			os.Exit(1)
		}
		if errMsg, _ := result["error"].(string); errMsg != "" {
			fmt.Fprintf(os.Stderr, "Error starting session: %s\n", errMsg)
			os.Exit(1)
		}
	} else {
		// Non-ephemeral: ensure session exists (auto-create if needed)
		cwd, _ := os.Getwd()
		startMsg := map[string]interface{}{
			"cmd": "start_session",
			"key": key,
			"config": map[string]interface{}{
				"workingDirectory": cwd,
			},
		}
		if m := flags["model"]; m != "" {
			startMsg["config"].(map[string]interface{})["model"] = m
		}
		if exts := listFlags["extension"]; len(exts) > 0 {
			resolved := make([]string, len(exts))
			for i, e := range exts {
				resolved[i] = resolveExtensionPath(e)
			}
			startMsg["config"].(map[string]interface{})["extensions"] = resolved
		}
		result, err := connectAndSend(sock, startMsg)
		if err != nil {
			fmt.Fprintf(os.Stderr, "Error starting session: %s\n", err)
			os.Exit(1)
		}
		if errMsg, _ := result["error"].(string); errMsg != "" {
			if !strings.Contains(errMsg, "already exists") {
				fmt.Fprintf(os.Stderr, "Error starting session: %s\n", errMsg)
				os.Exit(1)
			}
		}
	}

	msg := map[string]interface{}{
		"cmd":  "send_prompt",
		"key":  key,
		"text": text,
	}
	if m := flags["model"]; m != "" {
		msg["model"] = m
	}
	if mt := flags["max-turns"]; mt != "" {
		n, _ := strconv.Atoi(mt)
		msg["maxTurns"] = n
	}
	if mb := flags["max-budget"]; mb != "" {
		f, _ := strconv.ParseFloat(mb, 64)
		msg["maxBudgetUsd"] = f
	}
	if exts := listFlags["extension"]; len(exts) > 0 {
		resolved := make([]string, len(exts))
		for i, e := range exts {
			resolved[i] = resolveExtensionPath(e)
		}
		msg["extensions"] = resolved
	}
	if flags["no-extensions"] == "true" {
		msg["noExtensions"] = true
	}

	outputMode := flags["output"]
	if outputMode == "" {
		outputMode = "text"
	}

	// Ephemeral single-shot: stream text to stdout, stop session when done
	if ephemeral && outputMode == "text" {
		result, err := connectAndSend(sock, msg)
		if err != nil {
			fmt.Fprintf(os.Stderr, "Error: %s\n", err)
			os.Exit(1)
		}
		if errMsg, _ := result["error"].(string); errMsg != "" {
			fmt.Fprintf(os.Stderr, "Error: %s\n", errMsg)
			os.Exit(1)
		}
		streamUntilIdle(sock, key)
		// Clean up ephemeral session
		connectAndSend(sock, map[string]interface{}{
			"cmd": "stop_session",
			"key": key,
		})
		if serverStarted {
			connectAndSend(sock, map[string]interface{}{
				"cmd": "shutdown",
			})
		}
		return
	}

	if outputMode == "stream-json" {
		result, err := connectAndSend(sock, msg)
		if err != nil {
			fmt.Fprintf(os.Stderr, "Error: %s\n", err)
			os.Exit(1)
		}
		if errMsg, ok := result["error"].(string); ok && errMsg != "" {
			fmt.Fprintf(os.Stderr, "Error: %s\n", errMsg)
			os.Exit(1)
		}
		attachStream(sock, key)
		return
	}

	result, err := connectAndSend(sock, msg)
	if err != nil {
		fmt.Fprintf(os.Stderr, "Error: %s\n", err)
		os.Exit(1)
	}

	if outputMode == "json" {
		data, _ := json.MarshalIndent(result, "", "  ")
		fmt.Println(string(data))
		return
	}

	if errMsg, ok := result["error"].(string); ok && errMsg != "" {
		fmt.Fprintf(os.Stderr, "Error: %s\n", errMsg)
		os.Exit(1)
	}
	if ok, _ := result["ok"].(bool); ok {
		if flags["attach"] == "true" {
			streamUntilIdle(sock, key)
		} else {
			fmt.Println("Prompt sent. Use `ion attach` to stream output.")
		}
	} else {
		data, _ := json.MarshalIndent(result, "", "  ")
		fmt.Println(string(data))
	}
}

// ensureServer checks if engine is reachable; if not, spawns `ion serve` in
// background and waits for socket to accept connections. Returns true if a
// new server was started (caller should shut it down for ephemeral use).
func ensureServer(sock string) bool {
	conn, err := net.DialTimeout(dialNetwork(), sock, 500*time.Millisecond)
	if err == nil {
		conn.Close()
		return false
	}

	// Spawn server as background daemon
	exe, _ := os.Executable()
	cmd := exec.Command(exe, "serve")
	cmd.Stdout = nil
	cmd.Stderr = nil
	detachProcess(cmd)
	if err := cmd.Start(); err != nil {
		fmt.Fprintf(os.Stderr, "Error: cannot start engine: %s\n", err)
		os.Exit(1)
	}
	// Detach child so it survives parent exit
	cmd.Process.Release()

	// Wait for socket to become available
	for i := 0; i < 50; i++ {
		time.Sleep(100 * time.Millisecond)
		c, err := net.DialTimeout(dialNetwork(), sock, 200*time.Millisecond)
		if err == nil {
			c.Close()
			return true
		}
	}
	fmt.Fprintln(os.Stderr, "Error: engine failed to start within 5s")
	os.Exit(1)
	return false
}

// streamUntilIdle connects to the engine socket and streams text deltas to
// stdout until the session emits engine_status with state=idle.
func streamUntilIdle(sock, key string) {
	conn, err := net.Dial(dialNetwork(), sock)
	if err != nil {
		fmt.Fprintf(os.Stderr, "Error connecting to stream: %s\n", err)
		return
	}
	defer conn.Close()

	scanner := bufio.NewScanner(conn)
	scanner.Buffer(make([]byte, 0, 64*1024), 1024*1024)
	for scanner.Scan() {
		line := strings.TrimSpace(scanner.Text())
		if line == "" {
			continue
		}
		var msg map[string]interface{}
		if err := json.Unmarshal([]byte(line), &msg); err != nil {
			continue
		}
		// Only process events for our session key
		if msgKey, _ := msg["key"].(string); msgKey != key {
			continue
		}
		event, _ := msg["event"].(map[string]interface{})
		if event == nil {
			continue
		}
		eventType, _ := event["type"].(string)
		switch eventType {
		case "engine_text_delta":
			if text, ok := event["text"].(string); ok {
				fmt.Print(text)
			}
		case "engine_status":
			fields, _ := event["fields"].(map[string]interface{})
			if fields != nil {
				if state, _ := fields["state"].(string); state == "idle" {
					fmt.Println()
					return
				}
			}
		case "engine_error":
			if errMsg, ok := event["message"].(string); ok {
				fmt.Fprintf(os.Stderr, "\nError: %s\n", errMsg)
				return
			}
		}
	}
}

func cmdAttach(flags map[string]string) {
	attachStream(socketPath(), flags["key"])
}

func cmdStatus() {
	result, err := connectAndSend(socketPath(), map[string]interface{}{
		"cmd": "list_sessions",
	})
	if err != nil {
		fmt.Fprintf(os.Stderr, "Error: %s\n", err)
		os.Exit(1)
	}

	sessions, _ := result["data"].([]interface{})
	if len(sessions) == 0 {
		fmt.Println("No active sessions")
		return
	}

	fmt.Printf("%-16s %-16s %-16s %-16s\n", "KEY", "PROFILE", "DIRECTORY", "STATE")
	fmt.Println(strings.Repeat("-", 64))
	for _, s := range sessions {
		sm, _ := s.(map[string]interface{})
		fmt.Printf("%-16s %-16s %-16s %-16s\n",
			sm["key"], sm["profile"], sm["directory"], sm["state"])
	}
}

func cmdStop(flags map[string]string) {
	msg := map[string]interface{}{
		"cmd": "stop_session",
	}
	if k := flags["key"]; k != "" {
		msg["key"] = k
	}
	result, err := connectAndSend(socketPath(), msg)
	if err != nil {
		fmt.Fprintf(os.Stderr, "Error: %s\n", err)
		os.Exit(1)
	}
	data, _ := json.MarshalIndent(result, "", "  ")
	fmt.Println(string(data))
}

func cmdShutdown() {
	result, err := connectAndSend(socketPath(), map[string]interface{}{
		"cmd": "shutdown",
	})
	if err != nil {
		fmt.Fprintf(os.Stderr, "Error: %s\n", err)
		os.Exit(1)
	}
	data, _ := json.MarshalIndent(result, "", "  ")
	fmt.Println(string(data))
}

func cmdRecord(flags map[string]string) {
	output := flags["output"]
	if output == "" {
		fmt.Fprintln(os.Stderr, "Error: --output <path> required")
		os.Exit(1)
	}

	f, err := os.Create(output)
	if err != nil {
		fmt.Fprintf(os.Stderr, "Error creating file: %s\n", err)
		os.Exit(1)
	}
	defer f.Close()

	conn, err := net.Dial(dialNetwork(), socketPath())
	if err != nil {
		fmt.Fprintf(os.Stderr, "Connection error: %s\n", err)
		os.Exit(1)
	}
	defer conn.Close()

	fmt.Printf("Recording to %s...\n", output)
	if k := flags["key"]; k != "" {
		fmt.Printf("Filtering to key: %s\n", k)
	}
	fmt.Println("Press Ctrl+C to stop.")

	count := 0
	scanner := bufio.NewScanner(conn)
	for scanner.Scan() {
		line := scanner.Text()
		if strings.TrimSpace(line) == "" {
			continue
		}
		if key := flags["key"]; key != "" {
			var parsed map[string]interface{}
			if json.Unmarshal([]byte(line), &parsed) == nil {
				if k, _ := parsed["key"].(string); k != key {
					continue
				}
			}
		}
		f.WriteString(line + "\n")
		count++
	}
	fmt.Printf("\nRecorded %d messages to %s\n", count, output)
}

func cmdRpc() {
	conn, err := net.Dial(dialNetwork(), socketPath())
	if err != nil {
		fmt.Fprintf(os.Stderr, "Connection error: %s\n", err)
		os.Exit(1)
	}
	defer conn.Close()

	fmt.Fprintln(os.Stderr, "Connected to engine server (RPC mode)")

	// Forward socket output to stdout
	go func() {
		scanner := bufio.NewScanner(conn)
		for scanner.Scan() {
			line := scanner.Text()
			if strings.TrimSpace(line) != "" {
				fmt.Println(line)
			}
		}
		os.Exit(0)
	}()

	// Forward stdin to socket
	scanner := bufio.NewScanner(os.Stdin)
	for scanner.Scan() {
		line := scanner.Text()
		if strings.TrimSpace(line) != "" {
			conn.Write([]byte(line + "\n"))
		}
	}
	conn.Close()
}

func printUsage() {
	fmt.Fprintln(os.Stderr, "Ion Engine - Headless AI agent runtime")
	fmt.Fprintln(os.Stderr, "")
	fmt.Fprintln(os.Stderr, "Usage: ion [command] [options]")
	fmt.Fprintln(os.Stderr, "")
	fmt.Fprintln(os.Stderr, "Commands:")
	fmt.Fprintln(os.Stderr, "  serve                    Start daemon (default)")
	fmt.Fprintln(os.Stderr, "  start --profile --dir    Start session")
	fmt.Fprintln(os.Stderr, "    --key KEY              Session key (default: profile name)")
	fmt.Fprintln(os.Stderr, "    --extension FILE       Load extension (can be repeated)")
	fmt.Fprintln(os.Stderr, "  prompt \"text\"             Send prompt")
	fmt.Fprintln(os.Stderr, "    --no-extensions        Skip extensions for this prompt")
	fmt.Fprintln(os.Stderr, "    --extension FILE       Load extension (can be repeated)")
	fmt.Fprintln(os.Stderr, "    --attach               Stream output until idle (keyed sessions)")
	fmt.Fprintln(os.Stderr, "  attach                   Stream events (NDJSON)")
	fmt.Fprintln(os.Stderr, "  status                   List sessions")
	fmt.Fprintln(os.Stderr, "  stop --key               Stop session")
	fmt.Fprintln(os.Stderr, "  shutdown                 Stop daemon")
	fmt.Fprintln(os.Stderr, "  record --output          Record session to NDJSON")
	fmt.Fprintln(os.Stderr, "  rpc                      JSON-RPC over stdin/stdout")
	fmt.Fprintln(os.Stderr, "  version                  Show version")
	fmt.Fprintln(os.Stderr, "")
	fmt.Fprintln(os.Stderr, "Options:")
	fmt.Fprintln(os.Stderr, "  --model <model>          Model override")
	fmt.Fprintln(os.Stderr, "  --max-turns N            Max LLM turns (default: 50)")
	fmt.Fprintln(os.Stderr, "  --max-budget USD         Cost ceiling")
	fmt.Fprintln(os.Stderr, "  --output text|json|stream-json")
	fmt.Fprintln(os.Stderr, "  --key KEY                Session key")
	os.Exit(1)
}

func main() {
	command, flags, listFlags, positional := parseArgs()

	switch command {
	case "serve":
		cmdServe()
	case "start":
		cmdStart(flags, listFlags)
	case "prompt":
		cmdPrompt(positional, flags, listFlags)
	case "attach":
		cmdAttach(flags)
	case "status":
		cmdStatus()
	case "stop":
		cmdStop(flags)
	case "shutdown":
		cmdShutdown()
	case "record":
		cmdRecord(flags)
	case "rpc":
		cmdRpc()
	case "version":
		fmt.Printf("ion-engine %s\n", version)
	default:
		printUsage()
	}
}
