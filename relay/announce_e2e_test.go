package main

// announce_e2e_test.go — end-to-end tests for server-announced trust
// (manifest C7) driven over real WebSocket connections against a mux that
// mirrors main.go's actual routing (including the announced-trust branch),
// not just the Hub in isolation. Covers: announce round-trip, untrusted
// issuer refused with 403, no-announce channels behave exactly as before,
// status is gated identically to join, pairing expiry and single use, and
// no channel-listing endpoint exists.

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/coder/websocket"
)

// startAnnounceTestRelay serves the relay's production routes
// (newRelayMux), so these tests exercise the code main() runs.
func startAnnounceTestRelay(t *testing.T, apiKey, trustedIssuers string) (*httptest.Server, *Hub) {
	t.Helper()
	return startRoutedTestRelay(t, NewAuthMiddleware(apiKey, nil), trustedIssuers)
}

// startRoutedTestRelay serves the production routes behind auth. Every issuer auth
// accepts is trusted for announcement, as main() arranges.
func startRoutedTestRelay(t *testing.T, auth *AuthMiddleware, trustedIssuers string) (*httptest.Server, *Hub) {
	t.Helper()
	hub := NewHub()
	hub.oidcRegistry = NewOIDCRegistry(trustedIssuers)
	for _, issuer := range auth.issuers {
		hub.oidcRegistry.Trust(issuer)
	}

	server := httptest.NewServer(newRelayMux(hub, auth, newChannelOwnerStore(""), nil))
	t.Cleanup(func() {
		hub.CloseAll()
		server.Close()
	})
	return server, hub
}

// dialIonWithAnnounce dials the ion role and immediately sends a
// relay_announce as its first frame.
func dialIonWithAnnounce(t *testing.T, server *httptest.Server, channelID, apiKey string, announce map[string]any) *websocket.Conn {
	t.Helper()
	url := "ws" + strings.TrimPrefix(server.URL, "http") + "/v1/channel/" + channelID + "?role=ion"
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	conn, _, err := websocket.Dial(ctx, url, &websocket.DialOptions{
		HTTPHeader:      http.Header{"Authorization": []string{"Bearer " + apiKey}},
		CompressionMode: websocket.CompressionContextTakeover,
	})
	if err != nil {
		t.Fatalf("dial ion failed: %v", err)
	}
	t.Cleanup(func() { conn.CloseNow() })

	frame, err := json.Marshal(announce)
	if err != nil {
		t.Fatalf("marshal announce: %v", err)
	}
	if err := conn.Write(context.Background(), websocket.MessageText, frame); err != nil {
		t.Fatalf("write announce: %v", err)
	}
	return conn
}

func dialMobileWithBearer(t *testing.T, server *httptest.Server, channelID, bearer string) (*websocket.Conn, *http.Response, error) {
	t.Helper()
	url := "ws" + strings.TrimPrefix(server.URL, "http") + "/v1/channel/" + channelID + "?role=mobile"
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	conn, resp, err := websocket.Dial(ctx, url, &websocket.DialOptions{
		HTTPHeader: http.Header{"Authorization": []string{"Bearer " + bearer}},
	})
	if err != nil {
		return conn, resp, err
	}
	t.Cleanup(func() { conn.CloseNow() })
	// Mobile always receives a relay:connected control frame immediately
	// after upgrade (relay.go), before any forwarded application data.
	ready := readExpected(t, conn, "mobile-ready")
	if !strings.Contains(string(ready), "relay:connected") {
		t.Fatalf("expected relay:connected, got: %s", ready)
	}
	return conn, resp, nil
}

// TestAnnounce_RoundTrip_MobileJoinsWithAnnouncedIssuer proves the full
// path: ion announces an issuer/audience, a fixture-signed bearer for that
// audience is accepted as the mobile role, and messages forward normally.
func TestAnnounce_RoundTrip_MobileJoinsWithAnnouncedIssuer(t *testing.T) {
	key := genRSAKey(t)
	oidcSrv := startFakeOIDCServer(t, &key.PublicKey)

	server, _ := startAnnounceTestRelay(t, "psk-not-used-here", oidcSrv.URL)

	ionConn := dialIonWithAnnounce(t, server, "chan-announce-1", "psk-not-used-here", map[string]any{
		"type": "relay_announce",
		"trust": map[string]any{
			"issuer":   oidcSrv.URL,
			"audience": "announced-aud",
		},
	})

	tokenStr := makeJWT(t, key, standardClaims(oidcSrv.URL, "announced-aud"))
	mobileConn, _, err := dialMobileWithBearer(t, server, "chan-announce-1", tokenStr)
	if err != nil {
		t.Fatalf("mobile dial with announced-trust bearer failed: %v", err)
	}

	ionConn.Write(context.Background(), websocket.MessageText, []byte(`{"msg":"hello"}`)) //nolint:errcheck
	data := readExpected(t, mobileConn, "mobile")
	if string(data) != `{"msg":"hello"}` {
		t.Errorf("mobile got: %s, want the ion message (announce frame must not be forwarded)", data)
	}
}

// TestAnnounce_UntrustedIssuerRefused403 proves a mobile join whose
// announced issuer is not in RELAY_TRUSTED_ISSUERS is refused with 403.
func TestAnnounce_UntrustedIssuerRefused403(t *testing.T) {
	key := genRSAKey(t)
	oidcSrv := startFakeOIDCServer(t, &key.PublicKey)

	// Note: RELAY_TRUSTED_ISSUERS is empty -- oidcSrv.URL is NOT trusted.
	server, _ := startAnnounceTestRelay(t, "psk", "")

	dialIonWithAnnounce(t, server, "chan-untrusted", "psk", map[string]any{
		"type": "relay_announce",
		"trust": map[string]any{
			"issuer":   oidcSrv.URL,
			"audience": "announced-aud",
		},
	})

	tokenStr := makeJWT(t, key, standardClaims(oidcSrv.URL, "announced-aud"))
	_, resp, err := dialMobileWithBearer(t, server, "chan-untrusted", tokenStr)
	if err == nil {
		t.Fatal("expected dial to fail (403), got success")
	}
	if resp == nil || resp.StatusCode != http.StatusForbidden {
		status := 0
		if resp != nil {
			status = resp.StatusCode
		}
		t.Errorf("status = %d, want %d", status, http.StatusForbidden)
	}
}

// TestAnnounce_NoAnnouncementUnchanged proves a channel with no
// announcement behaves exactly as before: a PSK-bearing mobile join
// succeeds via the ordinary org-wide path.
func TestAnnounce_NoAnnouncementUnchanged(t *testing.T) {
	server, _ := startAnnounceTestRelay(t, "org-psk", "")

	url := "ws" + strings.TrimPrefix(server.URL, "http") + "/v1/channel/chan-no-announce?role=ion"
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	ionConn, _, err := websocket.Dial(ctx, url, &websocket.DialOptions{
		HTTPHeader: http.Header{"Authorization": []string{"Bearer org-psk"}},
	})
	if err != nil {
		t.Fatalf("ion dial: %v", err)
	}
	t.Cleanup(func() { ionConn.CloseNow() })

	mobileConn, _, err := dialMobileWithBearer(t, server, "chan-no-announce", "org-psk")
	if err != nil {
		t.Fatalf("mobile dial with org PSK on an unannounced channel failed: %v", err)
	}

	ionConn.Write(context.Background(), websocket.MessageText, []byte(`{"msg":"unchanged"}`)) //nolint:errcheck
	data := readExpected(t, mobileConn, "mobile")
	if string(data) != `{"msg":"unchanged"}` {
		t.Errorf("mobile got: %s", data)
	}
}

// TestAnnounce_StatusGatedLikeJoin proves GET .../status applies the same
// announced-trust check as join: an untrusted-issuer bearer is refused.
func TestAnnounce_StatusGatedLikeJoin(t *testing.T) {
	key := genRSAKey(t)
	oidcSrv := startFakeOIDCServer(t, &key.PublicKey)
	server, _ := startAnnounceTestRelay(t, "psk", "") // untrusted

	dialIonWithAnnounce(t, server, "chan-status", "psk", map[string]any{
		"type":  "relay_announce",
		"trust": map[string]any{"issuer": oidcSrv.URL, "audience": "aud"},
	})

	tokenStr := makeJWT(t, key, standardClaims(oidcSrv.URL, "aud"))
	req, _ := http.NewRequest(http.MethodGet, server.URL+"/v1/channel/chan-status/status", nil)
	req.Header.Set("Authorization", "Bearer "+tokenStr)
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("status request: %v", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusUnauthorized {
		t.Errorf("status = %d, want %d (untrusted issuer)", resp.StatusCode, http.StatusUnauthorized)
	}
}

// TestAnnounce_PairingExpiryAndSingleUse proves a pairing channel refuses a
// join after its 5-minute expiry and after its single permitted use.
func TestAnnounce_PairingExpiryAndSingleUse(t *testing.T) {
	key := genRSAKey(t)
	oidcSrv := startFakeOIDCServer(t, &key.PublicKey)
	server, hub := startAnnounceTestRelay(t, "psk", oidcSrv.URL)

	// Pre-seed an expired pairing channel directly (simulating a channel
	// announced 6 minutes ago) to test the expiry arm without a real sleep.
	hub.trust.Set("pairing:expired", ChannelTrust{
		Issuer: oidcSrv.URL, Audience: "aud", Pairing: true,
		ExpiresAt: time.Now().Add(-time.Minute),
	})
	tokenStr := makeJWT(t, key, standardClaims(oidcSrv.URL, "aud"))
	_, resp, err := dialMobileWithBearer(t, server, "pairing:expired", tokenStr)
	if err == nil {
		t.Fatal("expected expired pairing channel join to fail")
	}
	if resp == nil || resp.StatusCode != http.StatusGone {
		status := 0
		if resp != nil {
			status = resp.StatusCode
		}
		t.Errorf("expired pairing status = %d, want %d", status, http.StatusGone)
	}

	// A fresh pairing channel: first join succeeds, second is refused.
	dialIonWithAnnounce(t, server, "pairing:fresh", "psk", map[string]any{
		"type":  "relay_announce",
		"trust": map[string]any{"pairing": true, "expiresAt": time.Now().Add(5 * time.Minute).UnixMilli()},
	})

	firstConn, _, err := dialMobileWithBearer(t, server, "pairing:fresh", tokenStr)
	if err != nil {
		t.Fatalf("first pairing join failed: %v", err)
	}
	firstConn.CloseNow() //nolint:errcheck

	_, resp2, err := dialMobileWithBearer(t, server, "pairing:fresh", tokenStr)
	if err == nil {
		t.Fatal("expected second pairing join to fail (single use)")
	}
	if resp2 == nil || resp2.StatusCode != http.StatusGone {
		status := 0
		if resp2 != nil {
			status = resp2.StatusCode
		}
		t.Errorf("second join status = %d, want %d", status, http.StatusGone)
	}
}

// TestAnnounce_NoListingEndpoint proves no channel-listing route exists on
// the relay's real mux (manifest C7: "No listing endpoint exists"). Only
// "/v1/channels" (plural) is checked -- "/v1/channel/<anything>" legitimately
// matches the join route's {channelId} wildcard segment, so a path under
// that prefix is not evidence either way.
func TestAnnounce_NoListingEndpoint(t *testing.T) {
	server, _ := startAnnounceTestRelay(t, "psk", "")

	resp, err := http.Get(server.URL + "/v1/channels")
	if err != nil {
		t.Fatalf("GET /v1/channels: %v", err)
	}
	resp.Body.Close()
	if resp.StatusCode != http.StatusNotFound {
		t.Errorf("GET /v1/channels = %d, want 404 (no listing endpoint should exist)", resp.StatusCode)
	}
}
