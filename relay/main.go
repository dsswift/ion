package main

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"os/signal"
	"strconv"
	"syscall"
	"time"
)

// Config holds all relay server configuration.
type Config struct {
	Port       string
	APIKey     string
	APNsKey    string
	APNsKeyID  string
	APNsTeamID string
	APNsTopic  string
	OIDC       *OIDCConfig
}

func loadConfig() (Config, error) {
	port := os.Getenv("RELAY_PORT")
	if port == "" {
		port = "8443"
	}

	apiKey := os.Getenv("RELAY_API_KEY")

	issuer := os.Getenv("RELAY_OIDC_ISSUER")
	audience := os.Getenv("RELAY_OIDC_AUDIENCE")
	requiredScope := os.Getenv("RELAY_OIDC_REQUIRED_SCOPE")

	// Build OIDC config (nil when issuer is empty).
	oidcCfg, oidcErr := NewOIDCConfig(issuer, audience, requiredScope)

	oidcConfigured := issuer != "" && oidcErr == nil && oidcCfg != nil

	// Log both sides so the resolved auth posture is always observable. A
	// misconfiguration (issuer set, audience empty, or a startup JWKS failure)
	// disables OIDC and falls back to PSK-only — that decision must not be
	// silent, or an operator who intended OIDC ships a relay that quietly
	// serves PSK-only (or, worse, would have served an audience-unbound OIDC).
	switch {
	case issuer != "" && oidcErr != nil:
		logger.Error("oidc requested but disabled; falling back to PSK-only",
			"tag", "relay.startup", "issuer", issuer, "err", oidcErr)
	case oidcConfigured:
		logger.Info("oidc enabled",
			"tag", "relay.startup", "issuer", issuer, "audience", audience)
	default:
		logger.Info("oidc not configured; PSK-only mode",
			"tag", "relay.startup")
	}

	// Require at least one auth mode.
	if apiKey == "" && !oidcConfigured {
		return Config{}, fmt.Errorf("no auth configured: set RELAY_API_KEY and/or RELAY_OIDC_ISSUER+RELAY_OIDC_AUDIENCE")
	}

	return Config{
		Port:       port,
		APIKey:     apiKey,
		APNsKey:    os.Getenv("APNS_KEY_PATH"),
		APNsKeyID:  os.Getenv("APNS_KEY_ID"),
		APNsTeamID: os.Getenv("APNS_TEAM_ID"),
		APNsTopic:  os.Getenv("APNS_TOPIC"),
		OIDC:       oidcCfg,
	}, nil
}

func main() {
	logger = initLogger()

	cfg, err := loadConfig()
	if err != nil {
		logger.Error("config load failed", "tag", "relay.startup", "err", err)
		os.Exit(1)
	}

	hub := NewHub()

	// Apply optional env var overrides for relay timeouts.
	if v := os.Getenv("RELAY_WRITE_TIMEOUT_MS"); v != "" {
		if ms, err := strconv.Atoi(v); err == nil && ms > 0 {
			hub.WriteTimeout = time.Duration(ms) * time.Millisecond
		}
	}
	if v := os.Getenv("RELAY_PING_INTERVAL_S"); v != "" {
		if s, err := strconv.Atoi(v); err == nil && s > 0 {
			hub.PingInterval = time.Duration(s) * time.Second
		}
	}
	if v := os.Getenv("RELAY_PING_TIMEOUT_S"); v != "" {
		if s, err := strconv.Atoi(v); err == nil && s > 0 {
			hub.PingTimeout = time.Duration(s) * time.Second
		}
	}
	if v := os.Getenv("RELAY_MAX_MESSAGE_SIZE"); v != "" {
		if n, err := strconv.ParseInt(v, 10, 64); err == nil && n > 0 {
			hub.MaxMessageSize = n
		}
	}

	auth := NewAuthMiddleware(cfg.APIKey, cfg.OIDC)

	// Channel ownership store — shared across both WebSocket routes.
	owners := newChannelOwnerStore(os.Getenv("RELAY_STATE_DIR"))

	var pusher *APNsPusher
	if cfg.APNsKey != "" && cfg.APNsKeyID != "" && cfg.APNsTeamID != "" {
		var err error
		pusher, err = NewAPNsPusher(cfg.APNsKey, cfg.APNsKeyID, cfg.APNsTeamID, cfg.APNsTopic)
		if err != nil {
			logger.Warn("APNs init failed", "tag", "relay.startup", "err", err)
		} else {
			pusher.Start()
			logger.Info("APNs push notifications enabled", "tag", "relay.startup")
		}
	}

	mux := http.NewServeMux()

	mux.HandleFunc("GET /healthz", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusOK)
		w.Write([]byte(`{"status":"ok"}`)) //nolint:errcheck // health endpoint; client hangup is irrelevant
	})

	// GET /v1/auth/config — unauthenticated; tells clients which auth modes are active.
	mux.HandleFunc("GET /v1/auth/config", func(w http.ResponseWriter, r *http.Request) {
		type authConfigResponse struct {
			OIDC          bool   `json:"oidc"`
			Issuer        string `json:"issuer,omitempty"`
			Audience      string `json:"audience,omitempty"`
			RequiredScope string `json:"requiredScope,omitempty"`
			PSK           bool   `json:"psk"`
		}
		resp := authConfigResponse{
			PSK: len(auth.apiKey) > 0,
		}
		if auth.oidc != nil {
			resp.OIDC = true
			resp.Issuer = auth.oidc.Issuer
			resp.Audience = auth.oidc.Audience
			resp.RequiredScope = auth.oidc.RequiredScope
		}
		w.Header().Set("Content-Type", "application/json")
		if err := json.NewEncoder(w).Encode(resp); err != nil {
			logger.Warn("auth config encode error", "tag", "relay.auth_config_error", "err", err)
		}
	})

	mux.HandleFunc("GET /v1/channel/{channelId}", func(w http.ResponseWriter, r *http.Request) {
		identity, ok := auth.Validate(r)
		if !ok {
			logAuthFailure(r, "invalid credential")
			http.Error(w, "unauthorized", http.StatusUnauthorized)
			return
		}

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

		// OIDC channel isolation: enforce subject-based ownership before upgrade.
		if identity != nil {
			if !owners.Bind(channelID, identity.Subject) {
				owner, _ := owners.Owner(channelID)
				logger.Warn("oidc: channel access denied — subject mismatch",
					"tag", "relay.channel.denied",
					"channel_id", channelID,
					"subject", identity.Subject,
					"owner", owner)
				http.Error(w, "forbidden: channel owned by another identity", http.StatusForbidden)
				return
			}
		}

		logAuthSuccess(identity, "psk or jwt")
		hub.HandleWebSocket(w, r, channelID, role, pusher, identity)
	})

	mux.HandleFunc("GET /v1/channel/{channelId}/status", func(w http.ResponseWriter, r *http.Request) {
		identity, ok := auth.Validate(r)
		if !ok {
			logAuthFailure(r, "invalid credential")
			http.Error(w, "unauthorized", http.StatusUnauthorized)
			return
		}

		channelID := r.PathValue("channelId")
		if !validChannelID(channelID) {
			http.Error(w, "invalid channel id", http.StatusBadRequest)
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
			if !owned || owner != identity.Subject {
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

	server := &http.Server{
		Addr:              ":" + cfg.Port,
		Handler:           mux,
		ReadHeaderTimeout: 10 * time.Second,
		IdleTimeout:       120 * time.Second,
	}

	quit := make(chan os.Signal, 1)
	signal.Notify(quit, syscall.SIGINT, syscall.SIGTERM)

	// Advertise via mDNS so iOS devices on the LAN can discover us.
	mdnsCtx, mdnsCancel := context.WithCancel(context.Background())
	mdnsHandle, err := StartMDNS(mdnsCtx, portFromString(cfg.Port, 8443))
	if err != nil {
		logger.Warn("mDNS init failed", "tag", "relay.startup", "err", err)
	}
	_ = mdnsHandle

	go func() {
		logger.Info("relay listening", "tag", "relay.startup", "port", cfg.Port)
		if err := server.ListenAndServe(); err != nil && err != http.ErrServerClosed {
			logger.Error("server error", "tag", "relay.startup", "err", err)
			os.Exit(1)
		}
	}()

	<-quit
	logger.Info("shutting down", "tag", "relay.shutdown")

	mdnsCancel()

	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	hub.CloseAll()
	if err := server.Shutdown(ctx); err != nil {
		logger.Error("shutdown error", "tag", "relay.shutdown", "err", err)
		os.Exit(1)
	}

	logger.Info("relay stopped", "tag", "relay.shutdown")
}

// logAuthSuccess emits a structured auth.success audit log entry.
func logAuthSuccess(identity *UserIdentity, method string) {
	if identity != nil {
		logger.Info("auth.success",
			"tag", "relay.auth.success",
			"method", "jwt",
			"subject", identity.Subject,
			"username", identity.Username)
	} else {
		logger.Info("auth.success",
			"tag", "relay.auth.success",
			"method", method)
	}
}

// logAuthFailure emits a structured auth.failure audit log entry.
func logAuthFailure(r *http.Request, reason string) {
	logger.Warn("auth.failure",
		"tag", "relay.auth.failure",
		"reason", reason,
		"ip", r.RemoteAddr)
}
