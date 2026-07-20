package webhooks

import (
	"bytes"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/dsswift/ion/engine/internal/asyncreg"
	"github.com/dsswift/ion/engine/internal/extension"
)

func TestVerifyHmacSha256(t *testing.T) {
	secret := []byte("topsecret")
	body := []byte(`{"hello":"world"}`)
	mac := hmac.New(sha256.New, secret)
	mac.Write(body)
	sig := hex.EncodeToString(mac.Sum(nil))

	cases := []struct {
		name   string
		header string
		want   bool
	}{
		{"bare hex matches", sig, true},
		{"sha256= prefix matches", "sha256=" + sig, true},
		{"sha256= prefix case insensitive", "SHA256=" + sig, true},
		{"wrong sig", "0000" + sig[4:], false},
		{"empty header", "", false},
		{"non-hex", "not-hex-data", false},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			got := verifyHmacSha256(body, secret, c.header)
			if got != c.want {
				t.Fatalf("verifyHmacSha256(%q) = %v, want %v", c.header, got, c.want)
			}
		})
	}
}

func TestAuthenticate_None(t *testing.T) {
	r := httptest.NewRequest("POST", "/x", nil)
	if err := authenticate(extension.WebhookAuth{Kind: extension.AuthNone}, r, nil, func() string { return "" }); err != nil {
		t.Fatalf("none auth must succeed: %v", err)
	}
}

func TestAuthenticate_Bearer(t *testing.T) {
	tok := "abc123"
	resolve := func() string { return tok }
	t.Run("matching token succeeds", func(t *testing.T) {
		r := httptest.NewRequest("POST", "/x", nil)
		r.Header.Set("Authorization", "Bearer "+tok)
		if err := authenticate(extension.WebhookAuth{Kind: extension.AuthBearer, TokenRefName: "T"}, r, nil, resolve); err != nil {
			t.Fatalf("bearer auth failed: %v", err)
		}
	})
	t.Run("wrong token fails", func(t *testing.T) {
		r := httptest.NewRequest("POST", "/x", nil)
		r.Header.Set("Authorization", "Bearer wrong")
		err := authenticate(extension.WebhookAuth{Kind: extension.AuthBearer, TokenRefName: "T"}, r, nil, resolve)
		if err == nil {
			t.Fatal("expected auth failure for wrong token")
		}
		if err.Status != http.StatusUnauthorized {
			t.Fatalf("expected 401, got %d", err.Status)
		}
	})
	t.Run("missing header fails", func(t *testing.T) {
		r := httptest.NewRequest("POST", "/x", nil)
		if err := authenticate(extension.WebhookAuth{Kind: extension.AuthBearer, TokenRefName: "T"}, r, nil, resolve); err == nil {
			t.Fatal("expected auth failure for missing header")
		}
	})
	t.Run("empty resolved token rejects every request", func(t *testing.T) {
		r := httptest.NewRequest("POST", "/x", nil)
		r.Header.Set("Authorization", "Bearer something")
		empty := func() string { return "" }
		err := authenticate(extension.WebhookAuth{Kind: extension.AuthBearer, TokenRefName: "T"}, r, nil, empty)
		if err == nil {
			t.Fatal("expected auth failure when token is empty")
		}
	})
}

func TestAuthenticate_SharedSecret(t *testing.T) {
	resolve := func() string { return "shh" }
	auth := extension.WebhookAuth{Kind: extension.AuthSharedSecret, HeaderName: "X-Secret", TokenRefName: "T"}
	t.Run("matching header succeeds", func(t *testing.T) {
		r := httptest.NewRequest("POST", "/x", nil)
		r.Header.Set("X-Secret", "shh")
		if err := authenticate(auth, r, nil, resolve); err != nil {
			t.Fatalf("shared-secret auth failed: %v", err)
		}
	})
	t.Run("wrong header fails 401", func(t *testing.T) {
		r := httptest.NewRequest("POST", "/x", nil)
		r.Header.Set("X-Secret", "wrong")
		err := authenticate(auth, r, nil, resolve)
		if err == nil || err.Status != http.StatusUnauthorized {
			t.Fatalf("expected 401, got %v", err)
		}
	})
}

func TestAuthenticate_Hmac(t *testing.T) {
	secret := "key"
	body := []byte("body content")
	mac := hmac.New(sha256.New, []byte(secret))
	mac.Write(body)
	sig := hex.EncodeToString(mac.Sum(nil))

	auth := extension.WebhookAuth{Kind: extension.AuthHmacSignature, HeaderName: "X-Sig", Algorithm: "sha256", TokenRefName: "T"}
	resolve := func() string { return secret }

	t.Run("valid sig succeeds", func(t *testing.T) {
		r := httptest.NewRequest("POST", "/x", bytes.NewReader(body))
		r.Header.Set("X-Sig", sig)
		if err := authenticate(auth, r, body, resolve); err != nil {
			t.Fatalf("hmac valid sig rejected: %v", err)
		}
	})
	t.Run("invalid sig fails 403", func(t *testing.T) {
		r := httptest.NewRequest("POST", "/x", bytes.NewReader(body))
		r.Header.Set("X-Sig", "0000"+sig[4:])
		err := authenticate(auth, r, body, resolve)
		if err == nil || err.Status != http.StatusForbidden {
			t.Fatalf("expected 403, got %v", err)
		}
	})
	t.Run("missing header fails", func(t *testing.T) {
		r := httptest.NewRequest("POST", "/x", bytes.NewReader(body))
		err := authenticate(auth, r, body, resolve)
		if err == nil {
			t.Fatal("expected auth failure for missing header")
		}
	})
}

func TestReadBodyCapped(t *testing.T) {
	t.Run("under cap returns body", func(t *testing.T) {
		body := strings.NewReader("hello")
		got, err := readBodyCapped(noopCloser{body}, 100)
		if err != nil {
			t.Fatalf("unexpected error: %v", err)
		}
		if string(got) != "hello" {
			t.Fatalf("got %q, want %q", string(got), "hello")
		}
	})
	t.Run("at cap returns body", func(t *testing.T) {
		body := strings.NewReader("12345")
		got, err := readBodyCapped(noopCloser{body}, 5)
		if err != nil {
			t.Fatalf("expected success at exactly cap, got %v", err)
		}
		if string(got) != "12345" {
			t.Fatalf("got %q", string(got))
		}
	})
	t.Run("over cap errors", func(t *testing.T) {
		body := strings.NewReader("12345678")
		_, err := readBodyCapped(noopCloser{body}, 5)
		if err == nil {
			t.Fatal("expected over-cap error")
		}
	})
	t.Run("zero cap means unlimited", func(t *testing.T) {
		body := strings.NewReader("anything goes")
		got, err := readBodyCapped(noopCloser{body}, 0)
		if err != nil || string(got) != "anything goes" {
			t.Fatalf("unlimited mode broke: err=%v got=%q", err, got)
		}
	})
}

type noopCloser struct{ *strings.Reader }

func (noopCloser) Close() error { return nil }

func TestDecodeHandlerResponse(t *testing.T) {
	cases := []struct {
		name  string
		in    string
		ws    int
		wb    string
	}{
		{"null is 200 empty", "null", 200, ""},
		{"empty is 200 empty", "", 200, ""},
		{"structured 200", `{"status":200,"body":"ok"}`, 200, "ok"},
		{"structured 201 with body", `{"status":201,"body":"created"}`, 201, "created"},
		{"missing status defaults 200", `{"body":"x"}`, 200, "x"},
		{"non-object body becomes 200 raw", `"plain string"`, 200, `"plain string"`},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			s, b, _ := decodeHandlerResponse([]byte(c.in))
			if s != c.ws || b != c.wb {
				t.Fatalf("got status=%d body=%q, want status=%d body=%q", s, b, c.ws, c.wb)
			}
		})
	}
}

func TestServer_StartStopOnEphemeralPort(t *testing.T) {
	s := New(Config{Port: 0, BindInterface: "127.0.0.1"})
	if err := s.Start(); err != nil {
		t.Fatalf("Start: %v", err)
	}
	defer s.Stop()
	addr := s.Addr()
	if addr == "" {
		t.Fatal("Addr() empty after Start")
	}
	// Sanity: bind succeeded and the port is reachable.
	resp, err := http.Get("http://" + addr + "/unknown")
	if err != nil {
		t.Fatalf("GET against running server failed: %v", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusNotFound {
		t.Fatalf("expected 404 for unknown path, got %d", resp.StatusCode)
	}
}

func TestServer_ConfigResolvesDefaults(t *testing.T) {
	c := Config{}.resolved()
	if c.Port != DefaultPort {
		t.Fatalf("Port=%d want %d", c.Port, DefaultPort)
	}
	if c.BindInterface != DefaultBindInterface {
		t.Fatalf("BindInterface=%s want %s", c.BindInterface, DefaultBindInterface)
	}
	if c.DefaultMaxBodyBytes != DefaultMaxBodyBytes {
		t.Fatalf("DefaultMaxBodyBytes=%d want %d", c.DefaultMaxBodyBytes, DefaultMaxBodyBytes)
	}
	if c.FireTimeout != DefaultFireTimeout {
		t.Fatalf("FireTimeout=%s want %s", c.FireTimeout, DefaultFireTimeout)
	}
}

// TestServer_NilContextResolve_SkipsWithoutPanic pins the guard against the
// SessionResolver (nil, nil) contract in the webhook HTTP handler. A resolver
// returning a nil context with a nil error must produce a 503 "session not
// available", NOT a panic from an unguarded err.Error(). serveHTTP is called
// directly with an httptest recorder, so a panic on this branch fails the test.
func TestServer_NilContextResolve_SkipsWithoutPanic(t *testing.T) {
	h := extension.NewHost()
	h.SetNameForTest("ion-dev")
	route := extension.WebhookRoute{
		Path:   "/hook",
		Method: "POST",
		Auth:   extension.WebhookAuth{Kind: extension.AuthNone},
	}
	if err := h.RegisterWebhookDecl(route, asyncreg.OriginInit); err != nil {
		t.Fatalf("register webhook: %v", err)
	}

	s := New(Config{})
	s.AddHost(h)
	// Resolver returns (nil, nil): the exact shape that nil-derefs an unguarded
	// err.Error().
	s.SetSessionResolver(func(_ *extension.Host) (*extension.Context, error) { return nil, nil })

	r := httptest.NewRequest("POST", "/hook", nil)
	w := httptest.NewRecorder()
	s.serveHTTP(w, r) // must not panic

	if w.Code != http.StatusServiceUnavailable {
		t.Fatalf("expected 503 on nil-context resolve, got %d", w.Code)
	}
}
