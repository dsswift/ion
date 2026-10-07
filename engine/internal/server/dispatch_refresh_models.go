package server

import (
	"net"

	"github.com/dsswift/ion/engine/internal/auth"
	"github.com/dsswift/ion/engine/internal/protocol"
	"github.com/dsswift/ion/engine/internal/providers"
	"github.com/dsswift/ion/engine/internal/telemetry"
	"github.com/dsswift/ion/engine/internal/utils"
)

// dispatchRefreshModels re-discovers models for cmd.Provider, or for every
// provider when it is empty. The result data carries one outcome per provider
// under "results". The result is an error only when discovery failed for every
// provider it targeted, so a partial failure is ok with the failures listed.
func (s *Server) dispatchRefreshModels(conn net.Conn, cmd *protocol.ClientCommand) {
	providerConfigs := s.providerConfigs()
	var resolveKey func(string) (string, error)
	if s.authResolver != nil {
		resolveKey = s.authResolver.ResolveKey
	} else {
		resolveKey = func(string) (string, error) { return "", nil }
	}
	// provider.probe: HTTP model discovery, under the command's dispatch span.
	var span *telemetry.SpanHandle
	if telem := s.Telemetry(); telem != nil {
		span = telem.StartSpanCtx(telemetry.ProviderProbe, map[string]any{"probe": "models", "provider": cmd.Provider}, commandSpanCtx(cmd))
	}
	results := providers.RefreshModels(cmd.Provider, true, resolveKey, providerConfigs)
	if span != nil {
		span.End(map[string]any{"results": len(results)})
	}
	// When the request is attributed, also refresh the acting
	// principal's OWN entitlement (R-12) -- the process-wide
	// RefreshModels call above only re-fetches the shared metadata
	// path (dialect, cost); a principal's discovered id set is
	// per-(subject, provider) and needs its own invalidate+refetch.
	if cmd.Principal != nil && cmd.Principal.Subject != "" && s.authResolver != nil {
		cc := auth.NewCredentialContext(cmd.Principal, s.authResolver, auth.NewTenancyFallThroughPolicy(s.config))
		providers.WireEntitlement(cc, providerConfigs)
		refreshSubjects := []string{cmd.Provider}
		if cmd.Provider == "" {
			refreshSubjects = providers.ListProviderIDs()
		}
		for _, pid := range refreshSubjects {
			providers.InvalidateEntitlement(cmd.Principal.Subject, pid)
			cc.Entitlement(pid) // triggers a fresh fetch, result cached
		}
	}
	// Re-probe the delegated CLIs too, so their install/auth state and
	// model lists refresh alongside the HTTP providers.
	s.RefreshProviderProbes()

	err := providers.ModelRefreshError(results)
	counts := map[providers.ModelRefreshStatus]int{}
	for _, r := range results {
		counts[r.Status]++
	}
	fields := map[string]any{
		"provider":   cmd.Provider,
		"request_id": cmd.RequestID,
		"succeeded":  counts[providers.ModelRefreshOK],
		"failed":     counts[providers.ModelRefreshFailed],
		"skipped":    counts[providers.ModelRefreshSkipped],
	}
	if err != nil {
		fields["error"] = err.Error()
		utils.LogWithFields(utils.LevelWarn, "server", "refresh models failed", fields)
	} else {
		utils.LogWithFields(utils.LevelInfo, "server", "refresh models complete", fields)
	}
	s.sendResult(conn, cmd, err, map[string]any{"results": results})
}
