// Package network configures HTTP transport with proxy and custom CA support.
package network

import (
	"crypto/tls"
	"crypto/x509"
	"net"
	"net/http"
	"net/url"
	"os"
	"strings"
	"time"

	"github.com/dsswift/ion/engine/internal/types"
)

var (
	httpTransport *http.Transport
	proxyURL      *url.URL
	noProxyList   []string
)

// InitNetwork configures the global HTTP transport from the provided NetworkConfig
// and environment variables. Proxy settings from config take precedence over env vars.
// Custom CA certificates are appended to the system pool.
func InitNetwork(cfg *types.NetworkConfig) {
	tlsConfig := &tls.Config{}

	if cfg != nil && cfg.RejectUnauthorized != nil && !*cfg.RejectUnauthorized {
		tlsConfig.InsecureSkipVerify = true
	}

	// Load custom CA certs.
	if cfg != nil && len(cfg.CustomCaCerts) > 0 {
		pool, err := x509.SystemCertPool()
		if err != nil {
			pool = x509.NewCertPool()
		}
		for _, certPath := range cfg.CustomCaCerts {
			data, err := os.ReadFile(certPath)
			if err != nil {
				continue
			}
			pool.AppendCertsFromPEM(data)
		}
		tlsConfig.RootCAs = pool
	}

	// Resolve proxy URL from config or environment.
	proxyStr := ""
	if cfg != nil && cfg.Proxy != nil {
		if cfg.Proxy.HttpsProxy != "" {
			proxyStr = cfg.Proxy.HttpsProxy
		} else if cfg.Proxy.HttpProxy != "" {
			proxyStr = cfg.Proxy.HttpProxy
		}
	}
	if proxyStr == "" {
		proxyStr = os.Getenv("HTTPS_PROXY")
	}
	if proxyStr == "" {
		proxyStr = os.Getenv("https_proxy")
	}
	if proxyStr == "" {
		proxyStr = os.Getenv("HTTP_PROXY")
	}
	if proxyStr == "" {
		proxyStr = os.Getenv("http_proxy")
	}

	if proxyStr != "" {
		parsed, err := url.Parse(proxyStr)
		if err == nil {
			proxyURL = parsed
		}
	}

	// Parse NO_PROXY list.
	noProxyStr := ""
	if cfg != nil && cfg.Proxy != nil && cfg.Proxy.NoProxy != "" {
		noProxyStr = cfg.Proxy.NoProxy
	}
	if noProxyStr == "" {
		noProxyStr = os.Getenv("NO_PROXY")
	}
	if noProxyStr == "" {
		noProxyStr = os.Getenv("no_proxy")
	}
	if noProxyStr != "" {
		parts := strings.Split(noProxyStr, ",")
		noProxyList = make([]string, 0, len(parts))
		for _, p := range parts {
			p = strings.TrimSpace(p)
			if p != "" {
				noProxyList = append(noProxyList, strings.ToLower(p))
			}
		}
	}

	// Build transport with the same baseline settings as http.DefaultTransport.
	// The bare &http.Transport{} zero-values disable TCP keepalive, dial timeouts,
	// idle connection management, and HTTP/2 — meaning a silently-dropped connection
	// (e.g. by a NAT middlebox during a long LLM stream) hangs the read forever.
	transport := &http.Transport{
		DialContext: (&net.Dialer{
			Timeout:   30 * time.Second,
			KeepAlive: 30 * time.Second,
		}).DialContext,
		TLSClientConfig:       tlsConfig,
		TLSHandshakeTimeout:   10 * time.Second,
		ForceAttemptHTTP2:      true,
		MaxIdleConns:          100,
		IdleConnTimeout:       90 * time.Second,
		ExpectContinueTimeout: 1 * time.Second,
	}
	if proxyURL != nil {
		transport.Proxy = func(req *http.Request) (*url.URL, error) {
			if IsNoProxy(req.URL.Hostname()) {
				return nil, nil
			}
			return proxyURL, nil
		}
	}

	httpTransport = transport
}

// GetHTTPTransport returns the configured HTTP transport. If InitNetwork has not
// been called, a default transport is returned.
func GetHTTPTransport() *http.Transport {
	if httpTransport == nil {
		return http.DefaultTransport.(*http.Transport).Clone()
	}
	return httpTransport
}

// GetProxyForURL returns the proxy URL string to use for the given target URL,
// or an empty string if no proxy applies.
func GetProxyForURL(targetURL string) string {
	if proxyURL == nil {
		return ""
	}
	parsed, err := url.Parse(targetURL)
	if err != nil {
		return ""
	}
	if IsNoProxy(parsed.Hostname()) {
		return ""
	}
	return proxyURL.String()
}

// IsNoProxy returns true if the given host matches any entry in the NO_PROXY list.
// Supports exact match, domain suffix with leading dot, and wildcard "*".
func IsNoProxy(host string) bool {
	host = strings.ToLower(host)
	for _, rawEntry := range noProxyList {
		entry := strings.ToLower(rawEntry)
		if entry == "*" {
			return true
		}
		if entry == host {
			return true
		}
		// Leading dot matches domain suffix.
		if strings.HasPrefix(entry, ".") && strings.HasSuffix(host, entry) {
			return true
		}
		// Also match without leading dot as suffix.
		if !strings.HasPrefix(entry, ".") && strings.HasSuffix(host, "."+entry) {
			return true
		}
	}
	return false
}
