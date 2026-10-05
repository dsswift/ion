package main

// routes.go — the relay's HTTP routes. Kept apart from main() so a test can
// serve exactly what production serves instead of a hand-copied mux.

import (
	"encoding/json"
	"net/http"
)

// newRelayMux builds every route the relay serves. pusher may be nil (no
// push notifications configured).
func newRelayMux(hub *Hub, auth *AuthMiddleware, owners *channelOwnerStore, pusher *APNsPusher) *http.ServeMux {
	mux := http.NewServeMux()

	mux.HandleFunc("GET /healthz", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusOK)
		w.Write([]byte(`{"status":"ok"}`)) //nolint:errcheck // health endpoint; client hangup is irrelevant
	})

	// GET /v1/auth/config — unauthenticated; tells clients which auth modes are active.
	mux.HandleFunc("GET /v1/auth/config", func(w http.ResponseWriter, r *http.Request) {
		type capabilitiesBlock struct {
			MobileForwardAck bool `json:"mobileForwardAck"`
			// MultiClient: a server that joins with multi=1 keeps every
			// client of its pairing on the channel at once.
			MultiClient bool `json:"multiClient"`
		}
		type authConfigResponse struct {
			OIDC          bool   `json:"oidc"`
			Issuer        string `json:"issuer,omitempty"`
			Audience      string `json:"audience,omitempty"`
			RequiredScope string `json:"requiredScope,omitempty"`
			// Issuers is every accepted org-wide issuer, primary first. The
			// three fields above repeat the primary for a client that reads
			// only them. A client signed in to one of several tenants picks
			// the entry whose issuer is its own.
			Issuers      []OIDCIssuerSpec  `json:"issuers,omitempty"`
			PSK          bool              `json:"psk"`
			Capabilities capabilitiesBlock `json:"capabilities"`
		}
		resp := authConfigResponse{
			PSK:          len(auth.apiKey) > 0,
			Capabilities: capabilitiesBlock{MobileForwardAck: true, MultiClient: true},
		}
		if auth.oidc != nil {
			resp.OIDC = true
			resp.Issuer = auth.oidc.Issuer
			resp.Audience = auth.oidc.Audience
			resp.RequiredScope = auth.oidc.RequiredScope
			for _, cfg := range auth.issuers {
				resp.Issuers = append(resp.Issuers, OIDCIssuerSpec{Issuer: cfg.Issuer, Audience: cfg.Audience, RequiredScope: cfg.RequiredScope})
			}
		}
		logger.Info("serving auth config",
			"tag", "relay.auth_config",
			"psk", resp.PSK,
			"oidc", resp.OIDC,
			"issuer_count", len(resp.Issuers),
			"capabilities_mobile_forward_ack", resp.Capabilities.MobileForwardAck,
		)
		w.Header().Set("Content-Type", "application/json")
		if err := json.NewEncoder(w).Encode(resp); err != nil {
			logger.Warn("auth config encode error", "tag", "relay.auth_config_error", "err", err)
		}
	})

	mux.HandleFunc("GET /v1/channel/{channelId}", func(w http.ResponseWriter, r *http.Request) {
		channelID := r.PathValue("channelId")
		role := r.URL.Query().Get("role")
		if role != "ion" && role != "mobile" {
			http.Error(w, "role must be 'ion' or 'mobile'", http.StatusBadRequest)
			return
		}
		if !validChannelID(channelID) {
			http.Error(w, "invalid channel id", http.StatusBadRequest)
			return
		}

		// Server-announced trust (manifest C7): the ion peer that owns this
		// channel is always authenticated via the relay's own org-wide
		// PSK/OIDC below, unchanged -- announced trust only ever applies to
		// the OTHER peer (a mobile or client joining what the ion peer
		// announced). A pairing channel (role must be mobile; an ion peer
		// never joins one) is likewise gated here before any bearer is even
		// looked at, in case a pairing channel's single use was already
		// consumed by a concurrent request.
		var identity *UserIdentity
		if role == "mobile" {
			if outcome, announced := validateAgainstAnnouncedTrust(r, channelID, hub.trust, hub.oidcRegistry); announced {
				if outcome.reason != "" {
					logAuthFailure(r, outcome.reason)
					status := http.StatusUnauthorized
					switch outcome.reason {
					case authFailureIssuerNotTrusted, authFailureSubjectNotAnnounced:
						status = http.StatusForbidden
					case authFailurePairingExpired:
						status = http.StatusGone
					}
					http.Error(w, "unauthorized", status)
					return
				}
				identity = outcome.identity
				logAuthSuccess(identity, "announced trust")
				if outcome.pairing {
					hub.trust.MarkUsed(channelID)
				}
				hub.HandleWebSocket(w, r, channelID, role, pusher, identity)
				return
			}
		}

		// No announcement on this channel (or this is the ion role): fall
		// back to the relay's own org-wide PSK/OIDC validation, exactly as
		// before manifest C7 existed.
		var reason AuthFailureReason
		identity, reason = auth.ValidateDetailed(r)
		if reason != "" {
			logAuthFailure(r, reason)
			http.Error(w, "unauthorized", http.StatusUnauthorized)
			return
		}

		// OIDC channel isolation: enforce subject-based ownership before
		// upgrade. Only the ion role CLAIMS a channel, because the channel
		// belongs to the server that holds the pairing. A client that claimed
		// an unowned channel locked that server out of it permanently.
		if identity != nil {
			allowed := owners.Allows(channelID, identity.OwnerKey)
			if allowed && role == "ion" {
				allowed = owners.Bind(channelID, identity.OwnerKey)
			}
			if !allowed {
				owner, _ := owners.Owner(channelID)
				logger.Warn("oidc: channel access denied — subject mismatch",
					"tag", "relay.channel.denied",
					"channel_id", channelID,
					"role", role,
					"subject", identity.Subject,
					"owner", owner)
				http.Error(w, "forbidden: channel owned by another identity", http.StatusForbidden)
				return
			}
			if role == "ion" {
				hub.EvictForeignMobile(channelID, identity.OwnerKey)
			}
		}

		logAuthSuccess(identity, "psk or jwt")
		hub.HandleWebSocket(w, r, channelID, role, pusher, identity)
	})

	mux.HandleFunc("GET /v1/channel/{channelId}/status", func(w http.ResponseWriter, r *http.Request) {
		channelID := r.PathValue("channelId")
		if !validChannelID(channelID) {
			http.Error(w, "invalid channel id", http.StatusBadRequest)
			return
		}

		// Server-announced trust (manifest C7): status applies the same
		// check as join. A channel with an announcement (including a
		// pairing channel) is validated against it; anything else falls
		// through to the org-wide path below, unchanged.
		if outcome, announced := validateAgainstAnnouncedTrust(r, channelID, hub.trust, hub.oidcRegistry); announced {
			if outcome.reason != "" {
				logAuthFailure(r, outcome.reason)
				http.Error(w, "unauthorized", http.StatusUnauthorized)
				return
			}
			ion, mobile := hub.ChannelStatus(channelID)
			w.Header().Set("Content-Type", "application/json")
			if err := json.NewEncoder(w).Encode(map[string]bool{"ion": ion, "mobile": mobile}); err != nil {
				logger.Warn("channel status encode error", "tag", "relay.status_error", "err", err)
			}
			return
		}

		identity, reason := auth.ValidateDetailed(r)
		if reason != "" {
			logAuthFailure(r, reason)
			http.Error(w, "unauthorized", http.StatusUnauthorized)
			return
		}

		// OIDC mode: least-privilege presence. A subject may see live presence
		// only for a channel it already owns. An unbound channel (owned==false)
		// must NOT reveal live hub presence — otherwise a subject could probe a
		// channel it does not own (e.g. one a PSK client is connected to, or one
		// another subject is about to bind) and read its presence booleans, a
		// cross-tenant presence oracle. Status never binds (binding here would
		// let a subject squat another's channel by probing), so an unowned or
		// other-owned channel returns empty presence without touching the hub.
		if identity != nil {
			owner, owned := owners.Owner(channelID)
			if !owned || owner != identity.OwnerKey {
				if owned {
					logger.Warn("oidc: status access denied — subject mismatch",
						"tag", "relay.channel.denied",
						"channel_id", channelID,
						"subject", identity.Subject,
						"owner", owner)
				}
				w.Header().Set("Content-Type", "application/json")
				if err := json.NewEncoder(w).Encode(map[string]bool{"ion": false, "mobile": false}); err != nil {
					logger.Warn("channel status encode error", "tag", "relay.status_error", "err", err)
				}
				return
			}
		}

		ion, mobile := hub.ChannelStatus(channelID)
		w.Header().Set("Content-Type", "application/json")
		if err := json.NewEncoder(w).Encode(map[string]bool{"ion": ion, "mobile": mobile}); err != nil {
			logger.Warn("channel status encode error", "tag", "relay.status_error", "err", err)
		}
	})

	return mux
}
