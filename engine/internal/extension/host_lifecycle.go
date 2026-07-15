package extension

import (
	"bufio"
	"errors"
	"fmt"
	"io"
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
	// Capture spawn start so we can record the cold-start readiness latency
	// (process launch → successful init handshake) for extension.coldstart
	// telemetry (family 4e). Caller holds h.mu, so the write to
	// h.lastSpawnReadyMs below is serialized with SpawnReadyMs's read.
	spawnStart := time.Now()

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

	// Verify the path exists. A directory is resolved to its conventional
	// entry point (extension.ts, index.ts, extension.js, index.js — first
	// match wins). This is what lets dispatch-path callers pass the
	// DispatchAgentOpts.ExtensionDir they already hold (the SDK field is a
	// directory by name and by convention: ctx.config.extensionDir) without
	// every harness re-implementing entry-point discovery. Root-session
	// loads still pass full file paths and take the file branch unchanged.
	info, err := os.Stat(extensionPath)
	if err != nil {
		return fmt.Errorf("extension path not found: %w", err)
	}
	if info.IsDir() {
		entry, entryErr := resolveExtensionEntry(extensionPath)
		if entryErr != nil {
			return entryErr
		}
		utils.LogWithFields(utils.LevelInfo, "extension", "resolved directory to entry point", map[string]any{"ext_dir": extensionPath, "entry": entry})
		extensionPath = entry
	}

	extensionDir := filepath.Dir(extensionPath)

	// Optional extension.json manifest. Absent file is fine; bad JSON or
	// unknown keys fail the load loudly.
	manifest, err := LoadManifest(extensionDir)
	if err != nil {
		return fmt.Errorf("manifest: %w", err)
	}

	// Default name from manifest or directory — overridden by init response
	// if non-empty. This ensures every log line and event has a useful name
	// even when the subprocess dies before completing the init handshake.
	if manifest != nil && manifest.Name != "" {
		h.name = manifest.Name
	} else {
		h.name = filepath.Base(extensionDir)
	}
	// Capture the extension version from the manifest. This is stamped once at
	// load time and never changes — manifest version is a build-time constant.
	// The version reaches the session layer via Host.Version(), read from
	// start_session.go when the extension group is assembled.
	if manifest != nil && manifest.Version != "" {
		h.version = manifest.Version
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

	stderr, err := cmd.StderrPipe()
	if err != nil {
		_ = stdin.Close()
		return fmt.Errorf("stderr pipe: %w", err)
	}

	if err := cmd.Start(); err != nil {
		_ = stdin.Close()
		return fmt.Errorf("start extension: %w", err)
	}

	// Capture subprocess stderr into a ring buffer and log each line.
	// This runs until the pipe closes (subprocess exit or dispose).
	h.stderrMu.Lock()
	h.stderrBuf = nil // reset for respawns
	h.stderrMu.Unlock()
	h.launchStderrDrain(stderr)

	scanner := bufio.NewScanner(stdout)
	// Raise the scanner's max token size from the 64 KB default to 4 MB.
	// The resource/query RPC path can return unbounded arrays of content-rich
	// items as a single NDJSON line that easily exceed 64 KB.
	scanner.Buffer(make([]byte, 64*1024), 4*1024*1024)
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
	// Fresh exitDone per spawn so the readLoop defer can wait for
	// captureExitStatus before firing the onDeath callback.
	h.exitDone = make(chan struct{})

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

	// Record the cold-start readiness latency now that the init handshake
	// succeeded. Caller holds h.mu.
	h.lastSpawnReadyMs = time.Since(spawnStart).Milliseconds()

	// Hook forwarders are registered on the SDK once, on first Load. The
	// SDK survives respawns; the subprocess does not.
	if !isRespawn {
		h.registerHookForwarders()
	}

	verb := "loaded"
	if isRespawn {
		verb = "respawned"
	}
	utils.LogWithFields(utils.LevelInfo, "extension", "extension from (pid )", map[string]any{"verb": verb, "extension_path": extensionPath, "run_id": cmd.Process.Pid})
	return nil
}

// launchStderrDrain starts the background goroutine that copies subprocess
// stderr into the ring buffer and logs each line. It snapshots h.name into a
// local BEFORE launching the goroutine: parseInitResult may write h.name
// concurrently (when the init message carries a different name than the
// manifest), and reading h.name from inside the goroutine would be an
// unsynchronised access the race detector flags. The tag is cosmetic debug
// output; the pre-launch snapshot is the correct identity for this subprocess
// lifetime. Extracted from spawnAndInit so the snapshot-before-launch
// ordering is pinned by a regression test (host_stderr_race_test.go).
func (h *Host) launchStderrDrain(stderr io.Reader) {
	stderrTag := "ext:" + h.name
	go func() {
		sc := bufio.NewScanner(stderr)
		for sc.Scan() {
			line := sc.Text()
			h.appendStderr(line)
			utils.Debug(stderrTag, line)
		}
	}()
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

// RespawnAttempt returns the current respawn attempt count within the active
// rolling strike window. Surfaced on extension.respawn telemetry (family 4e).
func (h *Host) RespawnAttempt() int { return int(h.respawnAttempts.Load()) }

// RespawnBudget returns the maximum number of respawn attempts allowed within
// the rolling strike window. Surfaced on extension.respawn telemetry (family 4e).
func (h *Host) RespawnBudget() int { return int(respawnBudgetMax) }

// SpawnReadyMs returns the wall-clock (milliseconds) that the most recent
// spawnAndInit took from process launch to a successful init handshake.
// Surfaced on extension.coldstart telemetry (family 4e). Returns 0 before the
// first successful spawn.
func (h *Host) SpawnReadyMs() int64 {
	h.mu.Lock()
	v := h.lastSpawnReadyMs
	h.mu.Unlock()
	return v
}

// Dead reports whether the subprocess has died (reader loop terminated).
// Safe to call concurrently — backed by an atomic.
func (h *Host) Dead() bool {
	return h.dead.Load()
}

// KillSubprocessForTest sends SIGKILL to the running subprocess.
// Exposed for integration tests only — production code lets the
// process exit naturally and relies on the readLoop's EOF detection
// to fire the death signal. Returns nil if no subprocess is running.
//
// After calling this, callers typically wait for h.Dead() to return
// true (the readLoop sets it asynchronously), then invoke Respawn
// to recreate the subprocess.
func (h *Host) KillSubprocessForTest() error {
	h.mu.Lock()
	p := h.process
	h.mu.Unlock()
	if p == nil {
		return nil
	}
	return p.Kill()
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
// extension_respawned) can include them. Closes h.exitDone when finished
// so the readLoop defer can gate the onDeath callback on exit-info
// availability.
func (h *Host) captureExitStatus() {
	defer func() {
		if ch := h.exitDone; ch != nil {
			close(ch)
		}
	}()
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


// extensionEntryCandidates is the conventional entry-point search order used
// when Load is given a directory instead of a file. TypeScript-first because
// the SDK's primary consumers are TS extensions (the engine transpiles .ts
// on load); .js/.mjs cover pre-bundled extensions.
var extensionEntryCandidates = []string{
	"extension.ts",
	"index.ts",
	"extension.js",
	"index.js",
	"extension.mjs",
	"index.mjs",
}

// resolveExtensionEntry maps an extension directory to its entry-point file
// by probing the conventional candidates in order. Returns a descriptive
// error naming the directory and the probed candidates when none exists.
func resolveExtensionEntry(extDir string) (string, error) {
	for _, name := range extensionEntryCandidates {
		candidate := filepath.Join(extDir, name)
		if info, err := os.Stat(candidate); err == nil && !info.IsDir() {
			return candidate, nil
		}
	}
	return "", fmt.Errorf("no extension entry point in %s (looked for %s)", extDir, strings.Join(extensionEntryCandidates, ", "))
}
