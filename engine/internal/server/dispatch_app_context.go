package server

import "github.com/dsswift/ion/engine/internal/protocol"

// dispatch_app_context.go carries the client-supplied application-context
// refresh that runs ahead of every command dispatch. Split out of
// dispatch.go, which sits at the 800-line file cap; this is a self-contained
// pre-dispatch concern with no coupling to the command switch itself.

// applyCommandAppContext refreshes the addressed session's client-supplied
// application context — the map stamped onto its conversation.* telemetry
// events under "app_context" — from any command that carries one.
//
// Deliberately not limited to start_session: a client whose surface was
// renamed, moved, or re-parented reflects that on its very next command
// instead of at the next session start, which is what keeps a long-lived
// conversation's events attributable to where it actually lives now.
//
// start_session is excluded because its value arrives on cmd.Config and is
// stored when the session is built — applying it here would address a
// session that does not exist yet. A command with no appContext (every
// command from every consumer that does not opt in) leaves the stored value
// untouched rather than clearing it; clearing is an explicit empty map.
// See types.EngineConfig.AppContext.
func (s *Server) applyCommandAppContext(cmd *protocol.ClientCommand) {
	if cmd.Cmd == "start_session" || cmd.AppContext == nil || cmd.Key == "" {
		return
	}
	s.manager.SetAppContext(cmd.Key, cmd.AppContext)
}
