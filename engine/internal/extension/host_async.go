// Async-trigger plumbing on the Host. Maintains the per-host asyncreg
// Registry, a captured session key so the engine can resolve "which
// session does this async fire belong to?", and a small map of named
// callbacks (TokenRefName, EnabledRefName) the engine invokes when it
// needs the extension to resolve a value lazily at fire time.
//
// The Registry is created lazily on first use via asyncRegistry().
// Hosts that never register a webhook or schedule pay no extra memory.

package extension

import (
	"fmt"
	"sync"

	"github.com/dsswift/ion/engine/internal/asyncreg"
	"github.com/dsswift/ion/engine/internal/utils"
)

// asyncHostState carries the host's async-trigger plumbing. Held under
// host.asyncMu (a separate mutex from host.mu) so RPC handlers can
// register / deregister concurrently with the host's main lifecycle
// without lock-order concerns.
type asyncHostState struct {
	mu sync.Mutex

	// registry is the per-host async-trigger registry. Lazily
	// allocated on first asyncRegistry() call.
	registry *asyncreg.Registry

	// sessionKey is the engine session this host is bound to. Captured
	// by the session manager via SetSessionKey at load time. Used by
	// the async-fire path to resolve the session at fire time without
	// the registry needing a back-reference to the manager.
	sessionKey string

	// fireAsync is the host-side dispatcher for an `engine/fire_async`
	// RPC into the subprocess. Set by the webhook server / scheduler
	// indirectly through the session manager so the host doesn't need
	// to know about HTTP or scheduling concretely.
	//
	// Signature returns the marshaled response payload from the
	// subprocess (or nil for void handlers) and an error.
	//
	// Held under asyncMu so a concurrent ext/register_webhook RPC and
	// a fire-in-flight don't race on the slot.

	// onLifecycleHook fires the SDK lifecycle hook (webhook_registered
	// etc.) with an extension Context the session manager constructs.
	// Held here so the registry's veto pipeline can call back without
	// the host carrying a direct dependency on Manager / extcontext.
	onLifecycleHook func(event string, info AsyncRegistrationInfo) error
}

// asyncMu is a separate mutex from host.mu so registry mutations don't
// block on the main host lifecycle lock. (host.mu wraps Load / Respawn,
// which can take seconds.)
//
// Declared as a field on Host itself in host.go would force editing the
// allowlisted god file. Stored here as a *asyncHostState pointer on the
// host instead — see host_async_state.go for the accessor.
//
// (Kept in this file as documentation. The actual field lives on Host
// via the asyncHostState pointer below.)

// asyncRegistry returns the host's per-host async-trigger registry,
// lazily allocating it on first use. Safe for concurrent use.
func (h *Host) asyncRegistry() *asyncreg.Registry {
	h.asyncOnce.Do(func() {
		h.async = &asyncHostState{
			registry: asyncreg.New(0), // default cap
		}
	})
	h.async.mu.Lock()
	defer h.async.mu.Unlock()
	if h.async.registry == nil {
		h.async.registry = asyncreg.New(0)
	}
	return h.async.registry
}

// AsyncRegistry returns the host's per-host registry. Exposed for the
// session wiring layer (webhook server, scheduler) so it can List the
// current declarations and Subscribe to change notifications.
func (h *Host) AsyncRegistry() *asyncreg.Registry {
	return h.asyncRegistry()
}

// SetSessionKey records the engine session this host is bound to.
// Called by the session manager once per Load (and again on Respawn so
// the captured key carries over). The async-fire path reads this back
// via SessionKey() to look up the session at fire time.
func (h *Host) SetSessionKey(key string) {
	h.asyncOnce.Do(func() { h.async = &asyncHostState{} })
	h.async.mu.Lock()
	defer h.async.mu.Unlock()
	h.async.sessionKey = key
	utils.Debug("extension", fmt.Sprintf("Host.SetSessionKey: ext=%s key=%s", h.name, key))
}

// SessionKey returns the engine session key this host is bound to, or
// "" when no session has been captured (e.g. during init handshake
// before the manager has called SetSessionKey).
func (h *Host) SessionKey() string {
	if h.async == nil {
		return ""
	}
	h.async.mu.Lock()
	defer h.async.mu.Unlock()
	return h.async.sessionKey
}

// SetOnLifecycleHook wires the callback that fires the async-trigger
// lifecycle hooks (webhook_registered etc.). The session manager
// installs this with a closure that:
//   1. Builds an async ctx for this host's session.
//   2. Calls the SDK's FireXxx wrapper, which iterates every
//      extension's registered hook handlers and resolves the veto.
//   3. Returns the resolved error (nil = allow, non-nil = block).
//
// The registry calls back through this to wire its veto pipeline. Nil
// is allowed and disables lifecycle hooks for this host (only useful
// in tests).
func (h *Host) SetOnLifecycleHook(fn func(event string, info AsyncRegistrationInfo) error) {
	h.asyncOnce.Do(func() { h.async = &asyncHostState{} })
	h.async.mu.Lock()
	defer h.async.mu.Unlock()
	h.async.onLifecycleHook = fn
}

// fireLifecycleHook invokes the wired lifecycle-hook callback if any.
// Returns nil when no callback is wired, so a registry registration
// from a test or unconfigured host always succeeds.
func (h *Host) fireLifecycleHook(event string, info AsyncRegistrationInfo) error {
	if h.async == nil {
		return nil
	}
	h.async.mu.Lock()
	fn := h.async.onLifecycleHook
	h.async.mu.Unlock()
	if fn == nil {
		return nil
	}
	return fn(event, info)
}

// RegisterWebhookDecl wraps asyncreg.Registry.Register for a webhook
// route. Validates the declaration up front, fires the
// webhook_registered hook (veto-capable), and on success records the
// route in the registry. Returns ErrCapExceeded / ErrDuplicate /
// validation errors so the caller (host_rpc) can surface a structured
// reason.
//
// Origin discriminates init-time bulk registration from runtime RPC
// add for the lifecycle event payload.
func (h *Host) RegisterWebhookDecl(route WebhookRoute, origin asyncreg.Origin) error {
	if err := route.Auth.Validate(); err != nil {
		return fmt.Errorf("webhook %s: %w", route.Path, err)
	}
	if route.Path == "" || route.Path[0] != '/' {
		return fmt.Errorf("webhook path must start with '/', got %q", route.Path)
	}
	veto := func(_ asyncreg.Kind, decl asyncreg.Declaration, o asyncreg.Origin) error {
		info := AsyncRegistrationInfo{
			Kind:   string(asyncreg.KindWebhook),
			ID:     decl.ID(),
			Origin: string(o),
			Decl:   decl,
		}
		return h.fireLifecycleHook(HookWebhookRegistered, info)
	}
	return h.asyncRegistry().Register(asyncreg.KindWebhook, route, origin, veto)
}

// DeregisterWebhookDecl removes a route from the registry and fires
// the webhook_deregistered observability hook. Returns true if the
// route was present and removed.
func (h *Host) DeregisterWebhookDecl(path string) bool {
	notify := func(_ asyncreg.Kind, decl asyncreg.Declaration, o asyncreg.Origin) {
		info := AsyncRegistrationInfo{
			Kind:   string(asyncreg.KindWebhook),
			ID:     decl.ID(),
			Origin: string(o),
			Decl:   decl,
		}
		// Deregistration is observation-only; ignore the error.
		_ = h.fireLifecycleHook(HookWebhookDeregistered, info)
	}
	return h.asyncRegistry().Deregister(asyncreg.KindWebhook, path, notify)
}

// RegisterScheduleDecl wraps asyncreg.Registry.Register for a schedule
// job. Validates the declaration up front, fires schedule_registered
// (veto-capable), and on success records the job in the registry.
func (h *Host) RegisterScheduleDecl(job ScheduleJob, origin asyncreg.Origin) error {
	if err := job.Validate(); err != nil {
		return err
	}
	veto := func(_ asyncreg.Kind, decl asyncreg.Declaration, o asyncreg.Origin) error {
		info := AsyncRegistrationInfo{
			Kind:   string(asyncreg.KindSchedule),
			ID:     decl.ID(),
			Origin: string(o),
			Decl:   decl,
		}
		return h.fireLifecycleHook(HookScheduleRegistered, info)
	}
	return h.asyncRegistry().Register(asyncreg.KindSchedule, job, origin, veto)
}

// DeregisterScheduleDecl removes a job from the registry and fires
// the schedule_deregistered observability hook. Returns true if the
// job was present and removed.
func (h *Host) DeregisterScheduleDecl(id string) bool {
	notify := func(_ asyncreg.Kind, decl asyncreg.Declaration, o asyncreg.Origin) {
		info := AsyncRegistrationInfo{
			Kind:   string(asyncreg.KindSchedule),
			ID:     decl.ID(),
			Origin: string(o),
			Decl:   decl,
		}
		_ = h.fireLifecycleHook(HookScheduleDeregistered, info)
	}
	return h.asyncRegistry().Deregister(asyncreg.KindSchedule, id, notify)
}

// Webhooks returns a snapshot of currently-registered webhook routes
// for this host. Used by the session wiring layer to enumerate the
// initial set after init handshake completes.
func (h *Host) Webhooks() []WebhookRoute {
	if h.async == nil {
		return nil
	}
	decls := h.asyncRegistry().List(asyncreg.KindWebhook)
	out := make([]WebhookRoute, 0, len(decls))
	for _, d := range decls {
		if r, ok := d.(WebhookRoute); ok {
			out = append(out, r)
		}
	}
	return out
}

// Schedules returns a snapshot of currently-registered schedule jobs
// for this host.
func (h *Host) Schedules() []ScheduleJob {
	if h.async == nil {
		return nil
	}
	decls := h.asyncRegistry().List(asyncreg.KindSchedule)
	out := make([]ScheduleJob, 0, len(decls))
	for _, d := range decls {
		if j, ok := d.(ScheduleJob); ok {
			out = append(out, j)
		}
	}
	return out
}

// ResetAsyncRegistrations wipes every webhook and schedule entry on
// the host's registry, firing the *_deregistered hooks for each one
// (informationally — operators see the cleared state in the log).
// Called by the session manager before re-committing a respawned
// subprocess's init payload.
//
// Returns the total count of removed entries across both kinds.
func (h *Host) ResetAsyncRegistrations() int {
	if h.async == nil {
		return 0
	}
	reg := h.asyncRegistry()
	notifyWebhook := func(_ asyncreg.Kind, decl asyncreg.Declaration, o asyncreg.Origin) {
		info := AsyncRegistrationInfo{
			Kind:   string(asyncreg.KindWebhook),
			ID:     decl.ID(),
			Origin: string(o),
			Decl:   decl,
		}
		_ = h.fireLifecycleHook(HookWebhookDeregistered, info)
	}
	notifySchedule := func(_ asyncreg.Kind, decl asyncreg.Declaration, o asyncreg.Origin) {
		info := AsyncRegistrationInfo{
			Kind:   string(asyncreg.KindSchedule),
			ID:     decl.ID(),
			Origin: string(o),
			Decl:   decl,
		}
		_ = h.fireLifecycleHook(HookScheduleDeregistered, info)
	}
	w := reg.Reset(asyncreg.KindWebhook, notifyWebhook)
	s := reg.Reset(asyncreg.KindSchedule, notifySchedule)
	utils.Log("extension", fmt.Sprintf("ResetAsyncRegistrations: ext=%s webhooks=%d schedules=%d", h.name, w, s))
	return w + s
}

// CommitPendingAsyncDecls walks the declarations stashed during the
// last init handshake (parseInitResult) and routes them through the
// registry so the lifecycle hooks fire and the entries appear in
// Webhooks() / Schedules() snapshots.
//
// Must be called *after* the session manager wires SetOnLifecycleHook,
// otherwise init-time veto handlers would not run.
//
// Returns a slice of errors — one per failed registration. Init-time
// errors (validation, veto) are surfaced so the session wiring layer
// can decide whether to abort the host load or just log and continue.
// The current policy: collect all errors and let the caller log them;
// individual registration failures do not abort the host load (matches
// the RegisterRequiredHooks tolerance pattern). The session manager
// emits an engine_error per failure so the operator sees them.
func (h *Host) CommitPendingAsyncDecls() []error {
	if h.async == nil {
		return nil
	}
	h.async.mu.Lock()
	webhooks := h.pendingInitWebhooks
	schedules := h.pendingInitSchedules
	h.pendingInitWebhooks = nil
	h.pendingInitSchedules = nil
	h.async.mu.Unlock()

	if len(webhooks) == 0 && len(schedules) == 0 {
		return nil
	}

	var errs []error
	for _, w := range webhooks {
		if err := h.RegisterWebhookDecl(w, asyncreg.OriginInit); err != nil {
			utils.Log("extension", fmt.Sprintf("CommitPendingAsyncDecls: webhook %s rejected: %v", w.Path, err))
			errs = append(errs, fmt.Errorf("webhook %s: %w", w.Path, err))
			continue
		}
	}
	for _, j := range schedules {
		if err := h.RegisterScheduleDecl(j, asyncreg.OriginInit); err != nil {
			utils.Log("extension", fmt.Sprintf("CommitPendingAsyncDecls: schedule %s rejected: %v", j.JobID, err))
			errs = append(errs, fmt.Errorf("schedule %s: %w", j.JobID, err))
			continue
		}
	}
	utils.Log("extension", fmt.Sprintf("CommitPendingAsyncDecls: ext=%s committed webhooks=%d schedules=%d errors=%d",
		h.name, len(webhooks), len(schedules), len(errs)))
	return errs
}
