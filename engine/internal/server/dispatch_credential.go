package server

import (
	"fmt"
	"net"

	"github.com/dsswift/ion/engine/internal/auth"
	"github.com/dsswift/ion/engine/internal/protocol"
	"github.com/dsswift/ion/engine/internal/providers"
	"github.com/dsswift/ion/engine/internal/utils"
)

// dispatchStoreCredential handles store_credential, extracted from dispatch's
// switch to keep dispatch.go under the file-size cap. Honors the acting
// principal (child 08, R-37): a write/clear from an attributed connection
// lands in that principal's own partition, never the shared unattributed
// one. "" (unattributed) preserves the pre-child-08 behavior byte for byte
// (B-07..B-10).
func (s *Server) dispatchStoreCredential(conn net.Conn, cmd *protocol.ClientCommand) {
	if s.authResolver == nil {
		s.sendResult(conn, cmd, fmt.Errorf("auth resolver not configured"), nil)
		return
	}
	subject := ""
	if cmd.Principal != nil {
		subject = cmd.Principal.Subject
	}
	fs := auth.NewFileStore()
	if cmd.Credential == "" {
		// Empty credential means "clear this key"
		if err := fs.DeleteKeyFor(subject, cmd.Provider); err != nil {
			// A failed delete means the key persists while the user is told
			// it was cleared — this must not be silent.
			utils.LogWithFields(utils.LevelError, "server", "credential delete failed", map[string]any{"subject": subject, "provider": cmd.Provider, "error": err.Error()})
		}
		auth.InvalidatePrincipalCredential(subject, cmd.Provider)
		providers.InvalidateEntitlement(subject, cmd.Provider)
		utils.LogWithFields(utils.LevelInfo, "server", "credential stored", map[string]any{"subject": subject, "provider": cmd.Provider, "cleared": true})
	} else {
		if err := fs.SetKeyFor(subject, cmd.Provider, cmd.Credential); err != nil {
			s.sendResult(conn, cmd, err, nil)
			return
		}
		auth.InvalidatePrincipalCredential(subject, cmd.Provider)
		providers.InvalidateEntitlement(subject, cmd.Provider)
		utils.LogWithFields(utils.LevelInfo, "server", "credential stored", map[string]any{"subject": subject, "provider": cmd.Provider, "cleared": false})
		// Trigger model discovery for the newly-authed provider so its
		// models appear in the picker without requiring an engine restart.
		// Preserved for the unattributed path exactly as before (B-11,
		// B-12); an attributed principal's own catalog is discovered
		// lazily on next use via CredentialContext.Entitlement (child
		// 05) rather than eagerly here, since DiscoverProvider has no
		// per-principal authenticator seam of its own.
		if subject == "" {
			providers.DiscoverProvider(cmd.Provider, cmd.Credential, s.providerConfigs())
		}
	}
	s.sendResult(conn, cmd, nil, nil)
}
