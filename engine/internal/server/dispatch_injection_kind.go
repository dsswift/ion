package server

// Client-stated injection-kind validation for send_prompt.

import (
	"github.com/dsswift/ion/engine/internal/types"
	"github.com/dsswift/ion/engine/internal/utils"
)

// resolveClientInjectionKind validates a client-supplied
// ClientCommand.InjectionKind and returns the value to persist.
//
// A client that owns its own answer surface (a questions wizard, a form) may
// legitimately state that the turn it delivers is not something the operator
// typed at the prompt. But the engine cannot accept an arbitrary string:
// InjectionKind.IsMachineToMachine treats an unknown kind as user-authored, so
// an invented value would be recorded on the turn while changing nothing a
// consumer reads — a row that looks classified and is not.
//
// Unknown values are therefore dropped to empty (an ordinary user turn) and
// logged at WARN with the offending value, so a client sending a typo learns
// about it from the engine log rather than from a silently unclassified turn.
func resolveClientInjectionKind(key, kind string) string {
	if kind == "" {
		return ""
	}
	if types.InjectionKind(kind).IsKnown() {
		utils.LogWithFields(utils.LevelInfo, "server.dispatch", "send_prompt: client-stated injection kind accepted", map[string]any{
			"key": key, "injection_kind": kind,
		})
		return kind
	}
	utils.LogWithFields(utils.LevelWarn, "server.dispatch", "send_prompt: unknown client-stated injection kind dropped; treating as a user turn", map[string]any{
		"key": key, "injection_kind": kind,
	})
	return ""
}
