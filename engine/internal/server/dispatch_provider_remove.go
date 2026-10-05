package server

import (
	"fmt"
	"net"

	"strings"

	"github.com/dsswift/ion/engine/internal/auth"
	ionconfig "github.com/dsswift/ion/engine/internal/config"
	"github.com/dsswift/ion/engine/internal/modelconfig"
	"github.com/dsswift/ion/engine/internal/protocol"
	"github.com/dsswift/ion/engine/internal/providers"
	"github.com/dsswift/ion/engine/internal/utils"
)

// dispatchProviderRemove deletes a custom provider: its engine.json entry,
// then its stored key, then its registration and models in the running
// engine, and broadcasts engine_providers_updated. A built-in provider is
// refused, since configuration does not create it and so cannot remove it.
// So is one models.json still selects (the default model, or a tier's model
// or fallback): new work there would name a model nothing serves.
//
// The stored key goes with the provider for the same reason an MCP server's
// credentials go with it: a key left behind would silently authorize a
// provider later defined under the same name.
func (s *Server) dispatchProviderRemove(conn net.Conn, cmd *protocol.ClientCommand) {
	providerID := cmd.Provider
	if !isCustomProvider(providerID) {
		utils.LogWithFields(utils.LevelInfo, "server.provider_remove", "remove refused: built-in provider", map[string]any{"provider": providerID})
		s.sendResult(conn, cmd, fmt.Errorf("cannot remove provider %q: it is built in; change its settings instead", providerID), nil)
		return
	}
	if refs := modelconfig.ProviderReferences(providerID); len(refs) > 0 {
		utils.LogWithFields(utils.LevelInfo, "server.provider_remove", "remove refused: models.json selects its models", map[string]any{"provider": providerID, "references": refs})
		s.sendResult(conn, cmd, fmt.Errorf("cannot remove provider %q: it is still selected as %s; choose other models first", providerID, strings.Join(refs, ", ")), nil)
		return
	}
	clearedFallback, err := ionconfig.RemoveProvider(providerID)
	if err != nil {
		utils.LogWithFields(utils.LevelInfo, "server.provider_remove", "remove failed", map[string]any{"provider": providerID, "error": err.Error()})
		s.sendResult(conn, cmd, err, nil)
		return
	}
	s.markProviderRemoved(providerID)

	subject := ""
	if cmd.Principal != nil {
		subject = cmd.Principal.Subject
	}
	keyCleared := true
	if err := auth.NewFileStore().DeleteKeyFor(subject, providerID); err != nil {
		keyCleared = false
		utils.LogWithFields(utils.LevelError, "server.provider_remove", "stored key delete failed", map[string]any{"provider": providerID, "subject": subject, "error": err.Error()})
	}
	if s.authResolver != nil {
		s.authResolver.ClearProgrammatic(providerID)
	}
	auth.InvalidatePrincipalCredential(subject, providerID)
	providers.InvalidateEntitlement(subject, providerID)
	providers.ForgetProvider(providerID)

	utils.LogWithFields(utils.LevelInfo, "server.provider_remove", "provider removed", map[string]any{"provider": providerID, "subject": subject, "key_cleared": keyCleared, "cleared_fallback_model": clearedFallback})
	s.sendResult(conn, cmd, nil, map[string]any{"provider": providerID, "keyCleared": keyCleared, "clearedFallbackModel": clearedFallback})
	s.broadcastProvidersUpdated()
}
