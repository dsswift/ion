package server

import (
	"net"

	ionconfig "github.com/dsswift/ion/engine/internal/config"
	"github.com/dsswift/ion/engine/internal/protocol"
	"github.com/dsswift/ion/engine/internal/types"
	"github.com/dsswift/ion/engine/internal/utils"
)

// dispatchGetManagedConfigStatus reports which managed config files are in
// force, never their content.
//
// applied is the status this engine loaded at start, the one its start-time
// configuration came from. current is the status the managed source resolves
// to now. They differ when a managed file changed since start. Either is null
// when no managed surface is declared.
func (s *Server) dispatchGetManagedConfigStatus(conn net.Conn, cmd *protocol.ClientCommand) {
	var applied, current *types.ManagedConfigStatus
	if s.config != nil && s.config.Enterprise != nil {
		applied = s.config.Enterprise.ManagedConfigStatus
	}
	if enterprise := ionconfig.LoadEnterpriseConfig(); enterprise != nil {
		current = enterprise.ManagedConfigStatus
	}
	s.sendResult(conn, cmd, nil, map[string]any{"applied": applied, "current": current})
	utils.LogWithFields(utils.LevelInfo, "server.managed_config", "managed config status delivered", map[string]any{
		"applied_declared": applied != nil, "current_declared": current != nil,
	})
}
