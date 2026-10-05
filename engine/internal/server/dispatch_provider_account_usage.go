// dispatch_provider_account_usage.go — the provider_account_usage command.
//
// Each delegated provider CLI knows which account it is signed in to and
// what that account's usage limits are. This handler asks the CLIs and
// reports what they say. The engine never handles an account's credential.
package server

import (
	"errors"
	"net"
	"sort"
	"time"

	"github.com/dsswift/ion/engine/internal/cliprobe"
	ionconfig "github.com/dsswift/ion/engine/internal/config"
	"github.com/dsswift/ion/engine/internal/protocol"
	"github.com/dsswift/ion/engine/internal/types"
	"github.com/dsswift/ion/engine/internal/utils"
)

// usageBackends are the CLI backends that can report usage limits. Only
// these are re-probed by a usage read: their sign-in can change outside the
// engine, and the report must name the account the limits belong to.
var usageBackends = []string{"claude-code", "codex"}

// dispatchProviderAccountUsage answers on its own goroutine: the read spawns
// CLIs, and the read loop never waits on them.
func (s *Server) dispatchProviderAccountUsage(conn net.Conn, cmd *protocol.ClientCommand) {
	go func() {
		accounts := s.readProviderAccountUsage()
		s.sendResult(conn, cmd, nil, map[string]any{"accounts": accounts})
	}()
}

// cliBackendProviders maps each CLI backend kind to the provider it serves.
func cliBackendProviders() map[string]string {
	out := map[string]string{}
	for _, pid := range ionconfig.CliBackedProviderIDs() {
		if kind, ok := ionconfig.CliBackendKind(pid); ok {
			out[kind] = pid
		}
	}
	return out
}

// readProviderAccountUsage re-probes the usage-reporting CLIs, then reports
// every installed CLI backend's account and limits. A changed sign-in also
// refreshes the provider probes, so list_models consumers hear about it.
func (s *Server) readProviderAccountUsage() []types.ProviderAccountUsage {
	accounts := []types.ProviderAccountUsage{}
	if s.probes == nil {
		return accounts
	}
	s.usageMu.Lock()
	defer s.usageMu.Unlock()

	before := map[string]cliprobe.Probe{}
	for _, kind := range usageBackends {
		if p, ok := s.probes.Get(kind); ok {
			before[kind] = p
		}
	}
	s.probes.Refresh(usageBackends)
	changed := false
	for _, kind := range usageBackends {
		after, _ := s.probes.Get(kind) //nolint:errcheck // a missing probe compares as the zero probe
		prev := before[kind]
		if prev.Authenticated != after.Authenticated || prev.Email != after.Email || prev.OrgID != after.OrgID {
			changed = true
		}
	}

	providers := cliBackendProviders()
	kinds := make([]string, 0, len(providers))
	for kind := range providers {
		kinds = append(kinds, kind)
	}
	sort.Strings(kinds)
	for _, kind := range kinds {
		p, ok := s.probes.Get(kind)
		if !ok || !p.Installed {
			continue
		}
		entry := types.ProviderAccountUsage{
			Backend:   kind,
			Limits:    []types.ProviderUsageLimit{},
			FetchedAt: time.Now().UTC().Format(time.RFC3339),
		}
		if p.Authenticated {
			entry.Account = &types.ProviderAccount{
				Provider:   providers[kind],
				Email:      p.Email,
				OrgID:      p.OrgID,
				OrgName:    p.OrgName,
				PlanType:   p.PlanType,
				AuthMethod: p.AuthMethod,
				Label:      p.Label,
			}
			limits, err := s.usageFn(kind)
			switch {
			case err == nil:
				entry.Limits = limits
			case errors.Is(err, cliprobe.ErrNoUsage):
				// This backend has no usage read; the account stands alone.
			default:
				entry.Error = err.Error()
			}
		}
		utils.LogWithFields(utils.LevelInfo, "server", "provider account usage read", map[string]any{
			"backend": kind, "authenticated": p.Authenticated, "limit_count": len(entry.Limits), "error": entry.Error,
		})
		accounts = append(accounts, entry)
	}
	if changed {
		utils.LogWithFields(utils.LevelInfo, "server", "provider cli sign-in changed; refreshing provider probes", nil)
		s.RefreshProviderProbes()
	}
	return accounts
}
