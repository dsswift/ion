package main

import (
	"fmt"
	"os"
)

// loadAPNsKey returns the .p8 key's PEM bytes and names where they came from.
//
// The key may arrive as a file (APNS_KEY_PATH, for a mounted secret) or as
// the PEM text itself (APNS_KEY, for a secret store that injects values as
// environment variables). Setting both is refused rather than resolved: the
// relay cannot know which one the operator meant, and pushing with the wrong
// team's key fails at Apple, far from the cause.
func loadAPNsKey(path, pemText string) ([]byte, string, error) {
	switch {
	case path != "" && pemText != "":
		return nil, "", fmt.Errorf("both APNS_KEY_PATH and APNS_KEY are set; set exactly one")
	case pemText != "":
		return []byte(pemText), "APNS_KEY", nil
	case path != "":
		data, err := os.ReadFile(path)
		if err != nil {
			return nil, "", fmt.Errorf("read APNS_KEY_PATH: %w", err)
		}
		return data, "APNS_KEY_PATH", nil
	default:
		return nil, "", nil
	}
}

// startAPNs builds and starts the pusher when push is configured, and logs
// which setting is missing when it is not. A relay without push drops every
// push request, so the reason must be in the startup log.
func startAPNs(cfg Config) *APNsPusher {
	key, source, err := loadAPNsKey(cfg.APNsKeyPath, cfg.APNsKeyPEM)
	if err != nil {
		logger.Warn("APNs init failed", "tag", "relay.startup", "err", err)
		return nil
	}
	var missing []string
	if key == nil {
		missing = append(missing, "APNS_KEY or APNS_KEY_PATH")
	}
	if cfg.APNsKeyID == "" {
		missing = append(missing, "APNS_KEY_ID")
	}
	if cfg.APNsTeamID == "" {
		missing = append(missing, "APNS_TEAM_ID")
	}
	if len(missing) > 0 {
		logger.Info("APNs push notifications disabled", "tag", "relay.startup", "missing", missing)
		return nil
	}
	pusher, err := NewAPNsPusher(key, cfg.APNsKeyID, cfg.APNsTeamID, cfg.APNsTopic)
	if err != nil {
		logger.Warn("APNs init failed", "tag", "relay.startup", "err", err, "key_source", source)
		return nil
	}
	pusher.Start()
	logger.Info("APNs push notifications enabled", "tag", "relay.startup",
		"key_source", source, "key_id", cfg.APNsKeyID, "team_id", cfg.APNsTeamID,
		"topic", cfg.APNsTopic, "default_endpoint", pusher.baseURL)
	return pusher
}
