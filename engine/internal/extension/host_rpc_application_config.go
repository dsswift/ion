// host_rpc_application_config.go — ext/get_application_config and
// ext/await_application_config: the scoped accessor extensions read the
// authenticated application config through.
//
// Every answer carries the lifecycle state beside the values, so a reader
// can tell "still loading" (deferred, fetching) from "the key does not
// exist" (ready, found=false). The view is scoped twice: to the reader's
// principal, so a session acting as another principal reads deferred; and
// to the extension's trusted allowlist identity, so an extension sees the
// common section plus its own and never another extension's. Secret values
// never leave the engine; a read of a secret key reports secret=true.
package extension

import (
	"context"
	"encoding/json"
	"errors"
	"time"

	"github.com/dsswift/ion/engine/internal/appconfig"
	"github.com/dsswift/ion/engine/internal/utils"
)

const (
	// applicationConfigAwaitDefault bounds an await that names no timeout.
	applicationConfigAwaitDefault = 30 * time.Second
	// applicationConfigAwaitMax caps an extension-supplied await timeout so
	// a forgotten waiter cannot hold a goroutine for the process lifetime.
	applicationConfigAwaitMax = 10 * time.Minute
)

// ApplicationConfigChangedInfo is the application_config_changed payload: a
// complete view scoped to the receiving session's principal and the
// receiving extension. Handlers replace their view with it.
type ApplicationConfigChangedInfo = appconfig.View

// ApplicationConfigRead answers ext/get_application_config and
// ext/await_application_config.
type ApplicationConfigRead struct {
	appconfig.View
	// Key echoes the requested key. When set, Values and SecretKeys are
	// omitted and the answer carries Found, Value, and Secret for that key
	// alone.
	Key   string `json:"key,omitempty"`
	Found bool   `json:"found"`
	Value any    `json:"value,omitempty"`
	// Secret reports that Key names a secret the engine holds for this
	// extension. Its value is never returned.
	Secret bool `json:"secret,omitempty"`
	// TimedOut is set by await when the view had not settled in time.
	TimedOut bool `json:"timedOut,omitempty"`
}

// readerSubject is the principal a request reads as: the invocation's
// identity when it carries one, otherwise the process view.
func readerSubject(ctx *Context) string {
	if ctx == nil || ctx.Identity == nil {
		return ""
	}
	return ctx.Identity.Subject
}

func applicationConfigAnswer(view appconfig.View, key string) ApplicationConfigRead {
	answer := ApplicationConfigRead{View: view, Key: key}
	if key != "" {
		answer.Value, answer.Found, answer.Secret = view.Lookup(key)
		answer.Values = nil
		answer.SecretKeys = nil
	}
	return answer
}

func (h *Host) rpcGetApplicationConfig(ctx *Context, id int64, raw []byte) {
	var req struct {
		Params struct {
			Key string `json:"key,omitempty"`
		} `json:"params"`
	}
	if err := json.Unmarshal(raw, &req); err != nil {
		h.sendResponse(id, nil, &jsonrpcError{Code: -32602, Message: "parse error: " + err.Error()})
		return
	}
	subject := readerSubject(ctx)
	trustedID := h.TrustedID()
	answer := applicationConfigAnswer(appconfig.Read(subject, trustedID), req.Params.Key)
	utils.LogWithFields(utils.LevelDebug, "extension", "ext/get_application_config answered", map[string]any{
		"extension": h.Name(), "trusted_id": trustedID, "subject": subject, "state": answer.State, "revision": answer.Revision,
		"key": answer.Key, "found": answer.Found, "secret": answer.Secret,
	})
	data, _ := json.Marshal(answer) //nolint:errcheck // marshal of a local RPC struct
	h.sendResponse(id, json.RawMessage(data), nil)
}

func (h *Host) rpcAwaitApplicationConfig(ctx *Context, id int64, raw []byte) {
	var req struct {
		Params struct {
			Key       string  `json:"key,omitempty"`
			TimeoutMs float64 `json:"timeoutMs,omitempty"`
		} `json:"params"`
	}
	if err := json.Unmarshal(raw, &req); err != nil {
		h.sendResponse(id, nil, &jsonrpcError{Code: -32602, Message: "parse error: " + err.Error()})
		return
	}
	timeout := applicationConfigAwaitDefault
	if req.Params.TimeoutMs > 0 {
		timeout = min(time.Duration(req.Params.TimeoutMs)*time.Millisecond, applicationConfigAwaitMax)
	}
	subject := readerSubject(ctx)
	trustedID := h.TrustedID()
	go func() {
		waitCtx, cancel := context.WithTimeout(context.Background(), timeout)
		defer cancel()
		view, err := appconfig.Await(waitCtx, subject, trustedID)
		answer := applicationConfigAnswer(view, req.Params.Key)
		answer.TimedOut = errors.Is(err, context.DeadlineExceeded)
		utils.LogWithFields(utils.LevelInfo, "extension", "ext/await_application_config answered", map[string]any{
			"extension": h.Name(), "trusted_id": trustedID, "subject": subject, "state": answer.State, "revision": answer.Revision, "timed_out": answer.TimedOut,
		})
		data, _ := json.Marshal(answer) //nolint:errcheck // marshal of a local RPC struct
		h.sendResponse(id, json.RawMessage(data), nil)
	}()
}

// FireApplicationConfigChanged delivers an application config snapshot to
// native handlers.
func (s *SDK) FireApplicationConfigChanged(ctx *Context, info ApplicationConfigChangedInfo) error {
	s.fire(HookApplicationConfigChanged, ctx, info)
	return nil
}

// FireApplicationConfigChanged forwards the hook to this host's handlers.
func (h *Host) FireApplicationConfigChanged(ctx *Context, info ApplicationConfigChangedInfo) error {
	return h.sdk.FireApplicationConfigChanged(ctx, info)
}
