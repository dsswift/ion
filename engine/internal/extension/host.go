package extension

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/dsswift/ion/engine/internal/sandbox"
	"github.com/dsswift/ion/engine/internal/types"
	"github.com/dsswift/ion/engine/internal/utils"
)

const rpcCallTimeout = 30 * time.Second

// Host manages extension subprocess lifecycle. It supports both in-process
// extensions (Go functions registered directly on the SDK) and subprocess
// extensions communicating via JSON-RPC 2.0 over stdin/stdout.
type Host struct {
	mu      sync.Mutex
	sdk     *SDK
	process *os.Process
	stdin   io.WriteCloser
	stdout  *bufio.Scanner
	cmd     *exec.Cmd

	// JSON-RPC response routing
	nextID   atomic.Int64
	pending  map[int64]chan *jsonrpcResponse
	pendMu   sync.Mutex
	dead     atomic.Bool
	readerWg sync.WaitGroup

	// deadCh closes when the subprocess dies (readLoop EOF) or the host is
	// disposed. callers that lose the race between the dead.Load() check and
	// the pending-map insert would otherwise wait the full rpcCallTimeout —
	// callWithTimeout selects on deadCh as a third arm to fail fast.
	// deadOnce guards the close so respawn re-init and dispose-on-init-error
	// don't double-close. Both fields are replaced per spawn in spawnAndInit.
	deadCh   chan struct{}
	deadOnce *sync.Once

	// Temp files created by TS transpilation, cleaned up on Dispose.
	tempFiles []string

	// Extension name returned from init handshake.
	name string

	// Bidirectional RPC: context for extension-initiated notifications.
	currentCtx atomic.Pointer[Context]

	// notifMu guards the callbacks the readLoop reads when dispatching
	// extension-initiated notifications (ext/emit, ext/send_message). Kept
	// separate from h.mu so the readLoop never contends with Load: Load
	// holds h.mu for the entire init handshake, and notifications can
	// arrive mid-handshake before the init response.
	notifMu        sync.RWMutex
	onSendMessage  func(text string)
	persistentEmit func(types.EngineEvent)

	// Rate limit for parse-failure WARNs so a misbehaving extension that
	// floods stdout with non-JSON cannot bury other log signal. Holds a
	// nanosecond timestamp of the last logged parse error.
	lastParseErrAt atomic.Int64

	// Set the first time a hook is invoked after the subprocess has died.
	// Used to emit a single engine_error per death rather than one per
	// hook fire (turn_start/turn_end/permission_request/tool_call... all
	// fire many times per second and would flood the UI otherwise).
	deathReported atomic.Bool

	// Cached spawn parameters so Respawn can replay Load without the
	// session manager round-tripping the original extension path.
	loadedPath   string
	loadedConfig *ExtensionConfig

	// Strike budget for auto-respawn. respawnAttempts increments on each
	// respawn within the rolling window starting at respawnWindowStart.
	// Once the host has been alive past lastHealthyAt + 2 min, the next
	// death detection resets attempts to 0 (long-running extension that
	// crashes once is not permanently capped).
	respawnAttempts    atomic.Int64
	respawnWindowStart atomic.Int64 // unix nanos
	lastHealthyAt      atomic.Int64 // unix nanos when last successfully spawned
	respawnPermanent   atomic.Bool

	// onDeath is invoked from a goroutine after readLoop detects the
	// subprocess is dead. Set by the session manager so it can schedule
	// a respawn after the active run finishes.
	onDeath func(*Host)

	// turnInFlightAtDeath records whether a turn was active when the
	// subprocess died. The respawn flow fires turn_aborted on the new
	// instance only when this is true.
	turnInFlightAtDeath atomic.Bool

	// Last exit code/signal observed from the dying subprocess. Surfaced
	// in extension_respawned and engine_extension_died payloads.
	lastExitCode   atomic.Int64 // negative sentinel = "no code"
	lastExitSignal atomic.Pointer[string]
}

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

// errExtensionDeadSilent is returned from callHook when the subprocess is
// dead. The forwarders recognize it and skip emitting per-hook errors so
// only the first hook after death produces an engine_error event.
var errExtensionDeadSilent = errors.New("extension subprocess is dead (silenced)")

// SetPersistentEmit sets a persistent emit function that handles ext/emit
// notifications when no tool or hook context is active (e.g., background tasks).
func (h *Host) SetPersistentEmit(fn func(types.EngineEvent)) {
	h.notifMu.Lock()
	defer h.notifMu.Unlock()
	h.persistentEmit = fn
}

// NewHost creates a new extension host with an empty SDK.
func NewHost() *Host {
	h := &Host{
		sdk:     NewSDK(),
		pending: make(map[int64]chan *jsonrpcResponse),
	}
	// Start IDs at 1 (0 is reserved/unused).
	h.nextID.Store(1)
	// Sentinel value so LastExit can distinguish "no exit observed yet"
	// from a genuine zero exit code.
	h.lastExitCode.Store(-1)
	return h
}

// SDK returns the underlying hook registry for direct registration.
func (h *Host) SDK() *SDK {
	return h.sdk
}

// Name returns the extension's name as reported by the init handshake.
func (h *Host) Name() string {
	return h.name
}

// SetOnSendMessage sets the callback invoked when the extension sends an
// ext/send_message notification. The session manager uses this to queue
// follow-up prompts from extension-initiated messages.
func (h *Host) SetOnSendMessage(fn func(text string)) {
	h.notifMu.Lock()
	defer h.notifMu.Unlock()
	h.onSendMessage = fn
}

// Load starts a subprocess extension from the given file path. The path must
// point directly to an entry point file (.ts, .js, or binary). TypeScript
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
		stdin.Close()
		return fmt.Errorf("stdout pipe: %w", err)
	}

	if err := cmd.Start(); err != nil {
		stdin.Close()
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

// Dispose shuts down the subprocess extension gracefully.
func (h *Host) Dispose() {
	h.disposeInternal()
}

// signalDead closes deadCh once. Idempotent. callers that added to h.pending
// after readLoop's drain already ran rely on this to unblock their select.
func (h *Host) signalDead() {
	if h.deadOnce != nil {
		h.deadOnce.Do(func() {
			if h.deadCh != nil {
				close(h.deadCh)
			}
		})
	}
}

// disposeInternal performs the shutdown. It briefly takes h.mu to mutate
// process/stdin/stdout/tempFiles fields, then releases the lock before
// waiting for the reader goroutine — the reader's defer needs h.mu to read
// h.onDeath, so holding the lock across Wait() would deadlock.
func (h *Host) disposeInternal() {
	// Mark dead so the reader goroutine stops and pending calls fail fast.
	h.dead.Store(true)
	h.signalDead()

	// Drain all pending calls with an error.
	h.pendMu.Lock()
	for id, ch := range h.pending {
		close(ch)
		delete(h.pending, id)
	}
	h.pendMu.Unlock()

	h.mu.Lock()
	if h.stdin != nil {
		h.stdin.Close()
		h.stdin = nil
	}
	if h.process != nil {
		h.process.Kill()
		h.process = nil
	}
	cmd := h.cmd
	h.cmd = nil
	h.stdout = nil
	tempFiles := h.tempFiles
	h.tempFiles = nil
	h.mu.Unlock()

	if cmd != nil {
		cmd.Wait()
	}
	for _, f := range tempFiles {
		os.Remove(f)
	}

	// Wait for the reader goroutine to exit. Must be outside h.mu — the
	// reader's defer block acquires h.mu to read h.onDeath.
	h.readerWg.Wait()
}

// transpileTS bundles a TypeScript file to JavaScript using the esbuild CLI.
// Returns the path to the bundled .mjs file. The output lands in a
// `.ion-build/` directory inside the extension's own folder so Node's ESM
// resolver can walk up and find the extension's node_modules for any
// declared external packages.
//
// The optional manifest contributes additional `--external:<name>` flags
// so declared external packages (typically native modules) are not
// bundled and instead resolve at runtime from `<extDir>/node_modules`.
func (h *Host) transpileTS(tsPath string, manifest *Manifest) (string, error) {
	extDir := filepath.Dir(tsPath)
	buildDir := filepath.Join(extDir, ".ion-build")
	if err := os.MkdirAll(buildDir, 0755); err != nil {
		return "", fmt.Errorf("create build dir: %w", err)
	}
	// Plant a .gitignore so build artifacts don't accidentally land in
	// version control. Best-effort; ignore errors.
	gitignore := filepath.Join(buildDir, ".gitignore")
	if _, err := os.Stat(gitignore); os.IsNotExist(err) {
		_ = os.WriteFile(gitignore, []byte("*\n"), 0644)
	}
	// Output as .mjs so Node treats the bundle as ESM regardless of any
	// package.json `type` field nearby. ESM is required for top-level
	// `await` in extension code, which Node 20 supports natively.
	outPath := filepath.Join(buildDir, fmt.Sprintf("ext-%d.mjs", time.Now().UnixNano()))

	esbuildBin := "esbuild"
	// Look in common locations when esbuild isn't in PATH (daemon mode)
	if _, err := exec.LookPath(esbuildBin); err != nil {
		for _, candidate := range []string{
			"/opt/homebrew/bin/esbuild",
			"/usr/local/bin/esbuild",
		} {
			if _, err := os.Stat(candidate); err == nil {
				esbuildBin = candidate
				break
			}
		}
	}
	args := []string{
		tsPath,
		"--bundle",
		"--format=esm",
		"--target=node20",
		"--platform=node",
		"--sourcemap=inline",
		"--outfile=" + outPath,
		"--external:child_process",
		"--external:fs",
		"--external:path",
		"--external:os",
		"--external:net",
		"--external:crypto",
		"--external:events",
		"--external:readline",
		"--external:stream",
		"--external:util",
		"--external:node:*",
	}
	if manifest != nil {
		for _, dep := range manifest.External {
			if dep == "" {
				continue
			}
			args = append(args, "--external:"+dep)
		}
	}
	cmd := exec.Command(esbuildBin, args...)
	var stderr bytes.Buffer
	cmd.Stderr = &stderr

	if err := cmd.Run(); err != nil {
		return "", fmt.Errorf("esbuild failed: %w\n%s\n(install with: npm i -g esbuild)", err, stderr.String())
	}

	utils.Log("extension", fmt.Sprintf("transpiled %s -> %s", tsPath, outPath))
	return outPath, nil
}

// ensureNodeModules runs `npm install` for an extension that ships a
// package.json. Idempotent: when node_modules already exists and is at
// least as new as package.json, the install is skipped. The first install
// has a 120 s timeout so a hung registry doesn't deadlock the engine.
//
// Extensions without package.json are a no-op. The engine bundles its
// own SDK, so most extensions need no install step at all.
func ensureNodeModules(extDir string) error {
	pkgPath := filepath.Join(extDir, "package.json")
	pkgInfo, err := os.Stat(pkgPath)
	if err != nil {
		if os.IsNotExist(err) {
			return nil
		}
		return fmt.Errorf("stat %s: %w", pkgPath, err)
	}

	nodeModules := filepath.Join(extDir, "node_modules")
	nmInfo, nmErr := os.Stat(nodeModules)
	if nmErr == nil && nmInfo.IsDir() {
		// node_modules already exists. Compare against the resolution
		// stamp file (lockfile or .package-lock.json) to decide whether
		// the install is stale.
		stampCandidates := []string{
			filepath.Join(nodeModules, ".package-lock.json"),
			filepath.Join(extDir, "package-lock.json"),
			filepath.Join(extDir, "npm-shrinkwrap.json"),
		}
		var newest time.Time
		for _, candidate := range stampCandidates {
			if st, err := os.Stat(candidate); err == nil && st.ModTime().After(newest) {
				newest = st.ModTime()
			}
		}
		if !newest.IsZero() && !pkgInfo.ModTime().After(newest) {
			utils.Log("extension", fmt.Sprintf("node_modules up to date in %s", extDir))
			return nil
		}
	}

	npmBin := "npm"
	if _, err := exec.LookPath(npmBin); err != nil {
		for _, candidate := range []string{
			"/opt/homebrew/bin/npm",
			"/usr/local/bin/npm",
		} {
			if _, serr := os.Stat(candidate); serr == nil {
				npmBin = candidate
				break
			}
		}
	}

	utils.Log("extension", fmt.Sprintf("running npm install in %s", extDir))

	ctx, cancel := context.WithTimeout(context.Background(), 120*time.Second)
	defer cancel()

	cmd := exec.CommandContext(ctx, npmBin, "install",
		"--omit=dev",
		"--no-fund",
		"--no-audit",
		"--no-progress",
	)
	cmd.Dir = extDir
	var stderr bytes.Buffer
	cmd.Stderr = &stderr
	cmd.Stdout = &stderr // collapse to single buffer
	if err := cmd.Run(); err != nil {
		return fmt.Errorf("npm install in %s: %w\n%s", extDir, err, stderr.String())
	}
	utils.Log("extension", fmt.Sprintf("npm install completed in %s", extDir))
	return nil
}

// parseInitResult extracts tools and commands from the subprocess init response
// and registers them on the SDK.
func (h *Host) parseInitResult(raw json.RawMessage) {
	if len(raw) == 0 || string(raw) == "null" {
		return
	}

	var result struct {
		Name  string `json:"name"`
		Tools []struct {
			Name        string                 `json:"name"`
			Description string                 `json:"description"`
			Parameters  map[string]interface{} `json:"parameters"`
		} `json:"tools"`
		Commands map[string]struct {
			Description string `json:"description"`
		} `json:"commands"`
	}
	if err := json.Unmarshal(raw, &result); err != nil {
		utils.Log("extension", fmt.Sprintf("init result parse error: %v", err))
		return
	}

	if result.Name != "" {
		h.name = result.Name
	}

	for _, t := range result.Tools {
		toolName := t.Name // capture for closure
		h.sdk.RegisterTool(ToolDefinition{
			Name:        t.Name,
			Description: t.Description,
			Parameters:  t.Parameters,
			Execute: func(params interface{}, ctx *Context) (*types.ToolResult, error) {
				h.currentCtx.Store(ctx)
				defer h.currentCtx.Store(nil)
				raw, err := h.call("tool/"+toolName, params)
				if err != nil {
					return &types.ToolResult{Content: err.Error(), IsError: true}, nil
				}
				if len(raw) == 0 || string(raw) == "null" {
					return &types.ToolResult{Content: ""}, nil
				}
				var content interface{}
				if err := json.Unmarshal(raw, &content); err != nil {
					return &types.ToolResult{Content: string(raw)}, nil
				}
				formatted, _ := json.MarshalIndent(content, "", "  ")
				return &types.ToolResult{Content: string(formatted)}, nil
			},
		})
	}

	for name, def := range result.Commands {
		cmdName := name // capture for closure
		h.sdk.RegisterCommand(name, CommandDefinition{
			Description: def.Description,
			Execute: func(args string, ctx *Context) error {
				h.currentCtx.Store(ctx)
				defer h.currentCtx.Store(nil)
				_, err := h.call("command/"+cmdName, map[string]string{"args": args})
				return err
			},
		})
	}

	if len(result.Tools) > 0 || len(result.Commands) > 0 {
		utils.Log("extension", fmt.Sprintf("registered %d tools, %d commands from init",
			len(result.Tools), len(result.Commands)))
	}
}

// Tools returns all registered tool definitions from the SDK.
func (h *Host) Tools() []ToolDefinition {
	return h.sdk.Tools()
}

// Commands returns all registered command definitions from the SDK.
func (h *Host) Commands() map[string]CommandDefinition {
	return h.sdk.Commands()
}

// --- Delegated fire methods ---

func (h *Host) FireSessionStart(ctx *Context) error         { return h.sdk.FireSessionStart(ctx) }
func (h *Host) FireSessionEnd(ctx *Context) error           { return h.sdk.FireSessionEnd(ctx) }
func (h *Host) FireMessageStart(ctx *Context) error         { return h.sdk.FireMessageStart(ctx) }
func (h *Host) FireMessageEnd(ctx *Context) error           { return h.sdk.FireMessageEnd(ctx) }
func (h *Host) FireToolEnd(ctx *Context) error              { return h.sdk.FireToolEnd(ctx) }
func (h *Host) FireOnError(ctx *Context, info ErrorInfo) error {
	return h.sdk.FireOnError(ctx, info)
}

func (h *Host) FireBeforeAgentStart(ctx *Context, info AgentInfo) (string, error) {
	return h.sdk.FireBeforeAgentStart(ctx, info)
}

func (h *Host) FireBeforePrompt(ctx *Context, prompt string) (string, string, error) {
	return h.sdk.FireBeforePrompt(ctx, prompt)
}

func (h *Host) FirePlanModePrompt(ctx *Context, planFilePath string) (string, []string) {
	return h.sdk.FirePlanModePrompt(ctx, planFilePath)
}

func (h *Host) FireContextInject(ctx *Context, info ContextInjectInfo) []ContextEntry {
	return h.sdk.FireContextInject(ctx, info)
}

func (h *Host) FireCapabilityDiscover(ctx *Context) []Capability {
	return h.sdk.FireCapabilityDiscover(ctx)
}

func (h *Host) FireCapabilityMatch(ctx *Context, info CapabilityMatchInfo) *CapabilityMatchResult {
	return h.sdk.FireCapabilityMatch(ctx, info)
}

func (h *Host) FireToolCall(ctx *Context, info ToolCallInfo) (*ToolCallResult, error) {
	return h.sdk.FireToolCall(ctx, info)
}

func (h *Host) FireToolStart(ctx *Context, info ToolStartInfo) error {
	return h.sdk.FireToolStart(ctx, info)
}

func (h *Host) FireSessionBeforeCompact(ctx *Context, info CompactionInfo) (bool, error) {
	return h.sdk.FireSessionBeforeCompact(ctx, info)
}

func (h *Host) FireSessionBeforeFork(ctx *Context, info ForkInfo) (bool, error) {
	return h.sdk.FireSessionBeforeFork(ctx, info)
}

func (h *Host) FireSessionFork(ctx *Context, info ForkInfo) error {
	return h.sdk.FireSessionFork(ctx, info)
}

func (h *Host) FireInput(ctx *Context, prompt string) (string, error) {
	return h.sdk.FireInput(ctx, prompt)
}

func (h *Host) FirePerToolCall(ctx *Context, toolName string, info interface{}) (*PerToolCallResult, error) {
	return h.sdk.FirePerToolCall(ctx, toolName, info)
}

func (h *Host) FirePerToolResult(ctx *Context, toolName string, info interface{}) (string, error) {
	return h.sdk.FirePerToolResult(ctx, toolName, info)
}

func (h *Host) FireContextDiscover(ctx *Context, info ContextDiscoverInfo) (bool, error) {
	return h.sdk.FireContextDiscover(ctx, info)
}

func (h *Host) FireContextLoad(ctx *Context, info ContextLoadInfo) (string, bool, error) {
	return h.sdk.FireContextLoad(ctx, info)
}
func (h *Host) FireModelSelect(ctx *Context, info ModelSelectInfo) (string, error) {
	return h.sdk.FireModelSelect(ctx, info)
}

// RegisterRequiredHooks prepends enterprise-mandated hooks. Each HookDef
// maps an event name to a shell command handler. The handler receives the
// hook payload as JSON on stdin and returns an optional result on stdout.
// Required hooks run before any extension-registered hooks.
func (h *Host) RegisterRequiredHooks(hooks []struct{ Event, Handler string }) {
	for _, hk := range hooks {
		handler := hk.Handler // capture for closure
		h.sdk.PrependHook(hk.Event, func(ctx *Context, payload interface{}) (interface{}, error) {
			payloadBytes, _ := json.Marshal(payload)
			cmd := exec.Command("sh", "-c", handler)
			cmd.Stdin = bytes.NewReader(payloadBytes)
			out, err := cmd.Output()
			if err != nil {
				utils.Log("RequiredHook", fmt.Sprintf("hook %q failed: %v", handler, err))
				return nil, fmt.Errorf("required hook failed: %w", err)
			}
			if len(bytes.TrimSpace(out)) == 0 {
				return nil, nil
			}
			var result interface{}
			if jsonErr := json.Unmarshal(out, &result); jsonErr != nil {
				return string(out), nil
			}
			return result, nil
		})
	}
}

// --- Extension notifications ---

// handleExtNotification processes extension-initiated JSON-RPC notifications
// (messages with a method field but no pending response ID). These allow
// extensions to emit events and queue messages back to the engine.
func (h *Host) handleExtNotification(method string, raw []byte) {
	switch method {
	case "ext/emit":
		var notif struct {
			Params types.EngineEvent `json:"params"`
		}
		if err := json.Unmarshal(raw, &notif); err != nil {
			utils.Log("extension", fmt.Sprintf("ext/emit parse error: %v", err))
			return
		}
		// Resolve emit function: prefer active context, fall back to persistent emit
		var emitFn func(types.EngineEvent)
		if ctx := h.currentCtx.Load(); ctx != nil && ctx.Emit != nil {
			emitFn = ctx.Emit
		} else {
			h.notifMu.RLock()
			emitFn = h.persistentEmit
			h.notifMu.RUnlock()
		}
		if emitFn == nil {
			return
		}
		// Validate engine_agent_state payloads before forwarding
		if notif.Params.Type == "engine_agent_state" {
			var warnings []string
			for i, agent := range notif.Params.Agents {
				if agent.Name == "" {
					warnings = append(warnings, fmt.Sprintf("agent[%d]: missing name", i))
				}
				if md := agent.Metadata; md != nil {
					if dn, ok := md["displayName"]; !ok || dn == nil || dn == "" {
						warnings = append(warnings, fmt.Sprintf("agent[%d] (%s): missing displayName in metadata", i, agent.Name))
					}
				}
			}
			if len(warnings) > 0 {
				msg := fmt.Sprintf("extension emitted malformed engine_agent_state: %s", strings.Join(warnings, "; "))
				utils.Warn("extension", msg)
				emitFn(types.EngineEvent{
					Type:         "engine_error",
					EventMessage: msg,
					ErrorCode:    "malformed_agent_state",
				})
			}
		}
		emitFn(notif.Params)
	case "ext/send_message":
		var notif struct {
			Params struct {
				Text string `json:"text"`
			} `json:"params"`
		}
		if err := json.Unmarshal(raw, &notif); err != nil {
			utils.Log("extension", fmt.Sprintf("ext/send_message parse error: %v", err))
			return
		}
		h.notifMu.RLock()
		fn := h.onSendMessage
		h.notifMu.RUnlock()
		if fn != nil && notif.Params.Text != "" {
			fn(notif.Params.Text)
		}
	case "log":
		// Native SDK logging channel. Routes structured log calls (and
		// redirected console.* output) through the JSON-RPC frame so
		// nothing ever lands on the subprocess's raw stdout.
		var notif struct {
			Params struct {
				Level   string         `json:"level"`
				Message string         `json:"message"`
				Fields  map[string]any `json:"fields,omitempty"`
			} `json:"params"`
		}
		if err := json.Unmarshal(raw, &notif); err != nil {
			utils.Log("extension", fmt.Sprintf("log notif parse error: %v", err))
			return
		}
		tag := "ext"
		if h.name != "" {
			tag = "ext:" + h.name
		}
		body := notif.Params.Message
		if len(notif.Params.Fields) > 0 {
			if extra, err := json.Marshal(notif.Params.Fields); err == nil {
				body = body + " " + string(extra)
			}
		}
		switch notif.Params.Level {
		case "error":
			utils.Error(tag, body)
		case "warn":
			utils.Warn(tag, body)
		case "debug":
			utils.Debug(tag, body)
		default:
			utils.Info(tag, body)
		}
	default:
		utils.Log("extension", fmt.Sprintf("unknown notification method: %s", method))
	}
}

// handleExtRequest processes extension-initiated JSON-RPC requests (messages
// with both a method and id field). The engine sends a response back.
func (h *Host) handleExtRequest(method string, id int64, raw []byte) {
	ctx := h.currentCtx.Load()
	switch method {
	case "ext/register_process":
		var req struct {
			Params struct {
				Name string `json:"name"`
				PID  int    `json:"pid"`
				Task string `json:"task"`
			} `json:"params"`
		}
		if err := json.Unmarshal(raw, &req); err != nil {
			h.sendResponse(id, nil, &jsonrpcError{Code: -32602, Message: "invalid params: " + err.Error()})
			return
		}
		if ctx != nil && ctx.RegisterProcess != nil {
			if err := ctx.RegisterProcess(req.Params.Name, req.Params.PID, req.Params.Task); err != nil {
				h.sendResponse(id, nil, &jsonrpcError{Code: -32000, Message: err.Error()})
				return
			}
		}
		h.sendResponse(id, json.RawMessage(`{"ok":true}`), nil)

	case "ext/deregister_process":
		var req struct {
			Params struct {
				Name string `json:"name"`
			} `json:"params"`
		}
		if err := json.Unmarshal(raw, &req); err != nil {
			h.sendResponse(id, nil, &jsonrpcError{Code: -32602, Message: "invalid params: " + err.Error()})
			return
		}
		if ctx != nil && ctx.DeregisterProcess != nil {
			ctx.DeregisterProcess(req.Params.Name)
		}
		h.sendResponse(id, json.RawMessage(`{"ok":true}`), nil)

	case "ext/list_processes":
		var procs []ProcessInfo
		if ctx != nil && ctx.ListProcesses != nil {
			procs = ctx.ListProcesses()
		}
		if procs == nil {
			procs = []ProcessInfo{}
		}
		data, _ := json.Marshal(procs)
		h.sendResponse(id, data, nil)

	case "ext/terminate_process":
		var req struct {
			Params struct {
				Name string `json:"name"`
			} `json:"params"`
		}
		if err := json.Unmarshal(raw, &req); err != nil {
			h.sendResponse(id, nil, &jsonrpcError{Code: -32602, Message: "invalid params: " + err.Error()})
			return
		}
		if ctx != nil && ctx.TerminateProcess != nil {
			if err := ctx.TerminateProcess(req.Params.Name); err != nil {
				h.sendResponse(id, nil, &jsonrpcError{Code: -32000, Message: err.Error()})
				return
			}
		}
		h.sendResponse(id, json.RawMessage(`{"ok":true}`), nil)

	case "ext/clean_stale_processes":
		var count int
		if ctx != nil && ctx.CleanStaleProcesses != nil {
			count = ctx.CleanStaleProcesses()
		}
		data, _ := json.Marshal(map[string]int{"cleaned": count})
		h.sendResponse(id, data, nil)

	case "ext/discover_agents":
		var req struct {
			Params DiscoverAgentsOpts `json:"params"`
		}
		if err := json.Unmarshal(raw, &req); err != nil {
			h.sendResponse(id, nil, &jsonrpcError{Code: -32602, Message: "parse error: " + err.Error()})
			return
		}
		if ctx != nil && ctx.DiscoverAgents != nil {
			result, err := ctx.DiscoverAgents(req.Params)
			if err != nil {
				h.sendResponse(id, nil, &jsonrpcError{Code: -32000, Message: err.Error()})
				return
			}
			data, _ := json.Marshal(result)
			h.sendResponse(id, json.RawMessage(data), nil)
		} else {
			h.sendResponse(id, nil, &jsonrpcError{Code: -32000, Message: "agent discovery not available"})
		}

	case "ext/suppress_tool":
		var req struct {
			Params struct {
				Name string `json:"name"`
			} `json:"params"`
		}
		if err := json.Unmarshal(raw, &req); err != nil {
			h.sendResponse(id, nil, &jsonrpcError{Code: -32602, Message: "invalid params: " + err.Error()})
			return
		}
		if ctx != nil && ctx.SuppressTool != nil {
			ctx.SuppressTool(req.Params.Name)
		}
		h.sendResponse(id, json.RawMessage(`{"ok":true}`), nil)

	case "ext/dispatch_agent":
		var req struct {
			Params DispatchAgentOpts `json:"params"`
		}
		if err := json.Unmarshal(raw, &req); err != nil {
			h.sendResponse(id, nil, &jsonrpcError{Code: -32602, Message: "parse error: " + err.Error()})
			return
		}
		if ctx != nil && ctx.DispatchAgent != nil {
			go func() {
				// Wire OnEvent to send JSON-RPC notifications during dispatch
				req.Params.OnEvent = func(ev types.EngineEvent) {
					evData, err := json.Marshal(ev)
					if err == nil {
						h.sendNotification("dispatch_event", evData)
					}
				}
				result, err := ctx.DispatchAgent(req.Params)
				if err != nil {
					h.sendResponse(id, nil, &jsonrpcError{Code: -32000, Message: err.Error()})
					return
				}
				data, _ := json.Marshal(result)
				h.sendResponse(id, json.RawMessage(data), nil)
			}()
		} else {
			h.sendResponse(id, nil, &jsonrpcError{Code: -32000, Message: "dispatch not available"})
		}

	case "ext/register_agent_spec":
		var req struct {
			Params types.AgentSpec `json:"params"`
		}
		if err := json.Unmarshal(raw, &req); err != nil {
			h.sendResponse(id, nil, &jsonrpcError{Code: -32602, Message: "parse error: " + err.Error()})
			return
		}
		if ctx == nil || ctx.RegisterAgentSpec == nil {
			h.sendResponse(id, nil, &jsonrpcError{Code: -32000, Message: "agent spec registration not available"})
			return
		}
		if req.Params.Name == "" {
			h.sendResponse(id, nil, &jsonrpcError{Code: -32602, Message: "spec.name is required"})
			return
		}
		ctx.RegisterAgentSpec(req.Params)
		h.sendResponse(id, json.RawMessage(`{"ok":true}`), nil)

	case "ext/deregister_agent_spec":
		var req struct {
			Params struct {
				Name string `json:"name"`
			} `json:"params"`
		}
		if err := json.Unmarshal(raw, &req); err != nil {
			h.sendResponse(id, nil, &jsonrpcError{Code: -32602, Message: "parse error: " + err.Error()})
			return
		}
		if ctx != nil && ctx.DeregisterAgentSpec != nil {
			ctx.DeregisterAgentSpec(req.Params.Name)
		}
		h.sendResponse(id, json.RawMessage(`{"ok":true}`), nil)

	case "ext/elicit":
		var req struct {
			Params struct {
				RequestID string                 `json:"requestId,omitempty"`
				Schema    map[string]interface{} `json:"schema,omitempty"`
				URL       string                 `json:"url,omitempty"`
				Mode      string                 `json:"mode,omitempty"`
			} `json:"params"`
		}
		if err := json.Unmarshal(raw, &req); err != nil {
			h.sendResponse(id, nil, &jsonrpcError{Code: -32602, Message: "parse error: " + err.Error()})
			return
		}
		if ctx == nil || ctx.Elicit == nil {
			h.sendResponse(id, nil, &jsonrpcError{Code: -32000, Message: "elicit not available"})
			return
		}
		go func() {
			resp, cancelled, err := ctx.Elicit(ElicitationRequestInfo{
				RequestID: req.Params.RequestID,
				Schema:    req.Params.Schema,
				URL:       req.Params.URL,
				Mode:      req.Params.Mode,
			})
			if err != nil {
				h.sendResponse(id, nil, &jsonrpcError{Code: -32000, Message: err.Error()})
				return
			}
			data, _ := json.Marshal(struct {
				Response  map[string]interface{} `json:"response,omitempty"`
				Cancelled bool                   `json:"cancelled"`
			}{Response: resp, Cancelled: cancelled})
			h.sendResponse(id, json.RawMessage(data), nil)
		}()

	case "ext/send_prompt":
		var req struct {
			Params struct {
				Text  string `json:"text"`
				Model string `json:"model,omitempty"`
			} `json:"params"`
		}
		if err := json.Unmarshal(raw, &req); err != nil {
			h.sendResponse(id, nil, &jsonrpcError{Code: -32602, Message: "parse error: " + err.Error()})
			return
		}
		if req.Params.Text == "" {
			h.sendResponse(id, nil, &jsonrpcError{Code: -32602, Message: "prompt text required"})
			return
		}
		if ctx == nil || ctx.SendPrompt == nil {
			h.sendResponse(id, nil, &jsonrpcError{Code: -32000, Message: "sendPrompt not available outside an active session"})
			return
		}
		go func() {
			if err := ctx.SendPrompt(req.Params.Text, req.Params.Model); err != nil {
				h.sendResponse(id, nil, &jsonrpcError{Code: -32000, Message: err.Error()})
				return
			}
			h.sendResponse(id, json.RawMessage(`{"ok":true}`), nil)
		}()

	case "ext/call_tool":
		var req struct {
			Params struct {
				Name  string                 `json:"name"`
				Input map[string]interface{} `json:"input"`
			} `json:"params"`
		}
		if err := json.Unmarshal(raw, &req); err != nil {
			h.sendResponse(id, nil, &jsonrpcError{Code: -32602, Message: "parse error: " + err.Error()})
			return
		}
		if req.Params.Name == "" {
			h.sendResponse(id, nil, &jsonrpcError{Code: -32602, Message: "tool name required"})
			return
		}
		if ctx == nil || ctx.CallTool == nil {
			h.sendResponse(id, nil, &jsonrpcError{Code: -32000, Message: "callTool not available outside an active session"})
			return
		}
		go func() {
			content, isError, err := ctx.CallTool(req.Params.Name, req.Params.Input)
			if err != nil {
				h.sendResponse(id, nil, &jsonrpcError{Code: -32000, Message: err.Error()})
				return
			}
			data, _ := json.Marshal(struct {
				Content string `json:"content"`
				IsError bool   `json:"isError,omitempty"`
			}{Content: content, IsError: isError})
			h.sendResponse(id, json.RawMessage(data), nil)
		}()

	case "ext/sandbox_wrap":
		var req struct {
			Params struct {
				Command            string                      `json:"command"`
				Platform           string                      `json:"platform,omitempty"`
				FSAllowWrite       []string                    `json:"fsAllowWrite,omitempty"`
				FSDenyWrite        []string                    `json:"fsDenyWrite,omitempty"`
				FSDenyRead         []string                    `json:"fsDenyRead,omitempty"`
				NetAllowedDomains  []string                    `json:"netAllowedDomains,omitempty"`
				NetBlockedDomains  []string                    `json:"netBlockedDomains,omitempty"`
				NetAllowLocalBind  bool                        `json:"netAllowLocalBind,omitempty"`
				ExtraPatterns      []sandbox.DangerousPattern  `json:"extraPatterns,omitempty"`
			} `json:"params"`
		}
		if err := json.Unmarshal(raw, &req); err != nil {
			h.sendResponse(id, nil, &jsonrpcError{Code: -32602, Message: "parse error: " + err.Error()})
			return
		}
		cfg := sandbox.Config{
			Filesystem: sandbox.FSConfig{
				AllowWrite: req.Params.FSAllowWrite,
				DenyWrite:  req.Params.FSDenyWrite,
				DenyRead:   req.Params.FSDenyRead,
			},
			Network: sandbox.NetConfig{
				AllowedDomains: req.Params.NetAllowedDomains,
				BlockedDomains: req.Params.NetBlockedDomains,
				AllowLocalBind: req.Params.NetAllowLocalBind,
			},
			Patterns: req.Params.ExtraPatterns,
		}
		wrapped, err := sandbox.WrapCommand(req.Params.Command, cfg, req.Params.Platform)
		if err != nil {
			h.sendResponse(id, nil, &jsonrpcError{Code: -32000, Message: err.Error()})
			return
		}
		data, _ := json.Marshal(struct {
			Wrapped  string `json:"wrapped"`
			Platform string `json:"platform"`
		}{Wrapped: wrapped, Platform: func() string {
			if req.Params.Platform != "" {
				return req.Params.Platform
			}
			return sandbox.DetectPlatform()
		}()})
		h.sendResponse(id, json.RawMessage(data), nil)

	default:
		h.sendResponse(id, nil, &jsonrpcError{Code: -32601, Message: "method not found: " + method})
	}
}

// sendResponse writes a JSON-RPC response back to the subprocess.
func (h *Host) sendResponse(id int64, result json.RawMessage, rpcErr *jsonrpcError) {
	resp := struct {
		JSONRPC string          `json:"jsonrpc"`
		ID      int64           `json:"id"`
		Result  json.RawMessage `json:"result,omitempty"`
		Error   *jsonrpcError   `json:"error,omitempty"`
	}{
		JSONRPC: "2.0",
		ID:      id,
		Result:  result,
		Error:   rpcErr,
	}
	data, err := json.Marshal(resp)
	if err != nil {
		utils.Log("extension", fmt.Sprintf("failed to marshal response: %v", err))
		return
	}
	data = append(data, '\n')
	if h.stdin != nil {
		h.stdin.Write(data)
	}
}

// sendNotification writes a JSON-RPC notification (no id) to the subprocess.
func (h *Host) sendNotification(method string, params json.RawMessage) {
	notif := struct {
		JSONRPC string          `json:"jsonrpc"`
		Method  string          `json:"method"`
		Params  json.RawMessage `json:"params,omitempty"`
	}{
		JSONRPC: "2.0",
		Method:  method,
		Params:  params,
	}
	data, err := json.Marshal(notif)
	if err != nil {
		utils.Log("extension", fmt.Sprintf("failed to marshal notification: %v", err))
		return
	}
	data = append(data, '\n')
	if h.stdin != nil {
		h.stdin.Write(data)
	}
}

// --- JSON-RPC 2.0 transport ---

type rpcRequest struct {
	JSONRPC string      `json:"jsonrpc"`
	Method  string      `json:"method"`
	ID      int64       `json:"id"`
	Params  interface{} `json:"params,omitempty"`
}

type jsonrpcResponse struct {
	JSONRPC string          `json:"jsonrpc"`
	ID      int64           `json:"id"`
	Result  json.RawMessage `json:"result,omitempty"`
	Error   *jsonrpcError   `json:"error,omitempty"`
}

type jsonrpcError struct {
	Code    int             `json:"code"`
	Message string          `json:"message"`
	Data    *jsonrpcErrData `json:"data,omitempty"`
}

type jsonrpcErrData struct {
	Stack string `json:"stack,omitempty"`
	Type  string `json:"type,omitempty"`
}

func (e *jsonrpcError) Error() string {
	return fmt.Sprintf("jsonrpc error %d: %s", e.Code, e.Message)
}

type hookError struct {
	Code    int
	Message string
	Stack   string
}

func (e *hookError) Error() string {
	return fmt.Sprintf("jsonrpc error %d: %s", e.Code, e.Message)
}

// send writes a JSON-RPC request to the subprocess stdin. Caller must not
// hold h.mu if calling from the reader goroutine context (it doesn't).
func (h *Host) send(msg rpcRequest) error {
	if h.dead.Load() {
		return fmt.Errorf("extension subprocess is dead")
	}
	if h.stdin == nil {
		return fmt.Errorf("extension not loaded")
	}
	data, err := json.Marshal(msg)
	if err != nil {
		return err
	}
	data = append(data, '\n')
	_, err = h.stdin.Write(data)
	return err
}

// call sends a JSON-RPC request and waits for the matching response.
func (h *Host) call(method string, params interface{}) (json.RawMessage, error) {
	return h.callWithTimeout(method, params, rpcCallTimeout)
}

func (h *Host) callWithTimeout(method string, params interface{}, timeout time.Duration) (json.RawMessage, error) {
	if h.dead.Load() {
		return nil, fmt.Errorf("extension subprocess is dead")
	}

	// Capture deadCh under a stable reference. Respawn replaces h.deadCh
	// with a fresh channel; the in-flight call must observe death of the
	// subprocess it actually targeted.
	deadCh := h.deadCh

	id := h.nextID.Add(1) - 1
	ch := make(chan *jsonrpcResponse, 1)

	h.pendMu.Lock()
	h.pending[id] = ch
	h.pendMu.Unlock()

	req := rpcRequest{
		JSONRPC: "2.0",
		ID:      id,
		Method:  method,
		Params:  params,
	}

	if err := h.send(req); err != nil {
		h.pendMu.Lock()
		delete(h.pending, id)
		h.pendMu.Unlock()
		return nil, fmt.Errorf("send %s: %w", method, err)
	}

	select {
	case resp, ok := <-ch:
		if !ok {
			// Channel closed -- subprocess died.
			return nil, fmt.Errorf("extension subprocess died during %s call", method)
		}
		if resp.Error != nil {
			he := &hookError{
				Code:    resp.Error.Code,
				Message: resp.Error.Message,
			}
			if resp.Error.Data != nil {
				he.Stack = resp.Error.Data.Stack
			}
			return nil, he
		}
		return resp.Result, nil
	case <-deadCh:
		// readLoop's drain may have run before we inserted into h.pending —
		// in that case the channel-close path can't fire. deadCh always
		// closes after death is signaled, so this arm fails fast (~ms)
		// instead of waiting the full timeout.
		h.pendMu.Lock()
		delete(h.pending, id)
		h.pendMu.Unlock()
		return nil, fmt.Errorf("extension subprocess died during %s call", method)
	case <-time.After(timeout):
		h.pendMu.Lock()
		delete(h.pending, id)
		h.pendMu.Unlock()
		return nil, fmt.Errorf("timeout waiting for %s response (id=%d)", method, id)
	}
}

// callHook wraps a hook payload with context metadata and sends it to the
// subprocess. It sets currentCtx for the duration of the call so that
// extension-initiated notifications (ext/emit, ext/send_message) received
// during the blocking call can access the active context.
//
// When the subprocess is dead, callHook returns errExtensionDeadSilent
// without invoking the IPC layer. The first such call also emits a single
// engine_error so the user knows hooks are no longer firing; subsequent
// calls are silent so the death does not flood the UI with one error per
// hook per turn (turn_start/turn_end/tool_call/permission_request all
// fire many times per second).
func (h *Host) callHook(method string, ctx *Context, payload interface{}) (json.RawMessage, error) {
	if h.dead.Load() {
		if h.deathReported.CompareAndSwap(false, true) {
			if ctx != nil && ctx.Emit != nil {
				name := h.name
				if name == "" {
					name = "(unknown)"
				}
				ctx.Emit(types.EngineEvent{
					Type:         "engine_error",
					EventMessage: fmt.Sprintf("extension %s subprocess died — hooks disabled until restart", name),
					ErrorCode:    "extension_died",
				})
			}
		}
		return nil, errExtensionDeadSilent
	}
	wrapped := map[string]interface{}{
		"_ctx": map[string]interface{}{
			"cwd": ctx.Cwd,
		},
	}
	if ctx.SessionKey != "" {
		wrapped["_ctx"].(map[string]interface{})["sessionKey"] = ctx.SessionKey
	}
	if ctx.Model != nil {
		wrapped["_ctx"].(map[string]interface{})["model"] = map[string]interface{}{
			"id":            ctx.Model.ID,
			"contextWindow": ctx.Model.ContextWindow,
		}
	}
	if ctx.Config != nil {
		// Populate ExtensionDir from this host's loaded config when the
		// session-wide ctx.Config does not have one. The session manager
		// builds a single ctx for all extensions on the session and cannot
		// know which host is being called, so the per-host fill-in happens
		// here. Without it, extension code reading ctx.config.extensionDir
		// gets an empty string and falls back to ESM-incompatible globals
		// like __filename.
		cfg := *ctx.Config
		if cfg.ExtensionDir == "" && h.loadedConfig != nil && h.loadedConfig.ExtensionDir != "" {
			cfg.ExtensionDir = h.loadedConfig.ExtensionDir
		}
		wrapped["_ctx"].(map[string]interface{})["config"] = cfg
	}

	// Merge hook-specific payload into the wrapped map.
	if m, ok := payload.(map[string]interface{}); ok {
		for k, v := range m {
			wrapped[k] = v
		}
	} else if payload != nil {
		payloadBytes, _ := json.Marshal(payload)
		var payloadMap map[string]interface{}
		if json.Unmarshal(payloadBytes, &payloadMap) == nil {
			for k, v := range payloadMap {
				wrapped[k] = v
			}
		} else {
			wrapped["_payload"] = payload
		}
	}

	h.currentCtx.Store(ctx)
	defer h.currentCtx.Store(nil)
	return h.call(method, wrapped)
}

// readLoop continuously reads JSON-RPC responses from subprocess stdout and
// dispatches them to the pending call channels. It runs until stdout closes
// or the host is disposed.
//
// The scanner is passed in by spawnAndInit rather than read from h.stdout to
// avoid a race with disposeInternal, which nils h.stdout under h.mu while
// this goroutine is still draining the underlying file descriptor.
func (h *Host) readLoop(stdout *bufio.Scanner) {
	defer h.readerWg.Done()

	defer func() {
		wasAlive := !h.dead.Load()
		if wasAlive {
			h.dead.Store(true)
			utils.Log("extension", fmt.Sprintf("subprocess stdout closed unexpectedly (ext=%s)", h.name))
		}
		// Signal dead BEFORE draining so callers racing the add-to-pending
		// step (between dead.Load() and pending[id]=ch) can observe death
		// via deadCh and bail out instead of waiting the full rpcCallTimeout.
		h.signalDead()
		// Drain all pending calls.
		h.pendMu.Lock()
		for id, ch := range h.pending {
			close(ch)
			delete(h.pending, id)
		}
		h.pendMu.Unlock()

		// Capture exit code/signal for downstream event payloads. Wait()
		// blocks until the process is fully reaped, so do this off the
		// reader goroutine if the subprocess is still finalizing.
		h.mu.Lock()
		hasCmd := h.cmd != nil
		h.mu.Unlock()
		if hasCmd && wasAlive {
			go h.captureExitStatus()
		}

		// Notify the session manager so it can schedule a respawn after
		// the active run finishes. Run in its own goroutine so the
		// callback can take its time without blocking shutdown paths.
		h.mu.Lock()
		fn := h.onDeath
		h.mu.Unlock()
		if fn != nil && wasAlive {
			go fn(h)
		}
	}()

	for stdout != nil && stdout.Scan() {
		line := stdout.Bytes()
		if len(line) == 0 {
			continue
		}

		// Check if this is an extension-initiated message (has method field).
		var probe struct {
			Method string `json:"method"`
			ID     *int64 `json:"id"`
		}
		if err := json.Unmarshal(line, &probe); err == nil && probe.Method != "" {
			if probe.ID != nil {
				// Extension-to-engine request (has id, expects response).
				h.handleExtRequest(probe.Method, *probe.ID, line)
			} else {
				// Notification (no id, fire-and-forget).
				h.handleExtNotification(probe.Method, line)
			}
			continue
		}

		var resp jsonrpcResponse
		if err := json.Unmarshal(line, &resp); err != nil {
			// Rate-limit parse-failure WARNs to one per second so a leaking
			// extension cannot bury the log. Capture the first 200 chars of
			// the offending line plus the extension name so the operator
			// has something actionable.
			now := time.Now().UnixNano()
			last := h.lastParseErrAt.Load()
			if now-last >= int64(time.Second) && h.lastParseErrAt.CompareAndSwap(last, now) {
				preview := string(line)
				if len(preview) > 200 {
					preview = preview[:200] + "...(truncated)"
				}
				utils.Warn("extension", fmt.Sprintf("non-JSON line from subprocess (ext=%s err=%v): %q", h.name, err, preview))
			}
			continue
		}

		h.pendMu.Lock()
		ch, ok := h.pending[resp.ID]
		if ok {
			delete(h.pending, resp.ID)
		}
		h.pendMu.Unlock()

		if ok {
			ch <- &resp
		} else {
			utils.Log("extension", fmt.Sprintf("unexpected response id=%d (no pending call)", resp.ID))
		}
	}
}

// --- Hook forwarders ---

// registerHookForwarders registers SDK hook handlers that forward events to
// the subprocess via JSON-RPC. Grouped by return-type semantics.
func (h *Host) registerHookForwarders() {
	// No-op hooks: fire and forget, ignore result.
	noOpHooks := []string{
		HookSessionStart, HookSessionEnd,
		HookTurnStart, HookTurnEnd,
		HookMessageStart, HookMessageEnd,
		HookToolStart, HookToolEnd,
		HookAgentStart, HookAgentEnd,
		HookSessionCompact, HookSessionFork, HookSessionBeforeSwitch,
		HookPermissionRequest, HookPermissionDenied,
		HookFileChanged,
		HookTaskCreated, HookTaskCompleted,
		HookElicitationResult,
		HookOnError,
		HookBeforeProviderRequest,
		HookUserBash,
		// Per-tool result hooks (no-op category -- fire to subprocess, ignore result)
		HookBashToolResult, HookReadToolResult, HookWriteToolResult,
		HookEditToolResult, HookGrepToolResult, HookGlobToolResult,
		HookAgentToolResult,
		// Extension lifecycle hooks (observational; engine fires after auto-respawn).
		HookExtensionRespawned, HookTurnAborted,
		HookPeerExtensionDied, HookPeerExtensionRespawned,
	}
	for _, hook := range noOpHooks {
		h.registerNoOpForwarder(hook)
	}

	// String-returning hooks: parse result.value, return if non-empty.
	stringHooks := []string{
		HookInput, HookModelSelect, HookContext,
		HookPlanModePrompt, HookContextInject,
		HookCapabilityDiscover, HookCapabilityMatch, HookCapabilityInvoke,
		HookPermissionClassify,
	}
	for _, hook := range stringHooks {
		h.registerStringForwarder(hook)
	}

	// Dedicated forwarders for hooks with structured results.
	h.registerBeforeAgentStartForwarder()
	h.registerBeforePromptForwarder()

	// Block-checking hooks: parse result.block and result.reason.
	h.registerBlockForwarder(HookToolCall)

	// Per-tool call hooks: parse result.block, result.reason, result.mutate.
	perToolCallHooks := []string{
		HookBashToolCall, HookReadToolCall, HookWriteToolCall,
		HookEditToolCall, HookGrepToolCall, HookGlobToolCall,
		HookAgentToolCall,
	}
	for _, hook := range perToolCallHooks {
		h.registerPerToolCallForwarder(hook)
	}

	// Boolean canceller hooks: parse result as bool.
	boolHooks := []string{
		HookSessionBeforeCompact, HookSessionBeforeFork, HookContextDiscover,
	}
	for _, hook := range boolHooks {
		h.registerBoolForwarder(hook)
	}

	// Rejection hooks: parse result.content and result.reject.
	rejectionHooks := []string{
		HookContextLoad, HookInstructionLoad,
	}
	for _, hook := range rejectionHooks {
		h.registerRejectionForwarder(hook)
	}

	// Content hooks: forward and return raw result.
	contentHooks := []string{
		HookMessageUpdate, HookToolResult, HookElicitationRequest,
	}
	for _, hook := range contentHooks {
		h.registerContentForwarder(hook)
	}
}

// emitHookError surfaces a hook failure to the client via engine_error event.
// errExtensionDeadSilent is suppressed so a dead subprocess produces only the
// single engine_error emitted from callHook on first death.
func emitHookError(ctx *Context, hook string, err error, stack string) {
	if errors.Is(err, errExtensionDeadSilent) {
		return
	}
	if ctx != nil && ctx.Emit != nil {
		msg := fmt.Sprintf("extension hook %s failed: %v", hook, err)
		if stack != "" {
			msg += "\n\n" + stack
		}
		ctx.Emit(types.EngineEvent{
			Type:         "engine_error",
			EventMessage: msg,
			ErrorCode:    "hook_failed",
		})
	}
}

// logHookErr writes a hook failure to engine.log. It silently drops the
// dead-subprocess sentinel so a crashed extension does not flood the log
// with one entry per hook fire (turn_start/turn_end/etc fire many times
// per second).
func logHookErr(hook string, err error) {
	if errors.Is(err, errExtensionDeadSilent) {
		return
	}
	utils.Warn("extension", fmt.Sprintf("hook %s error: %v", hook, err))
}

// emitHookEvents checks a hook response for an "events" array and emits
// each EngineEvent via ctx.Emit. Extensions can return side-effect events
// alongside their primary hook result.
func emitHookEvents(ctx *Context, raw json.RawMessage) {
	if len(raw) == 0 || ctx == nil || ctx.Emit == nil {
		return
	}
	var wrapper struct {
		Events []types.EngineEvent `json:"events"`
	}
	if err := json.Unmarshal(raw, &wrapper); err != nil {
		return
	}
	if len(wrapper.Events) > 0 {
		utils.Log("extension", fmt.Sprintf("emitHookEvents: %d events to emit", len(wrapper.Events)))
	}
	for _, ev := range wrapper.Events {
		if ev.Type != "" {
			utils.Log("extension", fmt.Sprintf("emitHookEvents: emitting %s", ev.Type))
			ctx.Emit(ev)
		}
	}
}

// registerNoOpForwarder registers a handler that forwards the hook to the
// subprocess and ignores any result.
func (h *Host) registerNoOpForwarder(hook string) {
	h.sdk.On(hook, func(ctx *Context, payload interface{}) (interface{}, error) {
		raw, err := h.callHook("hook/"+hook, ctx, payload)
		if err != nil {
			logHookErr(hook, err)
				var stack string
				if he, ok := err.(*hookError); ok {
					stack = he.Stack
				}
				emitHookError(ctx, hook, err, stack)
		}
		if len(raw) > 0 {
			n := len(raw); if n > 2000 { n = 2000 }
				utils.Log("extension", fmt.Sprintf("hook/%s raw response: %s", hook, string(raw[:n])))
		}
		emitHookEvents(ctx, raw)
		return nil, nil
	})
}

func min(a, b int) int {
	if a < b { return a }
	return b
}

// registerStringForwarder registers a handler that forwards the hook and
// returns the subprocess's result as a string. Accepts both the wrapped
// `{"value": "..."}` shape (used when the handler also emits events) and
// a bare JSON string return — the SDK only wraps when events accumulate.
func (h *Host) registerStringForwarder(hook string) {
	h.sdk.On(hook, func(ctx *Context, payload interface{}) (interface{}, error) {
		raw, err := h.callHook("hook/"+hook, ctx, payload)
		if err != nil {
			logHookErr(hook, err)
			var stack string
			if he, ok := err.(*hookError); ok {
				stack = he.Stack
			}
			emitHookError(ctx, hook, err, stack)
			return nil, nil
		}
		emitHookEvents(ctx, raw)
		if len(raw) == 0 || string(raw) == "null" {
			return nil, nil
		}
		// Try {value: "..."} first (handlers that also emit events).
		var wrapped struct {
			Value string `json:"value"`
		}
		if err := json.Unmarshal(raw, &wrapped); err == nil && wrapped.Value != "" {
			return wrapped.Value, nil
		}
		// Fall back to a bare JSON string — the SDK ships the handler's
		// return value as-is when no events accumulated.
		var bare string
		if err := json.Unmarshal(raw, &bare); err == nil && bare != "" {
			return bare, nil
		}
		return nil, nil
	})
}

// registerBeforeAgentStartForwarder registers a handler for before_agent_start
// that parses {"systemPrompt": "string"} and returns a BeforeAgentStartResult.
func (h *Host) registerBeforeAgentStartForwarder() {
	h.sdk.On(HookBeforeAgentStart, func(ctx *Context, payload interface{}) (interface{}, error) {
		raw, err := h.callHook("hook/"+HookBeforeAgentStart, ctx, payload)
		if err != nil {
			logHookErr(HookBeforeAgentStart, err)
			return nil, nil
		}
		emitHookEvents(ctx, raw)
		if len(raw) == 0 || string(raw) == "null" {
			return nil, nil
		}
		var result struct {
			SystemPrompt string `json:"systemPrompt"`
		}
		if err := json.Unmarshal(raw, &result); err != nil {
			utils.Log("extension", fmt.Sprintf("hook/%s: bad result: %v", HookBeforeAgentStart, err))
			return nil, nil
		}
		if result.SystemPrompt == "" {
			return nil, nil
		}
		return BeforeAgentStartResult{SystemPrompt: result.SystemPrompt}, nil
	})
}

// registerBeforePromptForwarder registers a handler for before_prompt that
// parses {"prompt": "string", "systemPrompt": "string", "value": "string"}.
// Supports all extension return shapes:
//   - {"value": "rewritten"}          -> plain string (backward compat)
//   - {"systemPrompt": "..."}         -> BeforePromptResult
//   - {"prompt": "...", "systemPrompt": "..."} -> BeforePromptResult with both
func (h *Host) registerBeforePromptForwarder() {
	h.sdk.On(HookBeforePrompt, func(ctx *Context, payload interface{}) (interface{}, error) {
		raw, err := h.callHook("hook/"+HookBeforePrompt, ctx, payload)
		if err != nil {
			logHookErr(HookBeforePrompt, err)
			return nil, nil
		}
		emitHookEvents(ctx, raw)
		if len(raw) == 0 || string(raw) == "null" {
			return nil, nil
		}
		var result struct {
			Value        string `json:"value"`
			Prompt       string `json:"prompt"`
			SystemPrompt string `json:"systemPrompt"`
		}
		if err := json.Unmarshal(raw, &result); err != nil {
			utils.Log("extension", fmt.Sprintf("hook/%s: bad result: %v", HookBeforePrompt, err))
			return nil, nil
		}
		// If systemPrompt is set, return structured result
		if result.SystemPrompt != "" || result.Prompt != "" {
			return BeforePromptResult{
				Prompt:       result.Prompt,
				SystemPrompt: result.SystemPrompt,
			}, nil
		}
		// Backward compat: plain string via value field
		if result.Value != "" {
			return result.Value, nil
		}
		return nil, nil
	})
}

// registerBlockForwarder registers a handler for tool_call that parses
// {"block": bool, "reason": "string"} and returns a *ToolCallResult.
func (h *Host) registerBlockForwarder(hook string) {
	h.sdk.On(hook, func(ctx *Context, payload interface{}) (interface{}, error) {
		raw, err := h.callHook("hook/"+hook, ctx, payload)
		if err != nil {
			logHookErr(hook, err)
				var stack string
				if he, ok := err.(*hookError); ok {
					stack = he.Stack
				}
				emitHookError(ctx, hook, err, stack)
			return nil, nil
		}
		emitHookEvents(ctx, raw)
		if len(raw) == 0 || string(raw) == "null" {
			return nil, nil
		}
		var result struct {
			Block  bool   `json:"block"`
			Reason string `json:"reason"`
		}
		if err := json.Unmarshal(raw, &result); err != nil {
			utils.Log("extension", fmt.Sprintf("hook/%s: bad result: %v", hook, err))
			return nil, nil
		}
		if !result.Block {
			return nil, nil
		}
		return &ToolCallResult{
			Block:  true,
			Reason: result.Reason,
		}, nil
	})
}

// registerPerToolCallForwarder registers a handler for per-tool call hooks
// that parses {"block": bool, "reason": "string", "mutate": {...}}.
func (h *Host) registerPerToolCallForwarder(hook string) {
	h.sdk.On(hook, func(ctx *Context, payload interface{}) (interface{}, error) {
		raw, err := h.callHook("hook/"+hook, ctx, payload)
		if err != nil {
			logHookErr(hook, err)
				var stack string
				if he, ok := err.(*hookError); ok {
					stack = he.Stack
				}
				emitHookError(ctx, hook, err, stack)
			return nil, nil
		}
		emitHookEvents(ctx, raw)
		if len(raw) == 0 || string(raw) == "null" {
			return nil, nil
		}
		var result struct {
			Block  bool                   `json:"block"`
			Reason string                 `json:"reason"`
			Mutate map[string]interface{} `json:"mutate"`
		}
		if err := json.Unmarshal(raw, &result); err != nil {
			utils.Log("extension", fmt.Sprintf("hook/%s: bad result: %v", hook, err))
			return nil, nil
		}
		if !result.Block && result.Mutate == nil {
			return nil, nil
		}
		return &PerToolCallResult{
			Block:  result.Block,
			Reason: result.Reason,
			Mutate: result.Mutate,
		}, nil
	})
}

// registerBoolForwarder registers a handler that parses the result as a bool.
// Returns true to cancel the operation.
func (h *Host) registerBoolForwarder(hook string) {
	h.sdk.On(hook, func(ctx *Context, payload interface{}) (interface{}, error) {
		raw, err := h.callHook("hook/"+hook, ctx, payload)
		if err != nil {
			logHookErr(hook, err)
				var stack string
				if he, ok := err.(*hookError); ok {
					stack = he.Stack
				}
				emitHookError(ctx, hook, err, stack)
			return nil, nil
		}
		emitHookEvents(ctx, raw)
		if len(raw) == 0 || string(raw) == "null" {
			return nil, nil
		}
		var cancel bool
		if err := json.Unmarshal(raw, &cancel); err != nil {
			utils.Log("extension", fmt.Sprintf("hook/%s: bad result: %v", hook, err))
			return nil, nil
		}
		if !cancel {
			return nil, nil
		}
		return true, nil
	})
}

// registerRejectionForwarder registers a handler for context_load and
// instruction_load that parses {"content": "string", "reject": bool}.
func (h *Host) registerRejectionForwarder(hook string) {
	h.sdk.On(hook, func(ctx *Context, payload interface{}) (interface{}, error) {
		raw, err := h.callHook("hook/"+hook, ctx, payload)
		if err != nil {
			logHookErr(hook, err)
				var stack string
				if he, ok := err.(*hookError); ok {
					stack = he.Stack
				}
				emitHookError(ctx, hook, err, stack)
			return nil, nil
		}
		emitHookEvents(ctx, raw)
		if len(raw) == 0 || string(raw) == "null" {
			return nil, nil
		}
		var result struct {
			Content string `json:"content"`
			Reject  bool   `json:"reject"`
		}
		if err := json.Unmarshal(raw, &result); err != nil {
			utils.Log("extension", fmt.Sprintf("hook/%s: bad result: %v", hook, err))
			return nil, nil
		}
		if result.Reject {
			return true, nil
		}
		if result.Content != "" {
			return result.Content, nil
		}
		return nil, nil
	})
}

// registerContentForwarder registers a handler that forwards the hook and
// returns the raw result as a map for content-type hooks.
func (h *Host) registerContentForwarder(hook string) {
	h.sdk.On(hook, func(ctx *Context, payload interface{}) (interface{}, error) {
		raw, err := h.callHook("hook/"+hook, ctx, payload)
		if err != nil {
			logHookErr(hook, err)
				var stack string
				if he, ok := err.(*hookError); ok {
					stack = he.Stack
				}
				emitHookError(ctx, hook, err, stack)
			return nil, nil
		}
		emitHookEvents(ctx, raw)
		if len(raw) == 0 || string(raw) == "null" {
			return nil, nil
		}
		var result map[string]interface{}
		if err := json.Unmarshal(raw, &result); err != nil {
			utils.Log("extension", fmt.Sprintf("hook/%s: bad result: %v", hook, err))
			return nil, nil
		}
		return result, nil
	})
}
