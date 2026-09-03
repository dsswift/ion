package main

import (
	"encoding/base64"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func writeAuthVerifyConfig(t *testing.T, body string) {
	t.Helper()
	home := t.TempDir()
	t.Setenv("HOME", home)
	dir := filepath.Join(home, ".ion")
	if err := os.MkdirAll(dir, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "engine.json"), []byte(body), 0o600); err != nil {
		t.Fatal(err)
	}
}

func TestRunAuthVerifyBearerAndProbe(t *testing.T) {
	t.Setenv("ION_VERIFY_SECRET", "secret")
	tokenServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte(`{"access_token":"opaque-token","expires_in":3600}`))
	}))
	defer tokenServer.Close()
	probe := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer opaque-token" {
			t.Errorf("Authorization = %q", r.Header.Get("Authorization"))
		}
		w.WriteHeader(http.StatusNoContent)
	}))
	defer probe.Close()
	writeAuthVerifyConfig(t, `{"auth":{"identityProvider":"machine","oauth":{"machine":{"clientId":"client","tokenUrl":"`+tokenServer.URL+`","machineIdentity":{"source":"client_secret","clientSecretEnv":"ION_VERIFY_SECRET"}}}}}`)

	report, code := runAuthVerify(map[string]string{"scope": "api/.default", "url": probe.URL})
	if code != 0 || !report.OK || report.TokenType != "bearer" || report.ExpiresAt == "" {
		t.Fatalf("report=%+v code=%d", report, code)
	}
	if report.Probe == nil || report.Probe.Status != http.StatusNoContent {
		t.Fatalf("probe=%+v", report.Probe)
	}
}

func TestRunAuthVerifySigV4(t *testing.T) {
	t.Setenv("AWS_ACCESS_KEY_ID", "AKID")
	t.Setenv("AWS_SECRET_ACCESS_KEY", "secret")
	probe := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !strings.HasPrefix(r.Header.Get("Authorization"), "AWS4-HMAC-SHA256 ") {
			t.Errorf("Authorization = %q", r.Header.Get("Authorization"))
		}
		if r.Method == http.MethodPost {
			_, _ = w.Write([]byte(`<GetCallerIdentityResponse><GetCallerIdentityResult><Account>123</Account><Arn>arn:aws:iam::123:role/test</Arn><UserId>user</UserId></GetCallerIdentityResult></GetCallerIdentityResponse>`))
			return
		}
		w.WriteHeader(http.StatusOK)
	}))
	defer probe.Close()
	writeAuthVerifyConfig(t, `{"auth":{"identityProvider":"aws","oauth":{"aws":{"machineIdentity":{"source":"aws","aws":{"kind":"env","region":"us-east-1","stsEndpoint":"`+probe.URL+`"}}}}}}`)

	report, code := runAuthVerify(map[string]string{"aws-service": "execute-api", "aws-region": "us-east-1", "url": probe.URL})
	if code != 0 || !report.OK || report.TokenType != "aws_sigv4" || report.Probe == nil {
		t.Fatalf("report=%+v code=%d", report, code)
	}
}

func TestRunAuthVerifyAcquisitionError(t *testing.T) {
	writeAuthVerifyConfig(t, `{"auth":{"identityProvider":"machine","oauth":{"machine":{"clientId":"client","tokenUrl":"http://127.0.0.1:1/token","machineIdentity":{"source":"client_secret","clientSecretFile":"/nonexistent"}}}}}`)
	report, code := runAuthVerify(map[string]string{})
	if code != 2 || report.OK || report.Error == "" {
		t.Fatalf("report=%+v code=%d", report, code)
	}
}

func TestRedactedJWTClaimsExposesOnlySafeFields(t *testing.T) {
	payload, err := json.Marshal(map[string]any{
		"iss": "issuer", "aud": "audience", "exp": time.Now().Add(time.Hour).Unix(),
		"sub": "sensitive-subject", "email": "user@example.com", "secret": "never-print",
	})
	if err != nil {
		t.Fatal(err)
	}
	token := "e30." + base64.RawURLEncoding.EncodeToString(payload) + ".sig"
	claims, expiry := redactedJWTClaims(token)
	if expiry == "" || claims["iss"] != "issuer" || claims["aud"] != "audience" {
		t.Fatalf("unexpected safe claims: %#v expiry=%q", claims, expiry)
	}
	for _, forbidden := range []string{"sub", "email", "secret"} {
		if _, ok := claims[forbidden]; ok {
			t.Fatalf("unsafe claim %q exposed", forbidden)
		}
	}
	encoded, _ := json.Marshal(claims)
	if strings.Contains(string(encoded), "never-print") || strings.Contains(string(encoded), "user@example.com") {
		t.Fatalf("unsafe claim value leaked: %s", encoded)
	}
}

func TestRunAuthVerifyNoConfig(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	report, code := runAuthVerify(map[string]string{})
	if code != 2 || report.OK || !strings.Contains(report.Error, "identityProvider") {
		t.Fatalf("report=%+v code=%d", report, code)
	}
}
