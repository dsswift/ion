package main

import (
	"context"
	"log"
	"net/http"
	"os"
	"os/signal"
	"strconv"
	"syscall"
	"time"
)

type Config struct {
	Port       string
	APIKey     string
	APNsKey    string
	APNsKeyID  string
	APNsTeamID string
}

func loadConfig() Config {
	port := os.Getenv("RELAY_PORT")
	if port == "" {
		port = "8443"
	}

	apiKey := os.Getenv("RELAY_API_KEY")
	if apiKey == "" {
		log.Fatal("RELAY_API_KEY environment variable is required")
	}

	return Config{
		Port:       port,
		APIKey:     apiKey,
		APNsKey:    os.Getenv("APNS_KEY_PATH"),
		APNsKeyID:  os.Getenv("APNS_KEY_ID"),
		APNsTeamID: os.Getenv("APNS_TEAM_ID"),
	}
}

func main() {
	cfg := loadConfig()

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

	auth := NewAuthMiddleware(cfg.APIKey)

	var pusher *APNsPusher
	if cfg.APNsKey != "" && cfg.APNsKeyID != "" && cfg.APNsTeamID != "" {
		var err error
		pusher, err = NewAPNsPusher(cfg.APNsKey, cfg.APNsKeyID, cfg.APNsTeamID)
		if err != nil {
			log.Printf("APNs disabled: %v", err)
		} else {
			pusher.Start()
			log.Println("APNs push notifications enabled")
		}
	}

	mux := http.NewServeMux()

	mux.HandleFunc("GET /healthz", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte(`{"status":"ok"}`))
	})

	mux.HandleFunc("GET /v1/channel/{channelId}", func(w http.ResponseWriter, r *http.Request) {
		if !auth.Validate(r) {
			http.Error(w, "unauthorized", http.StatusUnauthorized)
			return
		}

		channelID := r.PathValue("channelId")
		role := r.URL.Query().Get("role")
		if role != "ion" && role != "mobile" {
			http.Error(w, "role must be 'ion' or 'mobile'", http.StatusBadRequest)
			return
		}

		hub.HandleWebSocket(w, r, channelID, role, pusher)
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
		log.Printf("mDNS disabled: %v", err)
	}
	_ = mdnsHandle

	go func() {
		log.Printf("relay listening on :%s", cfg.Port)
		if err := server.ListenAndServe(); err != nil && err != http.ErrServerClosed {
			log.Fatalf("server error: %v", err)
		}
	}()

	<-quit
	log.Println("shutting down...")

	mdnsCancel()

	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	hub.CloseAll()
	if err := server.Shutdown(ctx); err != nil {
		log.Fatalf("shutdown error: %v", err)
	}

	log.Println("relay stopped")
}
