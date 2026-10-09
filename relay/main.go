package main

import (
	"context"
	"fmt"
	"net/http"
	"os"
	"os/signal"
	"strconv"
	"strings"
	"syscall"
	"time"
)

// Config holds all relay server configuration.
type Config struct {
	Port        string
	APIKey      string
	APNsKeyPath string // APNS_KEY_PATH: a file holding the .p8 key
	APNsKeyPEM  string // APNS_KEY: the .p8 key's PEM text itself
	APNsKeyID   string
	APNsTeamID  string
	APNsTopic   string
	OIDC        *OIDCConfig   // primary issuer; nil in PSK-only mode
	OIDCMore    []*OIDCConfig // further accepted issuers (RELAY_OIDC_ISSUERS)
	// MetricsEnabled serves Prometheus metrics on /metrics
	// (RELAY_METRICS_ENABLED, default true).
	MetricsEnabled bool
	// PprofListen is the loopback address for net/http/pprof
	// (RELAY_PPROF_LISTEN); empty leaves profiling off.
	PprofListen string
}

func loadConfig() (Config, error) {
	port := os.Getenv("RELAY_PORT")
	if port == "" {
		port = "8443"
	}

	apiKey := os.Getenv("RELAY_API_KEY")

	// Every accepted org-wide issuer, primary first: the single-issuer
	// variables, then RELAY_OIDC_ISSUERS. A malformed list is fatal rather
	// than ignored, because an operator who listed a second tenant and got a
	// relay that silently refuses it has no way to tell from the outside.
	specs, err := parseOIDCIssuerSpecs(
		os.Getenv("RELAY_OIDC_ISSUER"),
		os.Getenv("RELAY_OIDC_AUDIENCE"),
		os.Getenv("RELAY_OIDC_REQUIRED_SCOPE"),
		os.Getenv("RELAY_OIDC_ISSUERS"),
	)
	if err != nil {
		return Config{}, fmt.Errorf("oidc config: %w", err)
	}

	// A startup JWKS failure keeps the issuer: its key set is refetched the
	// first time a token names an unknown kid, so it heals without a
	// restart. Until then every token from it is refused.
	var issuers []*OIDCConfig
	for _, spec := range specs {
		cfg, err := NewOIDCConfig(spec.Issuer, spec.Audience, spec.RequiredScope)
		if cfg == nil {
			return Config{}, fmt.Errorf("oidc issuer %q: %w", spec.Issuer, err)
		}
		if err != nil {
			logger.Error("oidc issuer accepted with no keys yet; its tokens are refused until the JWKS loads",
				"tag", "relay.startup", "issuer", spec.Issuer, "err", err)
		} else {
			logger.Info("oidc issuer enabled",
				"tag", "relay.startup", "issuer", spec.Issuer, "audience", spec.Audience, "primary", len(issuers) == 0)
		}
		issuers = append(issuers, cfg)
	}
	if len(issuers) == 0 {
		logger.Info("oidc not configured; PSK-only mode", "tag", "relay.startup")
	}

	// Require at least one auth mode.
	if apiKey == "" && len(issuers) == 0 {
		return Config{}, fmt.Errorf("no auth configured: set RELAY_API_KEY and/or RELAY_OIDC_ISSUER+RELAY_OIDC_AUDIENCE (or RELAY_OIDC_ISSUERS)")
	}

	var primary *OIDCConfig
	var more []*OIDCConfig
	if len(issuers) > 0 {
		primary, more = issuers[0], issuers[1:]
	}

	metricsEnabled := true
	if v := strings.TrimSpace(os.Getenv("RELAY_METRICS_ENABLED")); v != "" {
		b, err := strconv.ParseBool(v)
		if err != nil {
			return Config{}, fmt.Errorf("RELAY_METRICS_ENABLED=%q: %w", v, err)
		}
		metricsEnabled = b
	}

	return Config{
		Port:           port,
		APIKey:         apiKey,
		MetricsEnabled: metricsEnabled,
		PprofListen:    strings.TrimSpace(os.Getenv("RELAY_PPROF_LISTEN")),
		APNsKeyPath:    os.Getenv("APNS_KEY_PATH"),
		APNsKeyPEM:     os.Getenv("APNS_KEY"),
		APNsKeyID:      os.Getenv("APNS_KEY_ID"),
		APNsTeamID:     os.Getenv("APNS_TEAM_ID"),
		APNsTopic:      os.Getenv("APNS_TOPIC"),
		OIDC:           primary,
		OIDCMore:       more,
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
	hub.otlp = relayOTLP
	if cfg.MetricsEnabled {
		logger.Info("metrics enabled", "tag", "relay.startup", "path", metricsPath)
	} else {
		hub.metrics = nil
		logger.Info("metrics disabled (RELAY_METRICS_ENABLED=false)", "tag", "relay.startup")
	}

	pprofServer, err := startPprofListener(cfg.PprofListen)
	if err != nil {
		logger.Error("pprof listener failed", "tag", "relay.pprof", "addr", cfg.PprofListen, "err", err)
		os.Exit(1)
	}

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

	auth := NewAuthMiddleware(cfg.APIKey, cfg.OIDC, cfg.OIDCMore...)

	// An issuer the relay itself accepts is one it already fetches keys for,
	// so a host may announce it for the joining side without the operator
	// listing it a second time in RELAY_TRUSTED_ISSUERS.
	for _, issuer := range auth.issuers {
		hub.oidcRegistry.Trust(issuer)
	}
	if trusted := hub.oidcRegistry.TrustedIssuers(); len(trusted) > 0 {
		logger.Info("server-announced trust enabled", "tag", "relay.announce", "trusted_issuers", trusted)
	} else {
		logger.Info("server-announced trust disabled: no issuer is configured or listed in RELAY_TRUSTED_ISSUERS; every announced-trust join refuses with issuer_not_trusted", "tag", "relay.announce")
	}

	// Channel ownership store — shared across both WebSocket routes.
	owners := newChannelOwnerStore(os.Getenv("RELAY_STATE_DIR"))

	pusher := startAPNs(cfg)
	if pusher != nil {
		pusher.metrics = hub.metrics
	}

	mux := newRelayMux(hub, auth, owners, pusher)

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
	if pprofServer != nil {
		if err := pprofServer.Shutdown(ctx); err != nil {
			logger.Warn("pprof shutdown error", "tag", "relay.pprof", "err", err)
		}
	}
	shutdownErr := server.Shutdown(ctx)
	if shutdownErr != nil {
		logger.Error("shutdown error", "tag", "relay.shutdown", "err", shutdownErr)
	} else {
		logger.Info("relay stopped", "tag", "relay.shutdown")
	}

	// Ship what is still queued, including the lines above, within a bound
	// so a dead collector cannot hold the process open.
	flushCtx, flushCancel := context.WithTimeout(context.Background(), 5*time.Second)
	relayOTLP.Shutdown(flushCtx)
	flushCancel()

	if shutdownErr != nil {
		os.Exit(1)
	}
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
func logAuthFailure(r *http.Request, reason AuthFailureReason) {
	logger.Warn("auth.failure",
		"tag", "relay.auth.failure",
		"reason", reason,
		"ip", r.RemoteAddr)
}
