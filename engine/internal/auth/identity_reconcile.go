// identity_reconcile.go — version-aware grant reconciliation and renewal.
//
// A stored operator grant carries a schema version. When the engine's
// currentIdentityVersion is newer than a persisted grant, or the grant lacks
// the verified-identity snapshot, the engine upgrades it silently at startup
// using the existing refresh token — the operator never re-authenticates in a
// browser. The same mechanism keeps the identity alive: an id_token's freshness
// window lapsing is not a reason to discard who the operator is, so the grant is
// renewed in the background and only an explicit sign-out clears it.
package auth

import (
	"context"
	"fmt"
	"strings"
	"time"

	"github.com/dsswift/ion/engine/internal/utils"
)

// currentIdentityVersion is the schema version the running engine writes for a
// verified operator grant. A stored grant below this version is upgraded in
// place on the next load via a silent refresh-token exchange. Bump this when
// the persisted grant schema grows information the engine must capture.
//
//	v1 — tokens only (access, refresh, id_token, scope).
//	v2 — adds the verified identity snapshot (PersistedIdentity) so the engine
//	     can present the operator's identity without re-verifying on the hot
//	     path or after the id_token's freshness window lapses.
const currentIdentityVersion = 2

// persistedIdentity is the verified operator identity captured in the stored
// grant (schema v2). It mirrors the identity claims the engine derives from a
// verified id_token, so a later load can restore the identity without a network
// round-trip. All fields are omitempty; a v0/v1 grant simply has none.
type persistedIdentity struct {
	Subject     string         `json:"subject,omitempty"`
	Username    string         `json:"username,omitempty"`
	Name        string         `json:"name,omitempty"`
	Provider    string         `json:"provider,omitempty"`
	Attribution string         `json:"attribution,omitempty"`
	Claims      map[string]any `json:"claims,omitempty"`
	// ExpiresAt is the verified id_token's expiry. It marks when a background
	// renewal should refresh the grant — never when the identity is discarded.
	ExpiresAt time.Time `json:"expires_at,omitempty"`
}

// identityToPersisted captures a verified identity for storage in the grant.
func identityToPersisted(id *OperatorIdentity) *persistedIdentity {
	if id == nil {
		return nil
	}
	return &persistedIdentity{
		Subject: id.Subject, Username: id.Username, Name: id.Name,
		Provider: id.Provider, Attribution: id.Attribution,
		Claims: cloneClaimsOrNil(id.Claims), ExpiresAt: id.expiresAt,
	}
}

// persistedToIdentity restores a verified identity from the stored snapshot.
func persistedToIdentity(p *persistedIdentity) *OperatorIdentity {
	if p == nil {
		return nil
	}
	id := &OperatorIdentity{
		Subject: p.Subject, Username: p.Username, Name: p.Name,
		Provider: p.Provider, Attribution: p.Attribution,
		Claims: cloneClaimsOrNil(p.Claims),
	}
	id.expiresAt = p.ExpiresAt
	return id
}

// ReconcileAtStartup brings the stored grant up to the current schema at daemon
// boot. A missing grant is a valid signed-out state, not an error. A grant below
// the current version, or without the identity snapshot, is upgraded via a
// silent refresh so the operator's identity is available immediately without an
// interactive login. Bounded by ctx; safe to call once at startup.
func (m *IdentityManager) ReconcileAtStartup(ctx context.Context) error {
	stored, err := m.loadStored()
	if err != nil {
		utils.LogWithFields(utils.LevelInfo, "auth.identity", "no stored operator grant; awaiting interactive sign-in", map[string]any{
			"provider": m.provider,
		})
		return nil
	}
	// Force a refresh when the schema is behind or the identity snapshot is
	// absent, even if the access token is still fresh: the upgrade must capture
	// a currently-verifiable id_token and its identity snapshot.
	force := stored.IdentityVersion < currentIdentityVersion || stored.PersistedIdentity == nil
	if err := m.renewNow(ctx, force); err != nil {
		utils.LogWithFields(utils.LevelWarn, "auth.identity", "operator identity reconcile at startup failed; last-known identity retained", map[string]any{
			"provider": m.provider, "stored_version": stored.IdentityVersion, "error": err.Error(),
		})
		return err
	}
	identity := m.Identity()
	utils.LogWithFields(utils.LevelInfo, "auth.identity", "operator identity reconciled at startup", map[string]any{
		"provider": m.provider, "signed_in": identity != nil,
		"stored_version": stored.IdentityVersion, "current_version": currentIdentityVersion,
	})
	if identity != nil {
		m.publishIdentity(identity, "reconciled")
	}
	return nil
}

// renewNow performs one silent refresh-token exchange, verifies the fresh
// id_token, and re-persists the grant at the current identity version with a
// captured identity snapshot. It is the single mechanism behind startup
// reconcile, version upgrade, and background renewal. When the grant is already
// current, fresh, and carries an unexpired snapshot, it hydrates the in-memory
// cache from that snapshot and returns without any network I/O (unless force).
// A missing refresh token on an otherwise-unusable grant returns an error;
// nothing here signs the operator out — only an explicit SignOut does that.
func (m *IdentityManager) renewNow(ctx context.Context, force bool) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	m.refreshMu.Lock()
	defer m.refreshMu.Unlock()

	stored, err := m.loadStored()
	if err != nil {
		return fmt.Errorf("identity: no signed-in operator for provider %q: %w", m.provider, err)
	}

	// Already current, fresh, and holding an unexpired identity snapshot:
	// hydrate the cache without a round-trip.
	if !force && stored.IdentityVersion >= currentIdentityVersion && stored.PersistedIdentity != nil &&
		m.tokenFresh(*stored) && time.Now().Before(stored.PersistedIdentity.ExpiresAt) {
		identity := persistedToIdentity(stored.PersistedIdentity)
		identity.Provider = m.provider
		m.cacheIdentity(identity)
		return nil
	}

	if stored.RefreshToken == "" {
		return fmt.Errorf("identity: stored grant for provider %q has expired and has no refresh token; interactive re-login required", m.provider)
	}
	if err := m.resolveEndpoints(); err != nil {
		return err
	}

	prevVersion := stored.IdentityVersion
	refreshed, err := doRefreshTokenGrant(m.cfg.ClientID, stored.RefreshToken, m.cfg.TokenURL, stored.Scope, m.cfg.Audience, m.cfg.AudienceParameter)
	if err != nil {
		if isGrantRejected(err) {
			// Affirmative provider rejection (RFC 6749 §5.2): the refresh token is
			// dead, so the identity can no longer be proven and interactive
			// re-login is required. This is a genuine loss of verification, not a
			// lapsed freshness window — so here, and only here, the identity is
			// cleared and a verification_lost snapshot is published. A transient
			// transport error falls through and retains the last-known identity.
			m.cacheIdentity(nil)
			m.publishIdentity(nil, "verification_lost")
			utils.LogWithFields(utils.LevelError, "auth.identity", "operator grant rejected by provider; verification lost", map[string]any{
				"provider": m.provider, "error": err.Error(),
			})
		}
		return fmt.Errorf("identity: renew grant for provider %q: %w", m.provider, err)
	}

	// Providers commonly omit an unchanged id_token/scope on refresh; carry the
	// stored values forward. A rotated refresh token is captured by completeLogin.
	idToken := refreshed.IDToken
	if idToken == "" {
		idToken = stored.IDToken
	}
	scope := refreshed.Scope
	if scope == "" {
		scope = stored.Scope
	}
	refreshTok := refreshed.RefreshToken
	if refreshTok == "" {
		refreshTok = stored.RefreshToken
	}

	// completeLogin verifies the id_token, persists at currentIdentityVersion
	// with the identity snapshot, refreshes the cache, and publishes the change.
	if err := m.completeLogin(ctx, &TokenResponse{
		AccessToken: refreshed.AccessToken, RefreshToken: refreshTok,
		IDToken: idToken, TokenType: refreshed.TokenType, Scope: scope, ExpiresAt: refreshed.ExpiresAt,
	}, ""); err != nil {
		return err
	}
	if prevVersion < currentIdentityVersion {
		utils.LogWithFields(utils.LevelInfo, "auth.identity", "operator identity grant upgraded to current schema", map[string]any{
			"provider": m.provider, "from_version": prevVersion, "to_version": currentIdentityVersion,
		})
	}
	return nil
}

// isGrantRejected reports whether a refresh failure is an affirmative provider
// rejection of the grant itself (RFC 6749 §5.2 invalid_grant / invalid_client)
// — the refresh token is dead and interactive re-login is required — rather than
// a transient transport error that a later renewal may recover from.
func isGrantRejected(err error) bool {
	if err == nil {
		return false
	}
	msg := err.Error()
	return strings.Contains(msg, "invalid_grant") || strings.Contains(msg, "invalid_client")
}

// kickBackgroundRenewal launches at most one non-blocking silent renewal of the
// operator grant. Identity() runs on hot paths and must never block, so a lapsed
// id_token triggers this instead of a synchronous refresh. A failed renewal is
// logged and the last-known identity is retained; it is never discarded here.
func (m *IdentityManager) kickBackgroundRenewal() {
	if !m.renewing.CompareAndSwap(false, true) {
		return
	}
	go func() {
		defer m.renewing.Store(false)
		ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
		defer cancel()
		if err := m.renewNow(ctx, false); err != nil {
			utils.LogWithFields(utils.LevelWarn, "auth.identity", "background identity renewal failed; serving last-known identity", map[string]any{
				"provider": m.provider, "error": err.Error(),
			})
		}
	}()
}
