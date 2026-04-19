package extension

import (
	"bufio"
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"sync"
	"sync/atomic"
	"time"

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

	// Temp files created by TS transpilation, cleaned up on Dispose.
	tempFiles []string
}

// NewHost creates a new extension host with an empty SDK.
func NewHost() *Host {
	h := &Host{
		sdk:     NewSDK(),
		pending: make(map[int64]chan *jsonrpcResponse),
	}
	// Start IDs at 1 (0 is reserved/unused).
	h.nextID.Store(1)
	return h
}

// SDK returns the underlying hook registry for direct registration.
func (h *Host) SDK() *SDK {
	return h.sdk
}

// Load starts a subprocess extension. The extension binary is expected at
// extensionDir/main (or extensionDir/index.js for Node-based extensions).
// The subprocess communicates via JSON-RPC 2.0 over stdin/stdout.
func (h *Host) Load(extensionDir string, config *ExtensionConfig) error {
	h.mu.Lock()
	defer h.mu.Unlock()

	// Look for an executable in the extension directory.
	// Priority: main (binary) > index.ts (TypeScript) > index.js (Node)
	binPath := extensionDir + "/main"
	if _, err := os.Stat(binPath); os.IsNotExist(err) {
		// Try TypeScript extension (transpile via esbuild)
		tsPath := extensionDir + "/index.ts"
		if _, err := os.Stat(tsPath); err == nil {
			jsPath, transpileErr := h.transpileTS(tsPath)
			if transpileErr != nil {
				return fmt.Errorf("typescript extension found but transpile failed: %w", transpileErr)
			}
			h.tempFiles = append(h.tempFiles, jsPath)
			binPath = jsPath
		} else {
			// Try node-based extension
			binPath = extensionDir + "/index.js"
			if _, err := os.Stat(binPath); os.IsNotExist(err) {
				return fmt.Errorf("no executable found in extension dir: %s", extensionDir)
			}
		}
	}

	var cmd *exec.Cmd
	if filepath.Ext(binPath) == ".js" {
		cmd = exec.Command("node", binPath)
	} else {
		cmd = exec.Command(binPath)
	}
	cmd.Dir = extensionDir
	cmd.Stderr = os.Stderr

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

	h.cmd = cmd
	h.process = cmd.Process
	h.stdin = stdin
	h.stdout = bufio.NewScanner(stdout)
	h.dead.Store(false)

	// Start the background response reader before sending init so we can
	// receive the init response through the normal call path.
	h.readerWg.Add(1)
	go h.readLoop()

	// Send init and wait for response
	initResult, err := h.call("init", config)
	if err != nil {
		h.disposeInternal()
		return fmt.Errorf("init handshake: %w", err)
	}

	// Parse init response to register tools and commands
	h.parseInitResult(initResult)

	// Register hook handlers that forward events to the subprocess
	h.registerHookForwarders()

	utils.Log("extension", fmt.Sprintf("loaded extension from %s (pid %d)", extensionDir, cmd.Process.Pid))
	return nil
}

// Dispose shuts down the subprocess extension gracefully.
func (h *Host) Dispose() {
	h.mu.Lock()
	defer h.mu.Unlock()
	h.disposeInternal()
}

// disposeInternal shuts down without acquiring mu (caller must hold it).
func (h *Host) disposeInternal() {
	// Mark dead so the reader goroutine stops and pending calls fail fast.
	h.dead.Store(true)

	// Drain all pending calls with an error.
	h.pendMu.Lock()
	for id, ch := range h.pending {
		close(ch)
		delete(h.pending, id)
	}
	h.pendMu.Unlock()

	if h.stdin != nil {
		h.stdin.Close()
		h.stdin = nil
	}
	if h.process != nil {
		h.process.Kill()
		h.process = nil
	}
	if h.cmd != nil {
		h.cmd.Wait()
		h.cmd = nil
	}
	h.stdout = nil

	// Clean up transpiled temp files.
	for _, f := range h.tempFiles {
		os.Remove(f)
	}
	h.tempFiles = nil

	// Wait for the reader goroutine to exit.
	h.readerWg.Wait()
}

// transpileTS bundles a TypeScript file to JavaScript using the esbuild CLI.
// Returns the path to the bundled .js file in a temp directory.
func (h *Host) transpileTS(tsPath string) (string, error) {
	tmpDir := filepath.Join(os.TempDir(), "ion-ext-ts")
	if err := os.MkdirAll(tmpDir, 0755); err != nil {
		return "", fmt.Errorf("create temp dir: %w", err)
	}
	outPath := filepath.Join(tmpDir, fmt.Sprintf("ext-%d.js", time.Now().UnixNano()))

	cmd := exec.Command("esbuild", tsPath,
		"--bundle",
		"--format=cjs",
		"--target=node18",
		"--platform=node",
		"--outfile="+outPath,
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
	)
	var stderr bytes.Buffer
	cmd.Stderr = &stderr

	if err := cmd.Run(); err != nil {
		return "", fmt.Errorf("esbuild failed: %w\n%s\n(install with: npm i -g esbuild)", err, stderr.String())
	}

	utils.Log("extension", fmt.Sprintf("transpiled %s -> %s", tsPath, outPath))
	return outPath, nil
}

// parseInitResult extracts tools and commands from the subprocess init response
// and registers them on the SDK.
func (h *Host) parseInitResult(raw json.RawMessage) {
	if len(raw) == 0 || string(raw) == "null" {
		return
	}

	var result struct {
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

	for _, t := range result.Tools {
		toolName := t.Name // capture for closure
		h.sdk.RegisterTool(ToolDefinition{
			Name:        t.Name,
			Description: t.Description,
			Parameters:  t.Parameters,
			Execute: func(params interface{}, ctx *Context) (*types.ToolResult, error) {
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

func (h *Host) FireBeforePrompt(ctx *Context, prompt string) (string, string, error) {
	return h.sdk.FireBeforePrompt(ctx, prompt)
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
	Code    int    `json:"code"`
	Message string `json:"message"`
}

func (e *jsonrpcError) Error() string {
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
	if h.dead.Load() {
		return nil, fmt.Errorf("extension subprocess is dead")
	}

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
			return nil, resp.Error
		}
		return resp.Result, nil
	case <-time.After(rpcCallTimeout):
		h.pendMu.Lock()
		delete(h.pending, id)
		h.pendMu.Unlock()
		return nil, fmt.Errorf("timeout waiting for %s response (id=%d)", method, id)
	}
}

// readLoop continuously reads JSON-RPC responses from subprocess stdout and
// dispatches them to the pending call channels. It runs until stdout closes
// or the host is disposed.
func (h *Host) readLoop() {
	defer h.readerWg.Done()
	defer func() {
		if !h.dead.Load() {
			h.dead.Store(true)
			utils.Log("extension", "subprocess stdout closed unexpectedly")
		}
		// Drain all pending calls.
		h.pendMu.Lock()
		for id, ch := range h.pending {
			close(ch)
			delete(h.pending, id)
		}
		h.pendMu.Unlock()
	}()

	for h.stdout != nil && h.stdout.Scan() {
		line := h.stdout.Bytes()
		if len(line) == 0 {
			continue
		}

		var resp jsonrpcResponse
		if err := json.Unmarshal(line, &resp); err != nil {
			utils.Log("extension", fmt.Sprintf("malformed response from subprocess: %v", err))
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
		HookBeforeAgentStart,
		HookBeforeProviderRequest,
		HookUserBash,
		// Per-tool result hooks (no-op category -- fire to subprocess, ignore result)
		HookBashToolResult, HookReadToolResult, HookWriteToolResult,
		HookEditToolResult, HookGrepToolResult, HookGlobToolResult,
		HookAgentToolResult,
	}
	for _, hook := range noOpHooks {
		h.registerNoOpForwarder(hook)
	}

	// String-returning hooks: parse result.value, return if non-empty.
	stringHooks := []string{
		HookBeforePrompt, HookInput, HookModelSelect, HookContext,
	}
	for _, hook := range stringHooks {
		h.registerStringForwarder(hook)
	}

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

// registerNoOpForwarder registers a handler that forwards the hook to the
// subprocess and ignores any result.
func (h *Host) registerNoOpForwarder(hook string) {
	h.sdk.On(hook, func(_ *Context, payload interface{}) (interface{}, error) {
		_, err := h.call("hook/"+hook, payload)
		if err != nil {
			utils.Log("extension", fmt.Sprintf("hook/%s call failed: %v", hook, err))
		}
		return nil, nil
	})
}

// registerStringForwarder registers a handler that forwards the hook and
// parses the result as {"value": "string"}. Returns the string if present.
func (h *Host) registerStringForwarder(hook string) {
	h.sdk.On(hook, func(_ *Context, payload interface{}) (interface{}, error) {
		raw, err := h.call("hook/"+hook, payload)
		if err != nil {
			utils.Log("extension", fmt.Sprintf("hook/%s call failed: %v", hook, err))
			return nil, nil
		}
		if len(raw) == 0 || string(raw) == "null" {
			return nil, nil
		}
		var result struct {
			Value string `json:"value"`
		}
		if err := json.Unmarshal(raw, &result); err != nil {
			utils.Log("extension", fmt.Sprintf("hook/%s: bad result: %v", hook, err))
			return nil, nil
		}
		if result.Value == "" {
			return nil, nil
		}
		return result.Value, nil
	})
}

// registerBlockForwarder registers a handler for tool_call that parses
// {"block": bool, "reason": "string"} and returns a *ToolCallResult.
func (h *Host) registerBlockForwarder(hook string) {
	h.sdk.On(hook, func(_ *Context, payload interface{}) (interface{}, error) {
		raw, err := h.call("hook/"+hook, payload)
		if err != nil {
			utils.Log("extension", fmt.Sprintf("hook/%s call failed: %v", hook, err))
			return nil, nil
		}
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
	h.sdk.On(hook, func(_ *Context, payload interface{}) (interface{}, error) {
		raw, err := h.call("hook/"+hook, payload)
		if err != nil {
			utils.Log("extension", fmt.Sprintf("hook/%s call failed: %v", hook, err))
			return nil, nil
		}
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
	h.sdk.On(hook, func(_ *Context, payload interface{}) (interface{}, error) {
		raw, err := h.call("hook/"+hook, payload)
		if err != nil {
			utils.Log("extension", fmt.Sprintf("hook/%s call failed: %v", hook, err))
			return nil, nil
		}
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
	h.sdk.On(hook, func(_ *Context, payload interface{}) (interface{}, error) {
		raw, err := h.call("hook/"+hook, payload)
		if err != nil {
			utils.Log("extension", fmt.Sprintf("hook/%s call failed: %v", hook, err))
			return nil, nil
		}
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
	h.sdk.On(hook, func(_ *Context, payload interface{}) (interface{}, error) {
		raw, err := h.call("hook/"+hook, payload)
		if err != nil {
			utils.Log("extension", fmt.Sprintf("hook/%s call failed: %v", hook, err))
			return nil, nil
		}
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
