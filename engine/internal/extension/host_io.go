package extension

import (
	"bufio"
	"encoding/json"
	"errors"
	"fmt"
	"time"

	"github.com/dsswift/ion/engine/internal/types"
	"github.com/dsswift/ion/engine/internal/utils"
)

// errExtensionDeadSilent is used to suppress repeated error events from a
// dead extension subprocess. callHook returns this sentinel after the first
// engine_error has been emitted.
var errExtensionDeadSilent = errors.New("extension subprocess is dead (silenced)")

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
