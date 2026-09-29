package main

import (
	"context"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"
)

// clearWorkloadIdentityEnv blanks the webhook-injected Azure variables so a
// test host running under workload identity cannot change mode selection.
func clearWorkloadIdentityEnv(t *testing.T) {
	t.Helper()
	for _, k := range []string{"AZURE_FEDERATED_TOKEN_FILE", "AZURE_CLIENT_ID", "AZURE_TENANT_ID", "AZURE_AUTHORITY_HOST"} {
		t.Setenv(k, "")
	}
}

// assertionTokenServer records the form of every token request.
type assertionTokenServer struct {
	mu    sync.Mutex
	forms []map[string]string
	srv   *httptest.Server
}

func newAssertionTokenServer(t *testing.T) *assertionTokenServer {
	t.Helper()
	ts := &assertionTokenServer{}
	ts.srv = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if err := r.ParseForm(); err != nil {
			t.Errorf("parse token form: %v", err)
		}
		form := map[string]string{}
		for k := range r.PostForm {
			form[k] = r.PostForm.Get(k)
		}
		ts.mu.Lock()
		ts.forms = append(ts.forms, form)
		n := len(ts.forms)
		ts.mu.Unlock()
		w.Header().Set("Content-Type", "application/json")
		fmt.Fprintf(w, `{"access_token":"fed-%d","expires_in":3600}`, n)
	}))
	t.Cleanup(ts.srv.Close)
	return ts
}

func (ts *assertionTokenServer) requests() []map[string]string {
	ts.mu.Lock()
	defer ts.mu.Unlock()
	return append([]map[string]string(nil), ts.forms...)
}

func TestOTLPFederatedTokenPostsAssertionAndRereadsRotatedFile(t *testing.T) {
	col := newOTLPCollector(t)
	tok := newAssertionTokenServer(t)
	file := filepath.Join(t.TempDir(), "azure-identity-token")
	if err := os.WriteFile(file, []byte("sa-jwt-one\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	s, _ := newTestShipper(t, otlpConfig{
		Endpoint: col.srv.URL, AuthMode: otlpAuthFederated, TokenURL: tok.srv.URL,
		ClientID: "wi-client", FederatedTokenFile: file, Scope: "api://aud/.default",
	})
	now := time.Now()
	s.tokens.now = func() time.Time { return now }

	s.Write([]byte(`{"level":"INFO","msg":"a","component":"relay","tag":"t","fields":{}}` + "\n"))
	s.Flush(context.Background())

	// The kubelet rotates the projected token; the next fetch must send the new one.
	if err := os.WriteFile(file, []byte("sa-jwt-two"), 0o600); err != nil {
		t.Fatal(err)
	}
	now = now.Add(3600*time.Second - otlpTokenRefreshSkew + time.Second)
	s.Write([]byte(`{"level":"INFO","msg":"b","component":"relay","tag":"t","fields":{}}` + "\n"))
	s.Flush(context.Background())

	forms := tok.requests()
	if len(forms) != 2 {
		t.Fatalf("token requests = %d, want 2", len(forms))
	}
	for i, want := range []string{"sa-jwt-one", "sa-jwt-two"} {
		f := forms[i]
		if f["grant_type"] != "client_credentials" || f["client_id"] != "wi-client" ||
			f["scope"] != "api://aud/.default" ||
			f["client_assertion_type"] != otlpJWTBearerAssertionType ||
			f["client_assertion"] != want {
			t.Fatalf("token request %d form = %v, want assertion %q", i, f, want)
		}
		if _, ok := f["client_secret"]; ok {
			t.Fatalf("federated request %d carried a client_secret", i)
		}
	}
	reqs := col.requests()
	if len(reqs) != 2 || reqs[0].Auth != "Bearer fed-1" || reqs[1].Auth != "Bearer fed-2" {
		t.Fatalf("export auth headers = %+v", reqs)
	}
}

func TestOTLPFederatedTokenFailureIsLogged(t *testing.T) {
	col := newOTLPCollector(t)
	tok := newAssertionTokenServer(t)
	s, local := newTestShipper(t, otlpConfig{
		Endpoint: col.srv.URL, AuthMode: otlpAuthFederated, TokenURL: tok.srv.URL,
		ClientID: "wi-client", FederatedTokenFile: filepath.Join(t.TempDir(), "missing"),
		Scope: "api://aud/.default",
	})
	s.Write([]byte(`{"level":"INFO","msg":"a","component":"relay","tag":"t","fields":{}}` + "\n"))
	s.Flush(context.Background())
	s.Flush(context.Background())

	out := string(local.Bytes())
	if got := strings.Count(out, `"msg":"otlp: token request failed"`); got != 2 {
		t.Fatalf("token failure lines = %d, want one per attempt (2):\n%s", got, out)
	}
	if !strings.Contains(out, `"auth_mode":"federated_token"`) {
		t.Fatalf("token failure line missing auth_mode:\n%s", out)
	}
	if len(tok.requests()) != 0 || len(col.requests()) != 0 {
		t.Fatal("no request should leave while the assertion file is unreadable")
	}
	if s.logs.len() != 1 {
		t.Fatalf("batch should be requeued, queue len %d", s.logs.len())
	}
}

func TestOTLPConfigModeSelection(t *testing.T) {
	cases := []struct {
		name    string
		env     map[string]string
		want    otlpAuthMode
		wantURL string
		wantCID string
		wantErr bool
	}{
		{name: "no auth", want: otlpAuthNone},
		{
			name: "secret",
			env: map[string]string{"RELAY_OTLP_TOKEN_URL": "https://login.example.org/t/token",
				"RELAY_OTLP_CLIENT_ID": "cid", "RELAY_OTLP_CLIENT_SECRET": "secret"},
			want: otlpAuthSecret, wantURL: "https://login.example.org/t/token", wantCID: "cid",
		},
		{
			name: "federated derives the Entra token URL",
			env: map[string]string{"AZURE_FEDERATED_TOKEN_FILE": "/var/run/token",
				"AZURE_CLIENT_ID": "wi-client", "AZURE_TENANT_ID": "tenant-1",
				"AZURE_AUTHORITY_HOST": "https://login.microsoftonline.com/", "RELAY_OTLP_SCOPE": "api://aud/.default"},
			want: otlpAuthFederated, wantURL: "https://login.microsoftonline.com/tenant-1/oauth2/v2.0/token", wantCID: "wi-client",
		},
		{
			name: "federated wins over a secret and keeps an explicit token URL",
			env: map[string]string{"AZURE_FEDERATED_TOKEN_FILE": "/var/run/token",
				"AZURE_CLIENT_ID": "wi-client", "RELAY_OTLP_SCOPE": "api://aud/.default",
				"RELAY_OTLP_TOKEN_URL": "https://login.example.org/t/token",
				"RELAY_OTLP_CLIENT_ID": "cid", "RELAY_OTLP_CLIENT_SECRET": "secret"},
			want: otlpAuthFederated, wantURL: "https://login.example.org/t/token", wantCID: "wi-client",
		},
		{
			name: "federated without client id",
			env: map[string]string{"AZURE_FEDERATED_TOKEN_FILE": "/var/run/token",
				"AZURE_TENANT_ID": "tenant-1", "RELAY_OTLP_SCOPE": "api://aud/.default"},
			wantErr: true,
		},
		{
			name: "federated without tenant or token URL",
			env: map[string]string{"AZURE_FEDERATED_TOKEN_FILE": "/var/run/token",
				"AZURE_CLIENT_ID": "wi-client", "RELAY_OTLP_SCOPE": "api://aud/.default"},
			wantErr: true,
		},
		{
			name: "federated without scope",
			env: map[string]string{"AZURE_FEDERATED_TOKEN_FILE": "/var/run/token",
				"AZURE_CLIENT_ID": "wi-client", "AZURE_TENANT_ID": "tenant-1"},
			wantErr: true,
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			clearWorkloadIdentityEnv(t)
			for _, k := range []string{"RELAY_OTLP_TOKEN_URL", "RELAY_OTLP_CLIENT_ID", "RELAY_OTLP_CLIENT_SECRET", "RELAY_OTLP_SCOPE"} {
				t.Setenv(k, "")
			}
			t.Setenv("RELAY_OTLP_ENDPOINT", "https://collector.example.org")
			for k, v := range tc.env {
				t.Setenv(k, v)
			}
			cfg, ok, err := otlpConfigFromEnv()
			if tc.wantErr {
				if err == nil || ok {
					t.Fatalf("want config error, got ok=%v cfg=%+v", ok, cfg)
				}
				return
			}
			if err != nil || !ok {
				t.Fatalf("ok=%v err=%v", ok, err)
			}
			if cfg.AuthMode != tc.want || cfg.TokenURL != tc.wantURL || cfg.ClientID != tc.wantCID {
				t.Fatalf("cfg = %+v, want mode %s url %q client %q", cfg, tc.want, tc.wantURL, tc.wantCID)
			}
			if tc.want == otlpAuthFederated && cfg.ClientSecret != "" {
				t.Fatal("federated config carried a client secret")
			}
			if _, set := os.LookupEnv("RELAY_OTLP_CLIENT_SECRET"); set {
				t.Fatal("client secret left in the environment")
			}
		})
	}
}
