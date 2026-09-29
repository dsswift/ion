// Package auth: the per-principal credential source seam (SC-1).
//
// A shared engine serves several people. auth.Resolver resolves a credential
// by provider alone, with no notion of who is asking. PrincipalCredentialSource
// is the registrable seam that lets a consumer (the engine's own client-asking
// source in child 09, or a third-party extension) answer "what credential does
// this principal have for this provider/host" before the resolver's
// process-wide levels are ever consulted.
//
// Every source returns a RequestAuthenticator, never a raw credential (R-06):
// the return type makes a raw-key leak structurally impossible, the same
// discipline auth/registry.go already applies to AWS credentials ("because AWS
// credentials authorize a signature operation, not bearer export").
package auth

import (
	"context"
	"strings"
	"sync"
	"time"

	"github.com/dsswift/ion/engine/internal/utils"
)

// perSourceTimeout bounds how long ResolvePrincipalCredential waits on any
// one source before moving to the next. A hanging source (a wedged client
// round trip, a slow config lookup) must never stall an entire run.
const perSourceTimeout = 5 * time.Second

// CredentialScope identifies what a PrincipalCredentialSource is being asked
// to resolve: a principal (Subject), and one of two axes -- Provider for a
// model credential, Host for a git credential (FR-04). Exactly one of
// Provider/Host is populated per call; which axis is in play is a property of
// the caller, not of the scope value itself.
type CredentialScope struct {
	Subject  string // SessionPrincipal.Subject; "" means unattributed
	Provider string // model-credential axis: provider id, lowercased
	Host     string // git-credential axis: hostname
}

// normalized trims Subject and lowercases+trims Provider and Host, so a
// source implementation never has to normalize inputs itself and two
// differently-cased callers agree on the same scope.
func (s CredentialScope) normalized() CredentialScope {
	return CredentialScope{
		Subject:  strings.TrimSpace(s.Subject),
		Provider: strings.ToLower(strings.TrimSpace(s.Provider)),
		Host:     strings.ToLower(strings.TrimSpace(s.Host)),
	}
}

// PrincipalCredentialSource is the single registrable interface serving both
// credential axes (R-26). Implementations are consulted in registration
// order, sequentially and never raced -- matching
// server/src/git/identity/resolver.ts:27-43, which this seam generalizes to
// the engine side of the process boundary.
type PrincipalCredentialSource interface {
	Name() string
	// Resolve returns an authenticator for the scope, or (nil, nil) when this
	// source has nothing for it. Never returns a raw credential. An error does
	// not abort the overall chain -- see ResolvePrincipalCredential -- but a
	// non-nil authenticator returned alongside a non-nil error is treated as a
	// failure: a half-failed source must not authenticate a run by accident.
	Resolve(ctx context.Context, scope CredentialScope) (RequestAuthenticator, error)
}

var (
	principalSourceMu sync.RWMutex
	principalSources  []PrincipalCredentialSource
)

// RegisterPrincipalSource adds a source, or replaces one already registered
// under the same Name() in place -- idempotent by name, preserving precedence
// position, matching the same discipline server/src/git/identity/resolver.ts
// applies on its side of the boundary.
func RegisterPrincipalSource(s PrincipalCredentialSource) {
	principalSourceMu.Lock()
	defer principalSourceMu.Unlock()
	for i, existing := range principalSources {
		if existing.Name() == s.Name() {
			principalSources[i] = s
			utils.LogWithFields(utils.LevelInfo, "auth", "principal credential source replaced", map[string]any{"source": s.Name()})
			return
		}
	}
	principalSources = append(principalSources, s)
	utils.LogWithFields(utils.LevelInfo, "auth", "principal credential source registered", map[string]any{"source": s.Name(), "position": len(principalSources) - 1})
}

// UnregisterAllPrincipalSourcesForTest clears the registry. Test-only: real
// process lifetime never needs to remove a source, only replace it.
func UnregisterAllPrincipalSourcesForTest() {
	principalSourceMu.Lock()
	defer principalSourceMu.Unlock()
	principalSources = nil
}

// ResolvePrincipalCredential walks registered sources in registration order,
// sequentially, returning the first non-nil authenticator. A source that
// errors is logged and skipped -- one bad source never aborts the chain for a
// later one that might still answer. No sources registered, or none answer:
// returns (nil, "", nil), and the caller (auth.CredentialContext) applies
// fall-through policy. This is the identical behavior to today's resolver
// path for an engine with no sources registered at all.
func ResolvePrincipalCredential(ctx context.Context, scope CredentialScope) (RequestAuthenticator, string, error) {
	scope = scope.normalized()

	principalSourceMu.RLock()
	sources := make([]PrincipalCredentialSource, len(principalSources))
	copy(sources, principalSources)
	principalSourceMu.RUnlock()

	for _, source := range sources {
		sctx, cancel := context.WithTimeout(ctx, perSourceTimeout)
		a, err := source.Resolve(sctx, scope)
		cancel()
		if err != nil {
			utils.LogWithFields(utils.LevelWarn, "auth", "principal source failed", map[string]any{
				"source": source.Name(), "subject": scope.Subject, "provider": scope.Provider, "credential_host": scope.Host, "error": err.Error(),
			})
			continue
		}
		if a != nil {
			utils.LogWithFields(utils.LevelInfo, "auth", "principal credential resolved", map[string]any{
				"source": source.Name(), "subject": scope.Subject, "provider": scope.Provider, "credential_host": scope.Host,
			})
			return a, source.Name(), nil
		}
	}
	utils.LogWithFields(utils.LevelInfo, "auth", "no principal credential", map[string]any{
		"subject": scope.Subject, "provider": scope.Provider, "credential_host": scope.Host, "sources": len(sources),
	})
	return nil, "", nil
}
