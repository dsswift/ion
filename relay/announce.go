package main

// announce.go — server-announced trust per channel (manifest C7).
//
// The relay's baseline auth model validates every peer (ion and mobile)
// against one org-wide PSK and/or one OIDC issuer+audience configured at
// relay startup (RELAY_OIDC_ISSUER/AUDIENCE/REQUIRED_SCOPE). That model
// requires every person who may use an Ion Studio Server to also be
// enrolled in the relay's own org registration -- workable for one org, not
// for a relay hosting servers whose people are gated by different Entra
// tenants.
//
// This file adds a per-channel override: the ion peer, as its first text
// frame after the WebSocket upgrade, announces its own issuer, audience,
// and scope. A mobile or client peer joining that same channel is then
// validated against the ANNOUNCED trust instead of the relay's own
// configured OIDC, provided the announced issuer is in the operator's
// RELAY_TRUSTED_ISSUERS allowlist (JWKS is fetched only for allowlisted
// issuers -- an unlisted issuer is refused outright, never fetched). A
// channel with no announcement is validated exactly as before this file
// existed: the relay's own org-wide OIDCConfig, or PSK.
//
// Trust is stored in memory only, keyed by channel id, and is replaced (not
// merged) on every new announcement -- a channel's trust reflects only the
// most recent thing its ion peer said, never an accumulation across
// reconnects.

import (
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"sort"
	"strings"
	"sync"
	"time"
)

// pairingChannelTTL is how long a one-time pairing channel (manifest C7)
// remains valid after being announced.
const pairingChannelTTL = 5 * time.Minute

// ChannelTrust is the announced trust for one channel: which issuer,
// audience, and scope a mobile/client peer joining this channel must
// present a bearer token for. Pairing marks a one-time pairing channel,
// which additionally expires and is single-use.
type ChannelTrust struct {
	Issuer   string
	Audience string
	Scope    string
	// Subject, when set, is the one subject allowed to join: a valid token
	// for the announced issuer that proves anyone else is refused. A host
	// announces it for a channel that belongs to one paired device, whose
	// owner may be signed in to a different tenant than the host is.
	Subject   string
	Pairing   bool
	ExpiresAt time.Time // zero for a non-pairing channel (no expiry)
	Used      bool      // pairing channels only: true after the first successful mobile join
}

// relayAnnounce is the wire shape of the ion peer's first text frame
// (manifest C7): {"type":"relay_announce","trust":{...}}. A pairing
// channel's announcement additionally carries {"pairing":true,"expiresAt":...}
// at the trust level instead of issuer/audience/scope.
type relayAnnounce struct {
	Type  string `json:"type"`
	Trust struct {
		Issuer    string `json:"issuer"`
		Audience  string `json:"audience"`
		Scope     string `json:"scope"`
		Subject   string `json:"subject"`
		Pairing   bool   `json:"pairing"`
		ExpiresAt int64  `json:"expiresAt"` // unix millis; pairing channels only
	} `json:"trust"`
}

// parseRelayAnnounce decodes a relay_announce frame. Returns ok=false for
// any frame that is not a well-formed relay_announce (a different frame
// type, malformed JSON, or a non-pairing announcement missing issuer or
// audience) -- the caller treats a malformed first frame as "no
// announcement", not as a fatal error, so an ion peer running older client
// code that sends application data first is unaffected.
func parseRelayAnnounce(data []byte) (ChannelTrust, bool) {
	var frame relayAnnounce
	if err := json.Unmarshal(data, &frame); err != nil {
		return ChannelTrust{}, false
	}
	if frame.Type != "relay_announce" {
		return ChannelTrust{}, false
	}
	trust := ChannelTrust{
		Issuer:   frame.Trust.Issuer,
		Audience: frame.Trust.Audience,
		Scope:    frame.Trust.Scope,
		Subject:  frame.Trust.Subject,
		Pairing:  frame.Trust.Pairing,
	}
	if trust.Pairing {
		if frame.Trust.ExpiresAt > 0 {
			trust.ExpiresAt = time.UnixMilli(frame.Trust.ExpiresAt)
		} else {
			trust.ExpiresAt = time.Now().Add(pairingChannelTTL)
		}
		return trust, true
	}
	if trust.Issuer == "" || trust.Audience == "" {
		return ChannelTrust{}, false
	}
	return trust, true
}

// TrustStore holds the announced trust for every channel that has one, in
// memory. Absent from the map means "no announcement" -- the caller falls
// back to the relay's own configured OIDC/PSK validation, unchanged from
// before this file existed.
type TrustStore struct {
	mu        sync.RWMutex
	byChannel map[string]ChannelTrust
}

// NewTrustStore creates an empty TrustStore.
func NewTrustStore() *TrustStore {
	return &TrustStore{byChannel: make(map[string]ChannelTrust)}
}

// Set records channelID's announced trust, replacing any prior
// announcement for that channel outright (never merged).
func (s *TrustStore) Set(channelID string, trust ChannelTrust) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.byChannel[channelID] = trust
}

// Get returns channelID's announced trust and whether one is set.
func (s *TrustStore) Get(channelID string) (ChannelTrust, bool) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	t, ok := s.byChannel[channelID]
	return t, ok
}

// Clear removes channelID's announced trust. Called when the ion peer that
// announced it disconnects, so a stale announcement never outlives the
// peer that made it.
func (s *TrustStore) Clear(channelID string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	delete(s.byChannel, channelID)
}

// MarkUsed records that a pairing channel's single permitted join has
// happened. Every later join attempt sees Used=true and is refused (410).
func (s *TrustStore) MarkUsed(channelID string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	t, ok := s.byChannel[channelID]
	if !ok {
		return
	}
	t.Used = true
	s.byChannel[channelID] = t
}

// OIDCRegistry lazily builds and caches an *OIDCConfig per trusted issuer,
// so a server-announced issuer outside the relay's own org-wide
// configuration can still be validated -- but ONLY when that issuer is in
// the operator's RELAY_TRUSTED_ISSUERS allowlist. JWKS is fetched only for
// an allowlisted issuer; an unlisted one is refused before any network
// call, which bounds both the relay's outbound JWKS fetch surface and its
// exposure to an ion peer announcing an issuer it does not actually trust.
type OIDCRegistry struct {
	trusted map[string]bool // issuer -> allowed

	mu       sync.Mutex
	byIssuer map[string]*OIDCConfig
}

// NewOIDCRegistry builds a registry from a comma-separated
// RELAY_TRUSTED_ISSUERS value. An empty or whitespace-only value trusts no
// issuer at all -- every announced-trust validation then fails with
// issuer_not_trusted, which is the safe default: an operator who has not
// set the allowlist gets a relay that refuses every announced-trust join
// rather than one that silently accepts any issuer an ion peer names.
func NewOIDCRegistry(trustedIssuersEnv string) *OIDCRegistry {
	trusted := make(map[string]bool)
	for _, issuer := range strings.Split(trustedIssuersEnv, ",") {
		issuer = strings.TrimSpace(issuer)
		if issuer != "" {
			trusted[issuer] = true
		}
	}
	return &OIDCRegistry{
		trusted:  trusted,
		byIssuer: make(map[string]*OIDCConfig),
	}
}

// Trust adds issuer to the allowlist. Used for the relay's own configured
// issuers, which need no second listing to be announced.
func (r *OIDCRegistry) Trust(issuer *OIDCConfig) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.trusted[issuer.Issuer] = true
	if _, ok := r.byIssuer[issuer.Issuer]; !ok {
		r.byIssuer[issuer.Issuer] = issuer
	}
}

// TrustedIssuers lists every issuer an announcement may name, sorted.
func (r *OIDCRegistry) TrustedIssuers() []string {
	r.mu.Lock()
	defer r.mu.Unlock()
	out := make([]string, 0, len(r.trusted))
	for issuer := range r.trusted {
		out = append(out, issuer)
	}
	sort.Strings(out)
	return out
}

// errIssuerNotTrusted is returned by Validate when issuer is not in the
// RELAY_TRUSTED_ISSUERS allowlist. Callers map this to the wire reason
// "issuer_not_trusted" and a 403.
var errIssuerNotTrusted = fmt.Errorf("issuer not in RELAY_TRUSTED_ISSUERS")

// errJWKSUnavailable is returned by Validate when a trusted issuer's key set
// could not be loaded at all. A token that was checked and refused is a
// different failure and is reported as one.
var errJWKSUnavailable = fmt.Errorf("jwks unavailable")

// Validate validates token against the given issuer, audience, and scope,
// building (and caching) an *OIDCConfig for issuer on first use. The JWKS
// fetch and cache are per-ISSUER (an issuer publishes one key set
// regardless of which audience a token targets), but audience and scope
// are validated per-call against THIS call's values, not against whatever
// audience/scope happened to be passed the first time this issuer was
// seen -- two channels can announce the same issuer with different
// audiences, and each must be checked against its own. Returns
// errIssuerNotTrusted without any network call when issuer is not
// allowlisted.
func (r *OIDCRegistry) Validate(token, issuer, audience, scope string) (*UserIdentity, error) {
	r.mu.Lock()
	if !r.trusted[issuer] {
		r.mu.Unlock()
		return nil, errIssuerNotTrusted
	}
	cfg, ok := r.byIssuer[issuer]
	if !ok {
		var err error
		cfg, err = NewOIDCConfig(issuer, audience, scope)
		if err != nil {
			r.mu.Unlock()
			logger.Error("relay announce: failed to initialize OIDC config for trusted issuer",
				"tag", "relay.announce", "issuer", issuer, "err", err)
			return nil, fmt.Errorf("%w for trusted issuer %q: %v", errJWKSUnavailable, issuer, err)
		}
		r.byIssuer[issuer] = cfg
	}
	r.mu.Unlock()

	return cfg.ValidateJWTFor(token, audience, scope)
}

// announcedTrustOutcome is the result of validating a mobile/client join
// against a channel's announced trust: exactly one of identity/reason is
// set. A pairing-channel single-use marker (MarkUsed) is the caller's
// responsibility to invoke on success -- this function only validates, it
// never mutates Used itself, so a caller that ultimately refuses the
// upgrade for an unrelated reason does not burn the pairing channel's one
// permitted use.
type announcedTrustOutcome struct {
	identity *UserIdentity
	reason   AuthFailureReason
	// pairing is true when the validated channel is a one-time pairing
	// channel. The caller marks it used only on a fully successful
	// validation (identity set, reason empty) so a request refused for an
	// unrelated reason never burns the channel's one permitted use.
	pairing bool
}

// validateAgainstAnnouncedTrust validates request r's bearer token against
// channelID's announced trust (manifest C7). Returns ok=false when the
// channel has NO announcement at all -- the caller falls back to the
// relay's own org-wide OIDC/PSK validation (ValidateDetailed), unchanged
// from before this feature existed.
//
// A pairing channel (trust.Pairing) is checked for expiry/reuse before any
// token validation runs, matching manifest C7's "single use" contract:
// once *any* mobile join has consumed it, every later join -- even a
// perfectly valid bearer -- is refused.
func validateAgainstAnnouncedTrust(r *http.Request, channelID string, trustStore *TrustStore, registry *OIDCRegistry) (announcedTrustOutcome, bool) {
	trust, ok := trustStore.Get(channelID)
	if !ok {
		return announcedTrustOutcome{}, false
	}

	// A pairing channel carries no issuer/audience to validate a bearer
	// against -- its identity guarantee comes from the DH pairing handshake
	// the two peers run over the forwarded frames (see the server's pairing
	// flow, manifest C7/C8), not from anything the relay can check. The
	// relay's only job here is expiry and single-use gating.
	if trust.Pairing {
		if trust.Used || time.Now().After(trust.ExpiresAt) {
			return announcedTrustOutcome{reason: authFailurePairingExpired}, true
		}
		return announcedTrustOutcome{pairing: true}, true
	}

	bearer, reason := extractBearerToken(r)
	if reason != "" {
		return announcedTrustOutcome{reason: reason}, true
	}

	if registry == nil {
		return announcedTrustOutcome{reason: authFailureIssuerNotTrusted}, true
	}

	identity, err := registry.Validate(bearer, trust.Issuer, trust.Audience, trust.Scope)
	if err != nil {
		switch {
		case err == errIssuerNotTrusted:
			return announcedTrustOutcome{reason: authFailureIssuerNotTrusted}, true
		case errors.Is(err, errJWKSUnavailable):
			return announcedTrustOutcome{reason: authFailureJWKSUnavailable}, true
		}
		return announcedTrustOutcome{reason: authFailureJWTValidation}, true
	}

	if trust.Subject != "" && identity.Subject != trust.Subject {
		logger.Warn("relay announce: join refused, token subject is not the announced one",
			"tag", "relay.announce", "channel_id", channelID, "issuer", trust.Issuer)
		return announcedTrustOutcome{reason: authFailureSubjectNotAnnounced}, true
	}

	return announcedTrustOutcome{identity: identity}, true
}
