package network

import (
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/pem"
	"math/big"
	"os"
	"testing"
	"time"

	"github.com/dsswift/ion/engine/internal/types"
)

// resetGlobals resets package-level state between tests.
func resetGlobals() {
	httpTransport = nil
	proxyURL = nil
	noProxyList = nil
}

// writeTempCACert generates a self-signed CA cert, writes it to a temp file,
// and returns the path. The caller is responsible for removing the file.
func writeTempCACert(t *testing.T) string {
	t.Helper()

	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatalf("generate key: %v", err)
	}

	template := &x509.Certificate{
		SerialNumber:          big.NewInt(1),
		Subject:               pkix.Name{CommonName: "test-ca"},
		NotBefore:             time.Now().Add(-time.Minute),
		NotAfter:              time.Now().Add(time.Hour),
		IsCA:                  true,
		BasicConstraintsValid: true,
	}

	der, err := x509.CreateCertificate(rand.Reader, template, template, &key.PublicKey, key)
	if err != nil {
		t.Fatalf("create cert: %v", err)
	}

	f, err := os.CreateTemp("", "ion-test-ca-*.pem")
	if err != nil {
		t.Fatalf("create temp file: %v", err)
	}
	defer f.Close()

	if err := pem.Encode(f, &pem.Block{Type: "CERTIFICATE", Bytes: der}); err != nil {
		t.Fatalf("encode pem: %v", err)
	}

	return f.Name()
}

// boolPtr returns a pointer to the given bool, for use in struct literals.
func boolPtr(b bool) *bool { return &b }

// --- IsNoProxy -----------------------------------------------------------------

func TestIsNoProxy(t *testing.T) {
	tests := []struct {
		name     string
		list     []string
		host     string
		expected bool
	}{
		{"exact match", []string{"localhost"}, "localhost", true},
		{"no match", []string{"localhost"}, "example.com", false},
		{"wildcard", []string{"*"}, "anything.example.com", true},
		{"dot prefix match", []string{".example.com"}, "api.example.com", true},
		{"dot prefix no match on root", []string{".example.com"}, "example.com", false},
		{"suffix without dot", []string{"example.com"}, "api.example.com", true},
		{"case insensitive", []string{"LOCALHOST"}, "localhost", true},
		{"empty list", nil, "localhost", false},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			noProxyList = tt.list
			got := IsNoProxy(tt.host)
			if got != tt.expected {
				t.Errorf("IsNoProxy(%q) = %v, want %v", tt.host, got, tt.expected)
			}
		})
	}
}

// --- InitNetwork / GetHTTPTransport --------------------------------------------

func TestInitNetworkDefaults(t *testing.T) {
	resetGlobals()

	InitNetwork(nil)

	transport := GetHTTPTransport()
	if transport == nil {
		t.Fatal("expected non-nil transport")
	}
}

func TestInitNetworkWithProxy(t *testing.T) {
	resetGlobals()

	cfg := &types.NetworkConfig{
		Proxy: &types.ProxyConfig{
			HttpsProxy: "http://proxy.example.com:8080",
			NoProxy:    "localhost,127.0.0.1,.internal.net",
		},
	}

	InitNetwork(cfg)

	proxyFor := GetProxyForURL("https://api.example.com")
	if proxyFor != "http://proxy.example.com:8080" {
		t.Errorf("expected proxy URL, got %q", proxyFor)
	}

	proxyFor = GetProxyForURL("https://localhost:3000")
	if proxyFor != "" {
		t.Errorf("expected empty proxy for localhost, got %q", proxyFor)
	}

	proxyFor = GetProxyForURL("https://foo.internal.net/api")
	if proxyFor != "" {
		t.Errorf("expected empty proxy for .internal.net, got %q", proxyFor)
	}
}

// TestInitNetworkProxyTransport confirms that the HTTP transport returned after
// InitNetwork will route a request through the configured proxy.
func TestInitNetworkProxyTransport(t *testing.T) {
	resetGlobals()

	cfg := &types.NetworkConfig{
		Proxy: &types.ProxyConfig{
			HttpsProxy: "http://proxy.example.com:3128",
		},
	}
	InitNetwork(cfg)

	transport := GetHTTPTransport()
	if transport == nil {
		t.Fatal("expected non-nil transport")
	}
	if transport.Proxy == nil {
		t.Fatal("expected transport.Proxy to be set")
	}
}

// TestInitNetworkCustomCACert verifies that a valid PEM cert path is loaded
// into the transport's TLS RootCAs pool.
func TestInitNetworkCustomCACert(t *testing.T) {
	resetGlobals()

	certPath := writeTempCACert(t)
	defer os.Remove(certPath)

	cfg := &types.NetworkConfig{
		CustomCaCerts: []string{certPath},
	}
	InitNetwork(cfg)

	transport := GetHTTPTransport()
	if transport == nil {
		t.Fatal("expected non-nil transport")
	}
	if transport.TLSClientConfig == nil {
		t.Fatal("expected TLSClientConfig to be set")
	}
	if transport.TLSClientConfig.RootCAs == nil {
		t.Fatal("expected RootCAs pool to be populated")
	}
}

// TestInitNetworkCustomCACertMissingFile verifies that a non-existent cert path
// is silently skipped and InitNetwork still produces a usable transport.
func TestInitNetworkCustomCACertMissingFile(t *testing.T) {
	resetGlobals()

	cfg := &types.NetworkConfig{
		CustomCaCerts: []string{"/nonexistent/path/ca.pem"},
	}
	InitNetwork(cfg)

	transport := GetHTTPTransport()
	if transport == nil {
		t.Fatal("expected non-nil transport even with bad cert path")
	}
}

// TestInitNetworkTLSSkipVerify verifies InsecureSkipVerify is set when
// RejectUnauthorized is explicitly false.
func TestInitNetworkTLSSkipVerify(t *testing.T) {
	resetGlobals()

	cfg := &types.NetworkConfig{
		RejectUnauthorized: boolPtr(false),
	}
	InitNetwork(cfg)

	transport := GetHTTPTransport()
	if transport == nil {
		t.Fatal("expected non-nil transport")
	}
	if transport.TLSClientConfig == nil {
		t.Fatal("expected TLSClientConfig to be set")
	}
	if !transport.TLSClientConfig.InsecureSkipVerify {
		t.Error("expected InsecureSkipVerify = true")
	}
}

// TestInitNetworkTLSRejectAuthorized verifies InsecureSkipVerify is false when
// RejectUnauthorized is true (the secure default).
func TestInitNetworkTLSRejectAuthorized(t *testing.T) {
	resetGlobals()

	cfg := &types.NetworkConfig{
		RejectUnauthorized: boolPtr(true),
	}
	InitNetwork(cfg)

	transport := GetHTTPTransport()
	if transport == nil {
		t.Fatal("expected non-nil transport")
	}
	if transport.TLSClientConfig == nil {
		t.Fatal("expected TLSClientConfig to be set")
	}
	if transport.TLSClientConfig.InsecureSkipVerify {
		t.Error("expected InsecureSkipVerify = false when RejectUnauthorized = true")
	}
}

// TestGetHTTPTransportBeforeInit verifies that calling GetHTTPTransport before
// InitNetwork returns a non-nil fallback transport.
func TestGetHTTPTransportBeforeInit(t *testing.T) {
	resetGlobals()

	transport := GetHTTPTransport()
	if transport == nil {
		t.Fatal("expected non-nil default transport before InitNetwork")
	}
}

// TestGetHTTPTransportAfterInit verifies the transport returned after InitNetwork
// is the one that was configured (not the default clone).
func TestGetHTTPTransportAfterInit(t *testing.T) {
	resetGlobals()

	InitNetwork(nil)

	transport := GetHTTPTransport()
	if transport == nil {
		t.Fatal("expected non-nil transport")
	}
	// The returned pointer must be the same object stored in httpTransport.
	if transport != httpTransport {
		t.Error("GetHTTPTransport should return the configured httpTransport instance")
	}
}

// TestInitNetworkOverwritesPreviousConfig verifies that calling InitNetwork a
// second time replaces the previously configured transport and proxy.
func TestInitNetworkOverwritesPreviousConfig(t *testing.T) {
	resetGlobals()

	first := &types.NetworkConfig{
		Proxy: &types.ProxyConfig{
			HttpsProxy: "http://first-proxy.example.com:8080",
		},
	}
	InitNetwork(first)

	firstTransport := GetHTTPTransport()
	firstProxy := GetProxyForURL("https://api.example.com")
	if firstProxy != "http://first-proxy.example.com:8080" {
		t.Fatalf("first InitNetwork: expected first proxy, got %q", firstProxy)
	}

	// Call InitNetwork again with a different config.
	second := &types.NetworkConfig{
		Proxy: &types.ProxyConfig{
			HttpsProxy: "http://second-proxy.example.com:9090",
		},
	}
	InitNetwork(second)

	secondTransport := GetHTTPTransport()
	secondProxy := GetProxyForURL("https://api.example.com")

	if secondProxy != "http://second-proxy.example.com:9090" {
		t.Errorf("second InitNetwork: expected second proxy, got %q", secondProxy)
	}
	if firstTransport == secondTransport {
		t.Error("second InitNetwork should produce a new transport instance")
	}
}

// TestInitNetworkHttpFallback verifies that HttpProxy is used when HttpsProxy
// is not set.
func TestInitNetworkHttpFallback(t *testing.T) {
	resetGlobals()

	cfg := &types.NetworkConfig{
		Proxy: &types.ProxyConfig{
			HttpProxy: "http://http-only-proxy.example.com:8080",
		},
	}
	InitNetwork(cfg)

	got := GetProxyForURL("https://api.example.com")
	if got != "http://http-only-proxy.example.com:8080" {
		t.Errorf("expected http-only proxy fallback, got %q", got)
	}
}

// TestInitNetworkHttpsProxyTakesPrecedence verifies HttpsProxy wins over HttpProxy.
func TestInitNetworkHttpsProxyTakesPrecedence(t *testing.T) {
	resetGlobals()

	cfg := &types.NetworkConfig{
		Proxy: &types.ProxyConfig{
			HttpProxy:  "http://http-proxy.example.com:8080",
			HttpsProxy: "http://https-proxy.example.com:8443",
		},
	}
	InitNetwork(cfg)

	got := GetProxyForURL("https://api.example.com")
	if got != "http://https-proxy.example.com:8443" {
		t.Errorf("expected https proxy to take precedence, got %q", got)
	}
}

// TestGetProxyForURLNoProxy verifies GetProxyForURL returns empty string when
// no proxy has been configured.
func TestGetProxyForURLNoProxy(t *testing.T) {
	resetGlobals()

	InitNetwork(nil)

	got := GetProxyForURL("https://api.example.com")
	if got != "" {
		t.Errorf("expected empty proxy, got %q", got)
	}
}

// TestGetProxyForURLInvalidTarget verifies GetProxyForURL handles a malformed
// URL without panicking, returning an empty string.
func TestGetProxyForURLInvalidTarget(t *testing.T) {
	resetGlobals()

	cfg := &types.NetworkConfig{
		Proxy: &types.ProxyConfig{
			HttpsProxy: "http://proxy.example.com:8080",
		},
	}
	InitNetwork(cfg)

	got := GetProxyForURL("://not a valid url")
	if got != "" {
		t.Errorf("expected empty string for invalid URL, got %q", got)
	}
}
