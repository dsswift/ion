package utils

import (
	"context"
	"runtime"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
)

// ambientCtxMap stores a context.Context per goroutine (keyed by goroutine ID).
// logAt reads from this map so utils.Log/Debug/Info/Warn/Error automatically
// pick up session_id/conversation_id/trace_id when the goroutine is executing
// inside a session run. Production code sets/clears via SetAmbientCtx/
// ClearAmbientCtx; tests may inspect via ambientCtxForGoroutine.
var ambientCtxMap sync.Map

// goroutineID returns the current goroutine's numeric ID, extracted from the
// first line of runtime.Stack output. This is deliberately the only use of
// goroutine IDs in the engine — it exists purely as a logging correlation
// mechanism and must never be used for synchronisation or identity decisions.
func goroutineID() uint64 {
	var buf [64]byte
	n := runtime.Stack(buf[:], false)
	// format: "goroutine 18 [running]:\n..."
	s := strings.TrimPrefix(string(buf[:n]), "goroutine ")
	idx := strings.IndexByte(s, ' ')
	if idx < 0 {
		return 0
	}
	id, _ := strconv.ParseUint(s[:idx], 10, 64) //nolint:errcheck // parse failure -> zero value, handled
	return id
}

// SetAmbientCtx installs ctx as the ambient logging context for the current
// goroutine. Every subsequent call to utils.Log/Debug/Info/Warn/Error on this
// goroutine will automatically stamp session_id, conversation_id, and trace_id
// from ctx (via context.WithValue). Call ClearAmbientCtx (typically deferred)
// when the goroutine exits the correlated scope.
//
// Intended call sites: the entry of long-lived goroutines that own a session
// run (e.g. ApiBackend.runLoop). Not for use in short goroutines that outlive
// their session scope.
func SetAmbientCtx(ctx context.Context) {
	ambientCtxMap.Store(goroutineID(), ctx)
}

// ClearAmbientCtx removes the ambient context for the current goroutine.
// Must be deferred after SetAmbientCtx to prevent the map from growing
// unboundedly.
func ClearAmbientCtx() {
	ambientCtxMap.Delete(goroutineID())
}

// ambientCorrelationIDs returns the session_id, conversation_id, and trace_id
// from the ambient context for the current goroutine, or all-empty if no
// ambient context is set. Called by logAtWithFields so the plain Log/Debug/
// Info/Warn/Error helpers pick up correlation without touching their signatures.
func ambientCorrelationIDs() (sessionID, conversationID, traceID string) {
	v, ok := ambientCtxMap.Load(goroutineID())
	if !ok {
		return "", "", ""
	}
	ctx, ok := v.(context.Context)
	if !ok {
		return "", "", ""
	}
	sessionID = SessionIDFromContext(ctx)
	conversationID = ConversationIDFromContext(ctx)
	traceID = TraceIDFromContext(ctx)
	return
}

// egressUserV holds the user-attribution identity stamped on outbound egress
// records (R20). It mirrors the telemetry SetUserIdentity seam and the
// desktop setEgressUser seam, but lives in utils because the egress forwarder
// lives here and internal/telemetry imports internal/utils (so utils cannot
// import telemetry back without an import cycle). Enterprise OIDC auth calls
// SetEgressUser after sign-in and SetEgressUser("") after sign-out. Empty by
// default on every open-source and default install, which produces the
// omit-when-empty behavior on the egressRecord.
var egressUserV atomic.Value

// SetEgressUser records the authenticated user identity so every subsequent
// egress record carries it in the top-level "user" field. Call with the
// resolved OIDC subject/email when enterprise auth succeeds, and with "" to
// clear it. Safe to call multiple times; last write wins. Thread-safe.
func SetEgressUser(identity string) {
	egressUserV.Store(identity)
}

// resolvedEgressUser returns the current egress user identity, or "" when not
// set. Read on the ship path so the stamp is always the latest value.
func resolvedEgressUser() string {
	if v, ok := egressUserV.Load().(string); ok {
		return v
	}
	return ""
}

// egressAuthProviderV holds the flush-time auth-header provider for the
// egress forwarder. Mirrors the desktop's AuthHeaderProvider seam
// (desktop/src/main/log-egress.ts): called at every flush so shipped
// batches always carry a fresh operator token. Injected from serve startup
// (a closure over the engine's identity manager minting the configured
// egressTokenScope) because utils cannot import internal/auth — auth
// imports utils, and the cycle is forbidden.
var egressAuthProviderV atomic.Value

// SetEgressAuthHeaderProvider installs the flush-time header provider.
// Pass nil-returning or empty-map providers freely; flush merges whatever
// is returned over the static EgressHeaders (provider wins on key
// collisions, so a freshly minted Authorization beats a stale static one).
func SetEgressAuthHeaderProvider(fn func() map[string]string) {
	egressAuthProviderV.Store(fn)
}

// resolvedEgressAuthHeaders returns the provider's current headers, or nil
// when no provider is installed.
func resolvedEgressAuthHeaders() map[string]string {
	if fn, ok := egressAuthProviderV.Load().(func() map[string]string); ok && fn != nil {
		return fn()
	}
	return nil
}
