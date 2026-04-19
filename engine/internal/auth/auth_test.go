package auth

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/dsswift/ion/engine/internal/types"
)

// --- Resolver tests ---

func TestResolver_ResolveKey_EnvVar(t *testing.T) {
	tests := []struct {
		name     string
		provider string
		envVar   string
		envValue string
	}{
		{"anthropic", "anthropic", "ANTHROPIC_API_KEY", "sk-ant-test-123"},
		{"openai", "openai", "OPENAI_API_KEY", "sk-openai-test-456"},
		{"google", "google", "GOOGLE_API_KEY", "goog-test-789"},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Setenv(tt.envVar, tt.envValue)
			r := NewResolver(nil)

			key, err := r.ResolveKey(tt.provider)
			if err != nil {
				t.Fatalf("unexpected error: %v", err)
			}
			if key != tt.envValue {
				t.Fatalf("expected %q, got %q", tt.envValue, key)
			}
		})
	}
}

// --- All provider env var patterns ---

func TestResolver_ResolveKey_AllProviderEnvVars(t *testing.T) {
	tests := []struct {
		name     string
		provider string
		envVar   string
		envValue string
	}{
		{"azure primary", "azure", "AZURE_OPENAI_API_KEY", "az-key-1"},
		{"azure fallback", "azure", "AZURE_API_KEY", "az-key-2"},
		{"mistral", "mistral", "MISTRAL_API_KEY", "mis-key-1"},
		{"cohere", "cohere", "COHERE_API_KEY", "co-key-1"},
		{"groq", "groq", "GROQ_API_KEY", "groq-key-1"},
		{"aws", "aws", "AWS_ACCESS_KEY_ID", "aws-key-1"},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Setenv(tt.envVar, tt.envValue)
			r := NewResolver(nil)

			key, err := r.ResolveKey(tt.provider)
			if err != nil {
				t.Fatalf("unexpected error: %v", err)
			}
			if key != tt.envValue {
				t.Fatalf("expected %q, got %q", tt.envValue, key)
			}
		})
	}
}

func TestResolver_ResolveKey_AzureFallback(t *testing.T) {
	// AZURE_OPENAI_API_KEY not set, but AZURE_API_KEY is
	t.Setenv("AZURE_OPENAI_API_KEY", "")
	t.Setenv("AZURE_API_KEY", "az-fallback-key")

	r := NewResolver(nil)
	key, err := r.ResolveKey("azure")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if key != "az-fallback-key" {
		t.Fatalf("expected az-fallback-key, got %q", key)
	}
}

func TestResolver_ResolveKey_GenericUnknownProvider(t *testing.T) {
	// Tests that providers not in the known list still resolve via UPPER_API_KEY pattern
	t.Setenv("MYCUSTOM_API_KEY", "custom-key-999")
	r := NewResolver(nil)

	key, err := r.ResolveKey("mycustom")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if key != "custom-key-999" {
		t.Fatalf("expected custom-key-999, got %q", key)
	}
}

func TestResolver_ResolveKey_EmptyProvider(t *testing.T) {
	t.Setenv("_API_KEY", "")
	t.Setenv("HOME", t.TempDir())

	r := NewResolver(nil)
	_, err := r.ResolveKey("")
	if err == nil {
		t.Fatal("expected error for empty provider")
	}
}

func TestResolver_ResolveKey_EmptyEnvVar(t *testing.T) {
	// Set env var to empty string; should not resolve
	t.Setenv("ANTHROPIC_API_KEY", "")
	t.Setenv("HOME", t.TempDir())

	r := NewResolver(nil)
	_, err := r.ResolveKey("anthropic")
	if err == nil {
		t.Fatal("expected error when env var is empty")
	}
}

func TestResolver_ResolveKey_GenericEnvVar(t *testing.T) {
	t.Setenv("CUSTOM_API_KEY", "custom-key-123")
	r := NewResolver(nil)

	key, err := r.ResolveKey("custom")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if key != "custom-key-123" {
		t.Fatalf("expected custom-key-123, got %q", key)
	}
}

func TestResolver_ResolveKey_CredentialsFile(t *testing.T) {
	// Create temp credentials file
	dir := t.TempDir()
	ionDir := filepath.Join(dir, ".ion")
	os.MkdirAll(ionDir, 0o700)

	creds := map[string]string{
		"anthropic": "sk-from-file-123",
	}
	data, _ := json.Marshal(creds)
	os.WriteFile(filepath.Join(ionDir, "credentials.json"), data, 0o644)

	// Override HOME to use our temp dir
	t.Setenv("HOME", dir)

	// Clear any env vars that would match first
	t.Setenv("ANTHROPIC_API_KEY", "")

	r := NewResolver(nil)
	key, err := r.ResolveKey("anthropic")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if key != "sk-from-file-123" {
		t.Fatalf("expected sk-from-file-123, got %q", key)
	}
}

func TestResolver_ResolveKey_NotFound(t *testing.T) {
	// Clear all potential env vars
	t.Setenv("UNKNOWN_PROVIDER_API_KEY", "")
	t.Setenv("HOME", t.TempDir()) // Empty home dir

	r := NewResolver(nil)
	_, err := r.ResolveKey("unknown_provider")
	if err == nil {
		t.Fatal("expected error for unknown provider with no key")
	}
}

func TestResolver_ResolveKey_CaseInsensitive(t *testing.T) {
	t.Setenv("ANTHROPIC_API_KEY", "sk-case-test")
	r := NewResolver(nil)

	key, err := r.ResolveKey("Anthropic")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if key != "sk-case-test" {
		t.Fatalf("expected sk-case-test, got %q", key)
	}
}

func TestResolver_ResolveKey_EnvVarPriority(t *testing.T) {
	// Both env var and credentials file exist; env var should win
	dir := t.TempDir()
	ionDir := filepath.Join(dir, ".ion")
	os.MkdirAll(ionDir, 0o700)

	creds := map[string]string{"anthropic": "sk-from-file"}
	data, _ := json.Marshal(creds)
	os.WriteFile(filepath.Join(ionDir, "credentials.json"), data, 0o644)

	t.Setenv("HOME", dir)
	t.Setenv("ANTHROPIC_API_KEY", "sk-from-env")

	r := NewResolver(nil)
	key, err := r.ResolveKey("anthropic")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if key != "sk-from-env" {
		t.Fatalf("expected env var to take priority, got %q", key)
	}
}

func TestResolver_ResolveKey_GoogleFallback(t *testing.T) {
	// GOOGLE_API_KEY not set, but GEMINI_API_KEY is
	t.Setenv("GOOGLE_API_KEY", "")
	t.Setenv("GEMINI_API_KEY", "gemini-key-123")

	r := NewResolver(nil)
	key, err := r.ResolveKey("google")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if key != "gemini-key-123" {
		t.Fatalf("expected gemini-key-123, got %q", key)
	}
}

// --- OAuth tests ---

func TestInitiateDeviceFlow(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			t.Fatalf("expected POST, got %s", r.Method)
		}
		json.NewEncoder(w).Encode(DeviceFlowResult{
			DeviceCode: "dev-code-123",
			UserCode:   "ABCD-1234",
			VerifyURI:  "https://example.com/verify",
			ExpiresIn:  900,
			Interval:   5,
		})
	}))
	defer server.Close()

	result, err := InitiateDeviceFlow("client-id", server.URL)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if result.DeviceCode != "dev-code-123" {
		t.Fatalf("expected dev-code-123, got %q", result.DeviceCode)
	}
	if result.UserCode != "ABCD-1234" {
		t.Fatalf("expected ABCD-1234, got %q", result.UserCode)
	}
}

func TestInitiateDeviceFlow_DefaultInterval(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		json.NewEncoder(w).Encode(DeviceFlowResult{
			DeviceCode: "dev-code",
			UserCode:   "CODE",
			VerifyURI:  "https://example.com/verify",
			ExpiresIn:  300,
			// Interval omitted (0)
		})
	}))
	defer server.Close()

	result, err := InitiateDeviceFlow("client-id", server.URL)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if result.Interval != 5 {
		t.Fatalf("expected default interval 5, got %d", result.Interval)
	}
}

func TestInitiateDeviceFlow_ServerError(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusInternalServerError)
		w.Write([]byte("internal error"))
	}))
	defer server.Close()

	_, err := InitiateDeviceFlow("client-id", server.URL)
	if err == nil {
		t.Fatal("expected error for server error response")
	}
}

func TestExchangeDeviceCode_Success(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		json.NewEncoder(w).Encode(map[string]interface{}{
			"access_token": "at-success-123",
			"token_type":   "bearer",
		})
	}))
	defer server.Close()

	token, err := ExchangeDeviceCode("client-id", "dev-code", server.URL)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if token != "at-success-123" {
		t.Fatalf("expected at-success-123, got %q", token)
	}
}

func TestExchangeDeviceCode_Pending(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		json.NewEncoder(w).Encode(map[string]interface{}{
			"error":             "authorization_pending",
			"error_description": "user has not yet authorized",
		})
	}))
	defer server.Close()

	_, err := ExchangeDeviceCode("client-id", "dev-code", server.URL)
	if err == nil {
		t.Fatal("expected error for pending authorization")
	}
}

func TestExchangeDeviceCode_EmptyToken(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		json.NewEncoder(w).Encode(map[string]interface{}{
			"token_type": "bearer",
		})
	}))
	defer server.Close()

	_, err := ExchangeDeviceCode("client-id", "dev-code", server.URL)
	if err == nil {
		t.Fatal("expected error for empty token")
	}
}

func TestResolver_WithOAuthConfig(t *testing.T) {
	// Seed a stored OAuth token with an expired access token and a valid refresh_token.
	// The mock server handles the refresh_token grant and returns a new access token.
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if err := r.ParseForm(); err != nil {
			t.Fatalf("parse form: %v", err)
		}
		if r.FormValue("grant_type") != "refresh_token" {
			t.Errorf("expected grant_type=refresh_token, got %q", r.FormValue("grant_type"))
		}
		json.NewEncoder(w).Encode(map[string]interface{}{
			"access_token": "oauth-token-123",
			"token_type":   "bearer",
			"expires_in":   3600,
		})
	}))
	defer server.Close()

	// Clear env vars and point HOME at a temp dir with an encrypted file store
	// that contains a stored OAuth token entry.
	dir := t.TempDir()
	ionDir := filepath.Join(dir, ".ion")
	os.MkdirAll(ionDir, 0o700)
	t.Setenv("ANTHROPIC_API_KEY", "")
	t.Setenv("HOME", dir)

	// Store a token entry with an expired access token and a refresh_token.
	storedToken, _ := json.Marshal(oauthToken{
		AccessToken:  "old-expired-token",
		RefreshToken: "valid-refresh-token",
		ExpiresAt:    time.Now().Add(-1 * time.Hour), // already expired
	})
	fs := &FileStore{path: filepath.Join(ionDir, "credentials.enc")}
	if err := fs.SetKey("oauth:anthropic", string(storedToken)); err != nil {
		t.Fatalf("seed stored token: %v", err)
	}

	config := &types.AuthConfig{
		OAuth: map[string]types.OAuthConfig{
			"anthropic": {
				ClientID: "test-client",
				TokenURL: server.URL,
			},
		},
	}

	r := NewResolver(config)
	key, err := r.ResolveKey("anthropic")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if key != "oauth-token-123" {
		t.Fatalf("expected oauth-token-123, got %q", key)
	}
}

// --- FileStore tests ---

func makeTestFileStore(t *testing.T) *FileStore {
	t.Helper()
	dir := t.TempDir()
	return &FileStore{path: filepath.Join(dir, "credentials.enc")}
}

func TestFileStore_SetKey_GetKey_RoundTrip(t *testing.T) {
	fs := makeTestFileStore(t)

	if err := fs.SetKey("anthropic", "sk-test-value"); err != nil {
		t.Fatalf("SetKey: %v", err)
	}

	key, err := fs.GetKey("anthropic")
	if err != nil {
		t.Fatalf("GetKey: %v", err)
	}
	if key != "sk-test-value" {
		t.Fatalf("expected sk-test-value, got %q", key)
	}
}

func TestFileStore_SetKey_MultipleProviders(t *testing.T) {
	fs := makeTestFileStore(t)

	if err := fs.SetKey("provider-a", "key-a"); err != nil {
		t.Fatalf("SetKey a: %v", err)
	}
	if err := fs.SetKey("provider-b", "key-b"); err != nil {
		t.Fatalf("SetKey b: %v", err)
	}

	keyA, err := fs.GetKey("provider-a")
	if err != nil {
		t.Fatalf("GetKey a: %v", err)
	}
	if keyA != "key-a" {
		t.Fatalf("expected key-a, got %q", keyA)
	}

	keyB, err := fs.GetKey("provider-b")
	if err != nil {
		t.Fatalf("GetKey b: %v", err)
	}
	if keyB != "key-b" {
		t.Fatalf("expected key-b, got %q", keyB)
	}
}

func TestFileStore_SetKey_Overwrite(t *testing.T) {
	fs := makeTestFileStore(t)

	if err := fs.SetKey("provider", "original"); err != nil {
		t.Fatal(err)
	}
	if err := fs.SetKey("provider", "updated"); err != nil {
		t.Fatal(err)
	}

	key, err := fs.GetKey("provider")
	if err != nil {
		t.Fatal(err)
	}
	if key != "updated" {
		t.Fatalf("expected updated, got %q", key)
	}
}

func TestFileStore_DeleteKey(t *testing.T) {
	fs := makeTestFileStore(t)

	if err := fs.SetKey("to-remove", "sk-remove-me"); err != nil {
		t.Fatal(err)
	}

	if err := fs.DeleteKey("to-remove"); err != nil {
		t.Fatalf("DeleteKey: %v", err)
	}

	_, err := fs.GetKey("to-remove")
	if err == nil {
		t.Fatal("expected error after deleting key")
	}
}

func TestFileStore_DeleteKey_NonExistent(t *testing.T) {
	fs := makeTestFileStore(t)

	// Set one key first so file exists
	if err := fs.SetKey("other", "val"); err != nil {
		t.Fatal(err)
	}

	// Deleting a key that does not exist should not error
	if err := fs.DeleteKey("nonexistent"); err != nil {
		t.Fatalf("expected no error deleting nonexistent key, got %v", err)
	}
}

func TestFileStore_GetKey_MissingFile(t *testing.T) {
	fs := makeTestFileStore(t)

	_, err := fs.GetKey("anything")
	if err == nil {
		t.Fatal("expected error for missing credentials file")
	}
}

func TestFileStore_GetKey_MissingProvider(t *testing.T) {
	fs := makeTestFileStore(t)

	if err := fs.SetKey("exists", "val"); err != nil {
		t.Fatal(err)
	}

	_, err := fs.GetKey("does-not-exist")
	if err == nil {
		t.Fatal("expected error for missing provider in filestore")
	}
}

func TestFileStore_CorruptFile(t *testing.T) {
	fs := makeTestFileStore(t)

	// Write garbage data to the credentials file
	if err := os.MkdirAll(filepath.Dir(fs.path), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(fs.path, []byte("not valid hex"), 0o600); err != nil {
		t.Fatal(err)
	}

	_, err := fs.GetKey("anything")
	if err == nil {
		t.Fatal("expected error for corrupt credentials file")
	}
}

func TestFileStore_FilePermissions(t *testing.T) {
	fs := makeTestFileStore(t)

	if err := fs.SetKey("perm-test", "sk-perms"); err != nil {
		t.Fatal(err)
	}

	stat, err := os.Stat(fs.path)
	if err != nil {
		t.Fatal(err)
	}
	mode := stat.Mode() & 0o777
	if mode != 0o600 {
		t.Errorf("expected file mode 0600, got %04o", mode)
	}
}

func TestFileStore_ConcurrentAccess(t *testing.T) {
	fs := makeTestFileStore(t)

	// Pre-create the file
	if err := fs.SetKey("init", "val"); err != nil {
		t.Fatal(err)
	}

	var wg sync.WaitGroup
	errs := make(chan error, 20)

	for i := 0; i < 10; i++ {
		wg.Add(1)
		go func(n int) {
			defer wg.Done()
			provider := "provider-" + strings.Repeat("x", n%3)
			if err := fs.SetKey(provider, "key-value"); err != nil {
				errs <- err
			}
		}(i)
	}

	for i := 0; i < 10; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			fs.GetKey("init")
		}()
	}

	wg.Wait()
	close(errs)

	for err := range errs {
		t.Errorf("concurrent access error: %v", err)
	}
}

func TestFileStore_PersistenceBetweenInstances(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "credentials.enc")

	fs1 := &FileStore{path: path}
	if err := fs1.SetKey("provider", "sk-persist-test"); err != nil {
		t.Fatal(err)
	}

	// New instance reading the same file
	fs2 := &FileStore{path: path}
	key, err := fs2.GetKey("provider")
	if err != nil {
		t.Fatalf("second instance GetKey: %v", err)
	}
	if key != "sk-persist-test" {
		t.Fatalf("expected sk-persist-test, got %q", key)
	}
}

// --- Resolver priority chain tests ---

func TestResolver_PriorityOrder_EnvOverKeychain(t *testing.T) {
	// Env var should take priority over keychain and filestore
	t.Setenv("ANTHROPIC_API_KEY", "sk-from-env")
	t.Setenv("HOME", t.TempDir())

	r := NewResolver(nil)
	key, err := r.ResolveKey("anthropic")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if key != "sk-from-env" {
		t.Fatalf("expected env var priority, got %q", key)
	}
}

func TestResolver_PriorityOrder_FileStoreOverCredentialsJSON(t *testing.T) {
	// FileStore should take priority over credentials.json
	dir := t.TempDir()
	t.Setenv("HOME", dir)
	t.Setenv("ANTHROPIC_API_KEY", "")

	// Create credentials.json (legacy)
	ionDir := filepath.Join(dir, ".ion")
	os.MkdirAll(ionDir, 0o700)
	creds := map[string]string{"anthropic": "sk-from-json"}
	data, _ := json.Marshal(creds)
	os.WriteFile(filepath.Join(ionDir, "credentials.json"), data, 0o644)

	// Create encrypted filestore with different key
	fs := &FileStore{path: filepath.Join(ionDir, "credentials.enc")}
	if err := fs.SetKey("anthropic", "sk-from-filestore"); err != nil {
		t.Fatal(err)
	}

	r := NewResolver(nil)
	key, err := r.ResolveKey("anthropic")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if key != "sk-from-filestore" {
		t.Fatalf("expected filestore to have priority over JSON, got %q", key)
	}
}

func TestResolver_CredentialsFile_CorruptJSON(t *testing.T) {
	dir := t.TempDir()
	ionDir := filepath.Join(dir, ".ion")
	os.MkdirAll(ionDir, 0o700)
	os.WriteFile(filepath.Join(ionDir, "credentials.json"), []byte("not json{"), 0o644)

	t.Setenv("HOME", dir)
	t.Setenv("ANTHROPIC_API_KEY", "")

	r := NewResolver(nil)
	_, err := r.ResolveKey("anthropic")
	if err == nil {
		t.Fatal("expected error for corrupt credentials file")
	}
}

func TestResolver_CredentialsFile_MissingKey(t *testing.T) {
	dir := t.TempDir()
	ionDir := filepath.Join(dir, ".ion")
	os.MkdirAll(ionDir, 0o700)

	creds := map[string]string{"openai": "sk-openai-only"}
	data, _ := json.Marshal(creds)
	os.WriteFile(filepath.Join(ionDir, "credentials.json"), data, 0o644)

	t.Setenv("HOME", dir)
	t.Setenv("ANTHROPIC_API_KEY", "")

	r := NewResolver(nil)
	_, err := r.ResolveKey("anthropic")
	if err == nil {
		t.Fatal("expected error when provider key missing from credentials file")
	}
}

// --- OAuth tests (expanded) ---

func TestExchangeDeviceCode_SlowDown(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		json.NewEncoder(w).Encode(map[string]interface{}{
			"error":             "slow_down",
			"error_description": "polling too fast",
		})
	}))
	defer server.Close()

	_, err := ExchangeDeviceCode("client-id", "dev-code", server.URL)
	if err == nil {
		t.Fatal("expected error for slow_down response")
	}
	if !strings.Contains(err.Error(), "slow_down") {
		t.Fatalf("expected slow_down in error, got %q", err.Error())
	}
}

func TestExchangeDeviceCode_ExpiredToken(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		json.NewEncoder(w).Encode(map[string]interface{}{
			"error":             "expired_token",
			"error_description": "device code has expired",
		})
	}))
	defer server.Close()

	_, err := ExchangeDeviceCode("client-id", "dev-code", server.URL)
	if err == nil {
		t.Fatal("expected error for expired token")
	}
	if !strings.Contains(err.Error(), "expired_token") {
		t.Fatalf("expected expired_token in error, got %q", err.Error())
	}
}

func TestExchangeDeviceCode_MalformedJSON(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Write([]byte("not json"))
	}))
	defer server.Close()

	_, err := ExchangeDeviceCode("client-id", "dev-code", server.URL)
	if err == nil {
		t.Fatal("expected error for malformed JSON response")
	}
}

func TestInitiateDeviceFlow_MalformedJSON(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Write([]byte("{broken json"))
	}))
	defer server.Close()

	_, err := InitiateDeviceFlow("client-id", server.URL)
	if err == nil {
		t.Fatal("expected error for malformed JSON")
	}
}

func TestInitiateDeviceFlow_NetworkError(t *testing.T) {
	_, err := InitiateDeviceFlow("client-id", "http://localhost:1")
	if err == nil {
		t.Fatal("expected error for network failure")
	}
}

func TestExchangeDeviceCode_NetworkError(t *testing.T) {
	_, err := ExchangeDeviceCode("client-id", "dev-code", "http://localhost:1")
	if err == nil {
		t.Fatal("expected error for network failure")
	}
}

func TestInitiateDeviceFlow_VerifiesAllFields(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		json.NewEncoder(w).Encode(DeviceFlowResult{
			DeviceCode: "dc-full",
			UserCode:   "WXYZ-9999",
			VerifyURI:  "https://auth.example.com/verify",
			ExpiresIn:  600,
			Interval:   10,
		})
	}))
	defer server.Close()

	result, err := InitiateDeviceFlow("client-id", server.URL)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if result.DeviceCode != "dc-full" {
		t.Errorf("DeviceCode = %q", result.DeviceCode)
	}
	if result.UserCode != "WXYZ-9999" {
		t.Errorf("UserCode = %q", result.UserCode)
	}
	if result.VerifyURI != "https://auth.example.com/verify" {
		t.Errorf("VerifyURI = %q", result.VerifyURI)
	}
	if result.ExpiresIn != 600 {
		t.Errorf("ExpiresIn = %d", result.ExpiresIn)
	}
	if result.Interval != 10 {
		t.Errorf("Interval = %d", result.Interval)
	}
}

func TestInitiateDeviceFlow_PostMethod(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			t.Errorf("expected POST, got %s", r.Method)
		}
		if r.Header.Get("Content-Type") != "application/x-www-form-urlencoded" {
			t.Errorf("expected form content type, got %q", r.Header.Get("Content-Type"))
		}
		json.NewEncoder(w).Encode(DeviceFlowResult{
			DeviceCode: "dc",
			UserCode:   "UC",
			VerifyURI:  "https://example.com",
			ExpiresIn:  300,
		})
	}))
	defer server.Close()

	_, err := InitiateDeviceFlow("client-id", server.URL)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
}

func TestExchangeDeviceCode_SendsCorrectFormData(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if err := r.ParseForm(); err != nil {
			t.Fatalf("parse form: %v", err)
		}
		if r.FormValue("client_id") != "my-client" {
			t.Errorf("client_id = %q", r.FormValue("client_id"))
		}
		if r.FormValue("device_code") != "my-device-code" {
			t.Errorf("device_code = %q", r.FormValue("device_code"))
		}
		if r.FormValue("grant_type") != "urn:ietf:params:oauth:grant-type:device_code" {
			t.Errorf("grant_type = %q", r.FormValue("grant_type"))
		}
		json.NewEncoder(w).Encode(map[string]interface{}{
			"access_token": "at-check",
			"token_type":   "bearer",
		})
	}))
	defer server.Close()

	token, err := ExchangeDeviceCode("my-client", "my-device-code", server.URL)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if token != "at-check" {
		t.Fatalf("expected at-check, got %q", token)
	}
}

func TestInitiateDeviceFlow_HttpStatus4xx(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusBadRequest)
		w.Write([]byte(`{"error": "invalid_client"}`))
	}))
	defer server.Close()

	_, err := InitiateDeviceFlow("client-id", server.URL)
	if err == nil {
		t.Fatal("expected error for 400 response")
	}
}

func TestResolver_MultipleProviders_Independent(t *testing.T) {
	t.Setenv("ANTHROPIC_API_KEY", "sk-ant-multi")
	t.Setenv("OPENAI_API_KEY", "sk-oai-multi")
	t.Setenv("GROQ_API_KEY", "groq-multi")

	r := NewResolver(nil)

	ant, err := r.ResolveKey("anthropic")
	if err != nil {
		t.Fatal(err)
	}
	oai, err := r.ResolveKey("openai")
	if err != nil {
		t.Fatal(err)
	}
	grq, err := r.ResolveKey("groq")
	if err != nil {
		t.Fatal(err)
	}

	if ant != "sk-ant-multi" {
		t.Errorf("anthropic = %q", ant)
	}
	if oai != "sk-oai-multi" {
		t.Errorf("openai = %q", oai)
	}
	if grq != "groq-multi" {
		t.Errorf("groq = %q", grq)
	}
}

func TestResolver_OAuthFallback_OnFailure(t *testing.T) {
	// Refresh server returns an error; resolver should fall through and return
	// "no API key found" rather than panicking or hanging.
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		json.NewEncoder(w).Encode(map[string]interface{}{
			"error": "access_denied",
		})
	}))
	defer server.Close()

	dir := t.TempDir()
	ionDir := filepath.Join(dir, ".ion")
	os.MkdirAll(ionDir, 0o700)
	t.Setenv("ANTHROPIC_API_KEY", "")
	t.Setenv("HOME", dir)

	// Seed a stored token with an expired access token and a refresh_token so
	// Level 5 is triggered and the server error is exercised.
	storedToken, _ := json.Marshal(oauthToken{
		AccessToken:  "expired",
		RefreshToken: "rt-denied",
		ExpiresAt:    time.Now().Add(-1 * time.Hour),
	})
	fs := &FileStore{path: filepath.Join(ionDir, "credentials.enc")}
	if err := fs.SetKey("oauth:anthropic", string(storedToken)); err != nil {
		t.Fatalf("seed stored token: %v", err)
	}

	config := &types.AuthConfig{
		OAuth: map[string]types.OAuthConfig{
			"anthropic": {
				ClientID: "test-client",
				TokenURL: server.URL,
			},
		},
	}

	r := NewResolver(config)
	_, err := r.ResolveKey("anthropic")
	if err == nil {
		t.Fatal("expected error when OAuth returns error")
	}
}

// --- FileStore encrypt/decrypt round-trip ---

func TestFileStore_EncryptDecrypt_RoundTrip(t *testing.T) {
	fs := makeTestFileStore(t)

	// Store multiple keys, verify all survive
	providers := map[string]string{
		"anthropic": "sk-ant-enc",
		"openai":    "sk-oai-enc",
		"google":    "goog-enc",
		"custom":    "custom-value-with-special-chars!@#$%",
	}

	for p, k := range providers {
		if err := fs.SetKey(p, k); err != nil {
			t.Fatalf("SetKey %s: %v", p, err)
		}
	}

	for p, expected := range providers {
		got, err := fs.GetKey(p)
		if err != nil {
			t.Fatalf("GetKey %s: %v", p, err)
		}
		if got != expected {
			t.Fatalf("provider %s: expected %q, got %q", p, expected, got)
		}
	}
}

func TestFileStore_DeleteKey_PreservesOthers(t *testing.T) {
	fs := makeTestFileStore(t)

	fs.SetKey("keep", "keep-val")
	fs.SetKey("remove", "remove-val")

	if err := fs.DeleteKey("remove"); err != nil {
		t.Fatal(err)
	}

	// "keep" should still be accessible
	key, err := fs.GetKey("keep")
	if err != nil {
		t.Fatalf("expected keep to survive delete: %v", err)
	}
	if key != "keep-val" {
		t.Fatalf("expected keep-val, got %q", key)
	}

	// "remove" should be gone
	_, err = fs.GetKey("remove")
	if err == nil {
		t.Fatal("expected error for deleted key")
	}
}

func TestFileStore_EmptyKey(t *testing.T) {
	fs := makeTestFileStore(t)

	// Store empty string as key value
	if err := fs.SetKey("provider", ""); err != nil {
		t.Fatal(err)
	}

	key, err := fs.GetKey("provider")
	if err != nil {
		t.Fatal(err)
	}
	if key != "" {
		t.Fatalf("expected empty key, got %q", key)
	}
}

func TestFileStore_SpecialCharsInProvider(t *testing.T) {
	fs := makeTestFileStore(t)

	if err := fs.SetKey("my-custom.provider/v2", "sk-special"); err != nil {
		t.Fatal(err)
	}

	key, err := fs.GetKey("my-custom.provider/v2")
	if err != nil {
		t.Fatal(err)
	}
	if key != "sk-special" {
		t.Fatalf("expected sk-special, got %q", key)
	}
}

func TestFileStore_LargeKey(t *testing.T) {
	fs := makeTestFileStore(t)

	largeValue := strings.Repeat("abcdefghij", 500) // 5000 chars
	if err := fs.SetKey("large", largeValue); err != nil {
		t.Fatal(err)
	}

	key, err := fs.GetKey("large")
	if err != nil {
		t.Fatal(err)
	}
	if key != largeValue {
		t.Fatalf("large key round-trip failed: got %d chars, expected %d", len(key), len(largeValue))
	}
}

func TestFileStore_UnicodeKey(t *testing.T) {
	fs := makeTestFileStore(t)

	if err := fs.SetKey("unicode-provider", "sk-key-with-unicode-chars"); err != nil {
		t.Fatal(err)
	}

	key, err := fs.GetKey("unicode-provider")
	if err != nil {
		t.Fatal(err)
	}
	if key != "sk-key-with-unicode-chars" {
		t.Fatalf("expected sk-key-with-unicode-chars, got %q", key)
	}
}

func TestResolver_ResolveKey_PrimaryEnvTakesPriority(t *testing.T) {
	// When both primary and fallback env vars are set, primary should win
	t.Setenv("GOOGLE_API_KEY", "google-primary")
	t.Setenv("GEMINI_API_KEY", "gemini-fallback")

	r := NewResolver(nil)
	key, err := r.ResolveKey("google")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if key != "google-primary" {
		t.Fatalf("expected primary env var, got %q", key)
	}
}

func TestResolver_CredentialsFile_EmptyJSON(t *testing.T) {
	dir := t.TempDir()
	ionDir := filepath.Join(dir, ".ion")
	os.MkdirAll(ionDir, 0o700)
	os.WriteFile(filepath.Join(ionDir, "credentials.json"), []byte("{}"), 0o644)

	t.Setenv("HOME", dir)
	t.Setenv("ANTHROPIC_API_KEY", "")

	r := NewResolver(nil)
	_, err := r.ResolveKey("anthropic")
	if err == nil {
		t.Fatal("expected error when credentials file is empty object")
	}
}

func TestExchangeDeviceCode_HttpStatus500(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusInternalServerError)
		w.Write([]byte(`{"error": "server_error"}`))
	}))
	defer server.Close()

	_, err := ExchangeDeviceCode("client-id", "dev-code", server.URL)
	if err == nil {
		t.Fatal("expected error for 500 response")
	}
}

func TestResolver_NilConfig(t *testing.T) {
	t.Setenv("ANTHROPIC_API_KEY", "sk-nil-config")

	r := NewResolver(nil)
	key, err := r.ResolveKey("anthropic")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if key != "sk-nil-config" {
		t.Fatalf("expected sk-nil-config, got %q", key)
	}
}

func TestResolver_EmptyConfig(t *testing.T) {
	t.Setenv("OPENAI_API_KEY", "sk-empty-config")

	r := NewResolver(&types.AuthConfig{})
	key, err := r.ResolveKey("openai")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if key != "sk-empty-config" {
		t.Fatalf("expected sk-empty-config, got %q", key)
	}
}

func TestResolver_CustomServiceName(t *testing.T) {
	// Custom service name should be used for keychain lookup (won't actually
	// find anything, but verifies the code path doesn't panic)
	t.Setenv("HOME", t.TempDir())
	t.Setenv("ANTHROPIC_API_KEY", "sk-custom-svc")

	config := &types.AuthConfig{
		SecureStore: &types.SecureStoreConfig{
			ServiceName: "my-custom-service",
		},
	}

	r := NewResolver(config)
	key, err := r.ResolveKey("anthropic")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if key != "sk-custom-svc" {
		t.Fatalf("expected sk-custom-svc, got %q", key)
	}
}
