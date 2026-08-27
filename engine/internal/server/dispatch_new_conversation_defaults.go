package server

import (
	ionconfig "github.com/dsswift/ion/engine/internal/config"
	"github.com/dsswift/ion/engine/internal/protocol"
	"github.com/dsswift/ion/engine/internal/utils"
	"net"
)

// dispatchResolveNewConversationDefaults resolves the portable policy without
// creating a session. Path is the single form; Paths returns results in input
// order. An empty request resolves the global policy once.
func (s *Server) dispatchResolveNewConversationDefaults(conn net.Conn, cmd *protocol.ClientCommand) {
	paths := cmd.Paths
	if paths == nil {
		paths = []string{cmd.Path}
	}
	resolved := make([]ionconfig.ResolvedNewConversationDefaults, 0, len(paths))
	for _, path := range paths {
		resolved = append(resolved, ionconfig.ResolveNewConversationDefaults(path))
	}
	utils.LogWithFields(utils.LevelInfo, "server", "resolved new conversation defaults", map[string]any{
		"count": len(resolved), "batch": cmd.Paths != nil,
	})
	if cmd.Paths != nil {
		s.sendResult(conn, cmd, nil, map[string]any{"defaults": resolved})
		return
	}
	s.sendResult(conn, cmd, nil, resolved[0])
}
