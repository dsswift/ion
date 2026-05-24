// Package session: command-registry snapshot emission.
//
// The engine publishes the current set of extension-registered slash
// commands so consumers can route slash text without round-tripping every
// lookup through the engine. Two consumer concerns drive the design:
//
//  1. Routing precedence: extension commands take precedence over any
//     consumer-side template store (e.g. filesystem `.md` files). Consumers
//     need an authoritative list of names the extensions own so they can
//     short-circuit their local lookup for those names.
//  2. Live mutability: SDK.RegisterCommand is callable from any goroutine,
//     including from inside hook handlers that fire mid-session. Consumers
//     cannot rely on a one-shot publish at session_start; they need an
//     event every time the table changes.
//
// The wire shape follows the same SNAPSHOT semantics documented for
// engine_agent_state in docs/engine-grounding.md §4: every event carries the
// full current command set, consumers REPLACE their cached view, and an empty
// slice is the authoritative "no extension commands" signal. There is no
// diff/delta variant — keeping the contract uniform across all snapshot-style
// engine events.
//
// The engine itself never trusts a consumer's cache. Manager.SendCommand
// always resolves the command table at dispatch time from s.extGroup.Commands(),
// so a freshly-registered command will be found even when the snapshot for
// that change is still in flight. The consumer's cache is a routing HINT,
// not a source of truth.

package session

import (
	"fmt"
	"sort"

	"github.com/dsswift/ion/engine/internal/extension"
	"github.com/dsswift/ion/engine/internal/types"
	"github.com/dsswift/ion/engine/internal/utils"
)

// EngineEventCommandRegistry is the wire type string for the snapshot event.
// Lives next to the emitter rather than the EngineEvent struct because the
// EngineEvent type is a structural union — its string constants are scattered
// across the codebase by emission site, not centralised. Following that
// existing pattern.
const EngineEventCommandRegistry = "engine_command_registry"

// emitCommandRegistry builds and emits a complete snapshot of the slash
// commands currently registered by the session's extension group. Called:
//
//   - Once after loadAndWireExtensions finishes initial wiring (covers the
//     RegisterCommand calls that happen during extension init).
//   - Every subsequent time any host's SDK.RegisterCommand is invoked
//     (covers mid-session registration from hook handlers and any future
//     hot-reload / dynamic-load paths).
//
// Safe to call when extGroup is nil or empty — in that case the snapshot is
// an empty list, which is the AUTHORITATIVE "no extension commands" signal
// (per AGENTS.md snapshot semantics). Clients use this to clear their cache.
//
// Names are sorted alphabetically for deterministic output. This is not a
// contract requirement (consumers must not depend on order) but it makes
// snapshot diffing in logs and tests human-readable.
func (m *Manager) emitCommandRegistry(key string) {
	m.mu.RLock()
	s, ok := m.sessions[key]
	m.mu.RUnlock()
	if !ok {
		utils.Debug("Session", fmt.Sprintf("emitCommandRegistry: session %s not found, skipping", key))
		return
	}

	listings := buildCommandListings(s.extGroup)
	utils.Log("Session", fmt.Sprintf("emitCommandRegistry: key=%s count=%d", key, len(listings)))
	m.emit(key, types.EngineEvent{
		Type:     EngineEventCommandRegistry,
		Commands: listings,
	})
}

// buildCommandListings flattens a group's command map into a sorted listing.
// Pulled out of emitCommandRegistry so unit tests can exercise the conversion
// without spinning up a Manager and a full session. Nil/empty group yields a
// non-nil empty slice so the wire payload is `"commands":[]` rather than
// missing — clients depend on the field's presence as the snapshot signal.
func buildCommandListings(group *extension.ExtensionGroup) []types.EngineCommandListing {
	if group == nil || group.IsEmpty() {
		return []types.EngineCommandListing{}
	}
	cmds := group.Commands()
	if len(cmds) == 0 {
		return []types.EngineCommandListing{}
	}
	listings := make([]types.EngineCommandListing, 0, len(cmds))
	for name, def := range cmds {
		listings = append(listings, types.EngineCommandListing{
			Name:        name,
			Description: def.Description,
		})
	}
	sort.Slice(listings, func(i, j int) bool {
		return listings[i].Name < listings[j].Name
	})
	return listings
}
