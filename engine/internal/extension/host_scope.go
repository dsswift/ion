// Host scope: which half of an extension a host is. A session host belongs to
// one conversation; an engine host belongs to the engine process. The manifest
// scope of the extension decides which registrations each half may make
// (see docs/extensions/extension-json.md). Both values live on the host's
// async binding state because they are binding plumbing, like the session key.

package extension

import (
	"errors"
	"fmt"

	"github.com/dsswift/ion/engine/internal/asyncreg"
	"github.com/dsswift/ion/engine/internal/utils"
)

// HostScope is the role a host plays for its extension.
type HostScope string

const (
	// HostScopeSession is a per-conversation host.
	HostScopeSession HostScope = "session"
	// HostScopeEngine is the engine-scoped host.
	HostScopeEngine HostScope = "engine"
)

// ErrScopeMismatch rejects a registration the host's scope does not allow:
// a schedule or webhook from the session half of an engine-scoped extension,
// or a tool, command, or session hook from an engine host.
var ErrScopeMismatch = errors.New("scope_mismatch")

// engineHostHooks are the hooks an engine host may declare. Everything else a
// session fires (session_start, tool_start, turn_end, ...) never reaches an
// engine host, so a declaration there is inert and dropped at init.
var engineHostHooks = map[string]struct{}{
	HookIdentityChanged:        {},
	HookWebhookRegistered:      {},
	HookWebhookDeregistered:    {},
	HookScheduleRegistered:     {},
	HookScheduleDeregistered:   {},
	HookScheduleMissed:         {},
	HookDispatchLost:           {},
	HookExtensionRespawned:     {},
	HookPeerExtensionDied:      {},
	HookPeerExtensionRespawned: {},
}

// SetScope records the host's role and the extension's manifest scope. Called
// by the loader before Load so the init handshake and every registration path
// see the final values.
func (h *Host) SetScope(role HostScope, manifest ManifestScope) {
	if role == "" {
		role = HostScopeSession
	}
	if manifest == "" {
		manifest = ManifestScopeSession
	}
	h.asyncOnce.Do(func() { h.async = &asyncHostState{} })
	h.async.mu.Lock()
	defer h.async.mu.Unlock()
	h.async.scope = role
	h.async.manifestScope = manifest
	utils.LogWithFields(utils.LevelDebug, "extension", "host.setscope", map[string]any{"model": h.name_(), "scope": role, "manifest_scope": manifest})
}

// Scope returns the host's role. A host never given one is a session host.
func (h *Host) Scope() HostScope {
	if h.async == nil {
		return HostScopeSession
	}
	h.async.mu.Lock()
	defer h.async.mu.Unlock()
	if h.async.scope == "" {
		return HostScopeSession
	}
	return h.async.scope
}

// ManifestScope returns the extension's declared scope as the loader saw it.
func (h *Host) ManifestScope() ManifestScope {
	if h.async == nil {
		return ManifestScopeSession
	}
	h.async.mu.Lock()
	defer h.async.mu.Unlock()
	if h.async.manifestScope == "" {
		return ManifestScopeSession
	}
	return h.async.manifestScope
}

// IsEngineHost reports whether this host is the engine-scoped half.
func (h *Host) IsEngineHost() bool { return h.Scope() == HostScopeEngine }

// checkAsyncScope refuses an init-time schedule or webhook declaration on a
// session host whose extension also has an engine host: a declaration made
// at module scope without branching on the process scope is one the author
// meant for the engine host, and accepting it would bind a copy to every
// conversation. A registration made at runtime, from a hook, is per-session
// by nature (a one-shot armed for this conversation) and is accepted on any
// host. A plain session-scoped extension keeps today's behavior throughout.
func (h *Host) checkAsyncScope(kind, id string, origin asyncreg.Origin) error {
	role, manifest := h.Scope(), h.ManifestScope()
	if role == HostScopeSession && manifest != ManifestScopeSession && origin == asyncreg.OriginInit {
		utils.LogWithFields(utils.LevelWarn, "extension", "async registration refused: scope mismatch", map[string]any{
			"model": h.name_(), "scope": role, "manifest_scope": manifest, "kind": kind, "id": id, "origin": origin,
		})
		return fmt.Errorf("%w: init-time %s %q belongs on the engine host of a %s-scoped extension", ErrScopeMismatch, kind, id, manifest)
	}
	return nil
}

// filterEngineHostInit drops the session-only declarations an engine host made
// at init. Tools and commands are offered to conversations only, and session
// hooks never fire on an engine host, so each one is logged and discarded
// rather than registered where nothing would ever call it.
func (h *Host) filterEngineHostInit(tools []toolRegistryTool, commands map[string]struct {
	Description string `json:"description"`
}, hooks []string) ([]toolRegistryTool, map[string]struct {
	Description string `json:"description"`
}, []string) {
	if !h.IsEngineHost() {
		return tools, commands, hooks
	}
	for _, tool := range tools {
		utils.LogWithFields(utils.LevelWarn, "extension", "engine host registration dropped: scope mismatch", map[string]any{"model": h.name_(), "kind": "tool", "id": tool.Name})
	}
	for name := range commands {
		utils.LogWithFields(utils.LevelWarn, "extension", "engine host registration dropped: scope mismatch", map[string]any{"model": h.name_(), "kind": "command", "id": name})
	}
	kept := make([]string, 0, len(hooks))
	for _, hook := range hooks {
		if _, ok := engineHostHooks[hook]; ok {
			kept = append(kept, hook)
			continue
		}
		utils.LogWithFields(utils.LevelWarn, "extension", "engine host registration dropped: scope mismatch", map[string]any{"model": h.name_(), "kind": "hook", "id": hook})
	}
	return nil, nil, kept
}
