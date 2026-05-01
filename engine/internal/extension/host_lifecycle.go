package extension

import (
	"bufio"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/dsswift/ion/engine/internal/utils"
)

// Strike-budget constants. Public-ish so tests can inject smaller windows.
var (
	respawnBudgetWindow = 60 * time.Second
	respawnBudgetMax    = int64(3)
	respawnHealthyReset = 2 * time.Minute
)

// ErrBudgetExceeded is returned by Respawn when the strike budget has been
// exhausted within the rolling window. The session manager treats this as
// the terminal state — the host stays dead until the user closes and
// reopens the tab.
var ErrBudgetExceeded = errors.New("respawn budget exceeded")

// files are transpiled via esbuild before execution. The subprocess
// communicates via JSON-RPC 2.0 over stdin/stdout.
func (h *Host) Load(extensionPath string, config *ExtensionConfig) error {
	h.mu.Lock()
	err := h.spawnAndInit(extensionPath, config, false)
	if err == nil {
		// Cache spawn parameters so Respawn can replay without the session
		// manager round-tripping the original extension path.
		h.loadedPath = extensionPath
		h.loadedConfig = config
		h.lastHealthyAt.Store(time.Now().UnixNano())
	}
	h.mu.Unlock()
	if err != nil {
		// disposeInternal acquires h.mu and waits for the reader goroutine,
		// so it must run after we've released the lock. Calling it from
		// inside spawnAndInit would deadlock against this Lock().
		h.disposeInternal()
		return err
	}
	return nil
}

// spawnAndInit performs the actual subprocess spawn, stdin/stdout wiring,
// reader-goroutine startup, init handshake, and hook forwarder registration.
// Caller must hold h.mu. When isRespawn is true, hook forwarders are not
// re-registered (they were already registered on the SDK during Load and
// the SDK is shared across respawns).
func (h *Host) spawnAndInit(extensionPath string, config *ExtensionConfig, isRespawn bool) error {
	// Expand ~ to home directory
	if strings.HasPrefix(extensionPath, "~/") {
		home, _ := os.UserHomeDir()
		extensionPath = filepath.Join(home, extensionPath[2:])
	}

	// Resolve to absolute path
	absPath, err := filepath.Abs(extensionPath)
	if err != nil {
		return fmt.Errorf("resolve extension path: %w", err)
	}
	extensionPath = absPath

	// Verify the path exists and is a file
	info, err := os.Stat(extensionPath)
	if err != nil {
		return fmt.Errorf("extension path not found: %w", err)
	}
	if info.IsDir() {
		return fmt.Errorf("expected extension file, got directory: %s (point to the entry point file directly, e.g. %s/index.js)", extensionPath, extensionPath)
	}

	extensionDir := filepath.Dir(extensionPath)

	// Optional extension.json manifest. Absent file is fine; bad JSON or
	// unknown keys fail the load loudly.
	manifest, err := LoadManifest(extensionDir)
	if err != nil {
		return fmt.Errorf("manifest: %w", err)
	}

	// Run `npm install` if the extension declares dependencies. Idempotent:
	// skips when node_modules is up to date with package.json.
	if err := ensureNodeModules(extensionDir); err != nil {
		return fmt.Errorf("npm install: %w", err)
	}

	// Determine how to run the extension based on file extension
	binPath := extensionPath
	ext := filepath.Ext(extensionPath)
	switch ext {
	case ".ts":
		jsPath, transpileErr := h.transpileTS(extensionPath, manifest)
		if transpileErr != nil {
			return fmt.Errorf("typescript transpile failed: %w", transpileErr)
		}
		h.tempFiles = append(h.tempFiles, jsPath)
		binPath = jsPath
	case ".js":
		// Use directly, will run via node below
	default:
		// Treat as binary, execute directly
	}

	var cmd *exec.Cmd
	binExt := filepath.Ext(binPath)
	if binExt == ".js" || binExt == ".mjs" || binExt == ".cjs" {
		nodeBin := "node"
		// Look in common locations when node isn't in PATH (daemon mode)
		if _, err := exec.LookPath(nodeBin); err != nil {
			for _, candidate := range []string{
				"/opt/homebrew/bin/node",
				"/usr/local/bin/node",
			} {
				if _, serr := os.Stat(candidate); serr == nil {
					nodeBin = candidate
					break
				}
			}
		}
		cmd = exec.Command(nodeBin, "--enable-source-maps", binPath)
	} else {
		cmd = exec.Command(binPath)
	}
	cmd.Dir = extensionDir
	cmd.Stderr = os.Stderr

	// Resolve external runtime requires (e.g. native modules) from the
	// extension's own node_modules. Other env vars are inherited.
	nodeModules := filepath.Join(extensionDir, "node_modules")
	if st, statErr := os.Stat(nodeModules); statErr == nil && st.IsDir() {
		envExtra := "NODE_PATH=" + nodeModules
		if existing := os.Getenv("NODE_PATH"); existing != "" {
			envExtra = envExtra + string(os.PathListSeparator) + existing
		}
		cmd.Env = append(os.Environ(), envExtra)
	}

	stdin, err := cmd.StdinPipe()
	if err != nil {
		return fmt.Errorf("stdin pipe: %w", err)
	}

	stdout, err := cmd.StdoutPipe()
	if err != nil {
		_ = stdin.Close()
		return fmt.Errorf("stdout pipe: %w", err)
	}

	if err := cmd.Start(); err != nil {
		_ = stdin.Close()
		return fmt.Errorf("start extension: %w", err)
	}

	scanner := bufio.NewScanner(stdout)
	h.cmd = cmd
	h.process = cmd.Process
	h.stdin = stdin
	h.stdout = scanner
	h.dead.Store(false)
	h.deathReported.Store(false)
	h.lastParseErrAt.Store(0)
	h.turnInFlightAtDeath.Store(false)
	// Fresh deadCh per spawn — old channel (if any) is already closed.
	h.deadCh = make(chan struct{})
	h.deadOnce = &sync.Once{}

	// Start the background response reader before sending init so we can
	// receive the init response through the normal call path. Pass the
	// scanner directly so the goroutine doesn't have to read h.stdout
	// (which disposeInternal nils out under h.mu and would race here).
	h.readerWg.Add(1)
	go h.readLoop(scanner)

	// Ensure the config's ExtensionDir points to the directory containing
	// the entry point so extensions can find sibling files.
	if config != nil {
		config.ExtensionDir = extensionDir
	}

	// Send init and wait for response. On error, return without disposing —
	// the caller (Load/Respawn) holds h.mu and will run disposeInternal after
	// releasing the lock. Disposing here would deadlock on h.mu.
	initResult, err := h.call("init", config)
	if err != nil {
		return fmt.Errorf("init handshake: %w", err)
	}

	// Parse init response to register tools and commands
	h.parseInitResult(initResult)

	// Hook forwarders are registered on the SDK once, on first Load. The
	// SDK survives respawns; the subprocess does not.
	if !isRespawn {
		h.registerHookForwarders()
	}

	verb := "loaded"
	if isRespawn {
		verb = "respawned"
	}
	utils.Log("extension", fmt.Sprintf("%s extension from %s (pid %d)", verb, extensionPath, cmd.Process.Pid))
	return nil
}

// Respawn relaunches the subprocess after a death has been detected. Returns
// ErrBudgetExceeded if the strike budget (3 attempts in the last 60s) is
// exhausted. The host has been alive for >2 minutes, attempts reset to 0
// before this respawn so a long-running extension that crashes once is not
// permanently capped.
//
// Callers must verify h.dead.Load() before invoking. Safe to call concurrently
// — the internal mutex serializes spawn attempts.
func (h *Host) Respawn() (attemptNumber int, err error) {
	h.mu.Lock()

	if !h.dead.Load() {
		h.mu.Unlock()
		return 0, nil
	}
	if h.respawnPermanent.Load() {
		h.mu.Unlock()
		return 0, ErrBudgetExceeded
	}
	if h.loadedPath == "" {
		h.mu.Unlock()
		return 0, fmt.Errorf("respawn: no cached spawn parameters (host was never loaded)")
	}

	now := time.Now().UnixNano()
	// Reset attempt counter if the host was healthy long enough.
	if last := h.lastHealthyAt.Load(); last > 0 && now-last >= int64(respawnHealthyReset) {
		h.respawnAttempts.Store(0)
		h.respawnWindowStart.Store(0)
	}
	// Slide the window if the previous one expired.
	if start := h.respawnWindowStart.Load(); start == 0 || now-start >= int64(respawnBudgetWindow) {
		h.respawnWindowStart.Store(now)
		h.respawnAttempts.Store(0)
	}
	attempt := h.respawnAttempts.Add(1)
	if attempt > respawnBudgetMax {
		h.respawnPermanent.Store(true)
		h.mu.Unlock()
		return int(attempt), ErrBudgetExceeded
	}

	// disposeInternal cleared cmd/stdin/stdout when the subprocess died.
	// Nothing else to tear down — go straight to spawn.
	spawnErr := h.spawnAndInit(h.loadedPath, h.loadedConfig, true)
	if spawnErr == nil {
		h.lastHealthyAt.Store(time.Now().UnixNano())
	}
	h.mu.Unlock()
	if spawnErr != nil {
		// Release the partially-initialized subprocess outside h.mu so
		// disposeInternal can re-acquire and the reader goroutine can exit.
		h.disposeInternal()
		return int(attempt), fmt.Errorf("respawn spawn: %w", spawnErr)
	}
	return int(attempt), nil
}

// SetOnDeath registers a callback fired (in a fresh goroutine) when the
// reader loop detects the subprocess has died. The session manager uses
// this to schedule a respawn after the active run completes.
func (h *Host) SetOnDeath(fn func(*Host)) {
	h.mu.Lock()
	defer h.mu.Unlock()
	h.onDeath = fn
}

// Dead reports whether the subprocess has died (reader loop terminated).
// Safe to call concurrently — backed by an atomic.
func (h *Host) Dead() bool {
	return h.dead.Load()
}

// MarkTurnInFlight records that a turn was active at the moment of death so
// the respawn path knows to fire turn_aborted on the new instance.
func (h *Host) MarkTurnInFlight(active bool) {
	h.turnInFlightAtDeath.Store(active)
}

// TurnInFlightAtDeath returns whether a turn was active when the subprocess
// died. Called by the respawn flow to decide if turn_aborted should fire.
func (h *Host) TurnInFlightAtDeath() bool {
	return h.turnInFlightAtDeath.Load()
}

// LastExit returns the last observed exit code (or nil if none) and signal
// (empty if none) of the dying subprocess. Used in event payloads.
func (h *Host) LastExit() (*int, string) {
	code := h.lastExitCode.Load()
	var codePtr *int
	// We store unix nanos in lastExitCode to differentiate "no code yet"
	// (== minInt64) from genuine 0 exit. Encoding: bit 63 set means
	// uninitialized; otherwise low 32 bits are the exit code.
	if code != -1 {
		c := int(code)
		codePtr = &c
	}
	var sig string
	if p := h.lastExitSignal.Load(); p != nil {
		sig = *p
	}
	return codePtr, sig
}

// captureExitStatus calls cmd.Wait to reap the dead subprocess and stores
// the exit code/signal so downstream events (engine_extension_died,
// extension_respawned) can include them.
func (h *Host) captureExitStatus() {
	h.mu.Lock()
	cmd := h.cmd
	h.mu.Unlock()
	if cmd == nil {
		return
	}
	err := cmd.Wait()
	if err == nil {
		h.lastExitCode.Store(0)
		return
	}
	// exec.ExitError carries the exit code and signal.
	if exitErr, ok := err.(*exec.ExitError); ok {
		ws := exitErr.ProcessState
		if ws.Exited() {
			h.lastExitCode.Store(int64(ws.ExitCode()))
		} else {
			// Killed by signal — record signal name, leave code as -1.
			if status, ok := ws.Sys().(interface{ Signal() os.Signal }); ok {
				sig := status.Signal().String()
				h.lastExitSignal.Store(&sig)
			}
		}
	}
}


