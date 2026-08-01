package mcp

// discovery.go — OAuth metadata discovery for remote MCP servers.
//
// Remote MCP servers that require authorization advertise where to get a
// token rather than requiring the operator to hand-write endpoints. Two
// specs cover the hop:
//
//   - RFC 9728 (OAuth 2.0 Protected Resource Metadata): the MCP endpoint
//     itself publishes /.well-known/oauth-protected-resource, naming the
//     authorization server(s) that issue tokens for it.
//   - RFC 8414 (OAuth 2.0 Authorization Server Metadata): that authorization
//     server publishes /.well-known/oauth-authorization-server with its
//     authorization, token, and (optionally) dynamic-registration endpoints.
//     OIDC providers publish the same fields at
//     /.well-known/openid-configuration, which is the documented fallback.
//
// Discovery is what makes a zero-config `mcpServers` entry work: the operator
// supplies a URL, and the engine finds the rest. An explicit `oauth` block in
// engine.json always wins over anything discovered here (see login.go).
//
// Probe-order note: both specs insert the well-known segment BETWEEN the host
// and the resource path (https://host/.well-known/x/some/path), which reads
// backwards to anyone used to appending it. Real deployments serve both that
// spelling and the naive path-suffix spelling, so each probe tries the
// spec-correct URL first and the suffix form second.

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/dsswift/ion/engine/internal/network"
	"github.com/dsswift/ion/engine/internal/utils"
)

// discoveryTimeout bounds each individual well-known fetch. Discovery runs on
// the login path (interactive) and on the connect path (session start), so a
// hung metadata endpoint must not stall either.
const discoveryTimeout = 10 * time.Second

// ProtectedResourceMetadata is the subset of an RFC 9728 protected-resource
// document the engine consumes.
type ProtectedResourceMetadata struct {
	Resource             string   `json:"resource"`
	AuthorizationServers []string `json:"authorization_servers"`
	ScopesSupported      []string `json:"scopes_supported"`
}

// ServerMetadata is the subset of an RFC 8414 / OIDC-discovery authorization
// server document the engine consumes. RegistrationEndpoint is empty when the
// server does not support RFC 7591 dynamic client registration, in which case
// an operator-supplied client_id is required.
type ServerMetadata struct {
	Issuer                        string   `json:"issuer"`
	AuthorizationEndpoint         string   `json:"authorization_endpoint"`
	TokenEndpoint                 string   `json:"token_endpoint"`
	RegistrationEndpoint          string   `json:"registration_endpoint"`
	ScopesSupported               []string `json:"scopes_supported"`
	CodeChallengeMethodsSupported []string `json:"code_challenge_methods_supported"`
	GrantTypesSupported           []string `json:"grant_types_supported"`
}

// SupportsS256 reports whether the authorization server advertises the S256
// PKCE challenge method. An empty list is treated as supported: RFC 8414
// makes the field optional, and every server the engine can usefully talk to
// implements S256 — refusing on a missing advertisement would reject working
// servers, while sending S256 to a server that truly lacks it fails loudly at
// the authorization endpoint with the provider's own error.
func (m *ServerMetadata) SupportsS256() bool {
	if m == nil || len(m.CodeChallengeMethodsSupported) == 0 {
		return true
	}
	for _, method := range m.CodeChallengeMethodsSupported {
		if method == "S256" {
			return true
		}
	}
	return false
}

// wellKnownCandidates returns the ordered probe URLs for a well-known
// document, given a base URL and the well-known suffix (e.g.
// "oauth-protected-resource").
//
// For https://host/mcp and "oauth-protected-resource" the candidates are:
//
//  1. https://host/.well-known/oauth-protected-resource/mcp  (spec-correct)
//  2. https://host/.well-known/oauth-protected-resource      (root form)
//
// A base URL with no path yields only the root form. Duplicates are elided so
// a root-path base does not probe the same URL twice.
func wellKnownCandidates(baseURL, suffix string) ([]string, error) {
	parsed, err := url.Parse(baseURL)
	if err != nil {
		return nil, fmt.Errorf("parse %q: %w", baseURL, err)
	}
	if parsed.Scheme == "" || parsed.Host == "" {
		return nil, fmt.Errorf("%q is not an absolute URL", baseURL)
	}

	root := &url.URL{Scheme: parsed.Scheme, Host: parsed.Host, Path: "/.well-known/" + suffix}
	rootForm := root.String()

	path := strings.Trim(parsed.Path, "/")
	if path == "" {
		return []string{rootForm}, nil
	}
	return []string{rootForm + "/" + path, rootForm}, nil
}

// fetchWellKnown GETs one well-known URL and decodes it into out. The bool
// reports whether the document was retrieved; a 404 (or any non-200) returns
// false with no error so the caller can fall through to the next candidate.
func fetchWellKnown(serverName, wellKnownURL string, out any) (bool, error) {
	req, err := http.NewRequest(http.MethodGet, wellKnownURL, nil)
	if err != nil {
		return false, fmt.Errorf("build request for %s: %w", wellKnownURL, err)
	}
	req.Header.Set("Accept", "application/json")
	// MCP-Protocol-Version is advisory on metadata fetches; some gateways
	// route on it. Harmless where it is ignored.
	req.Header.Set("MCP-Protocol-Version", mcpProtocolVersion)

	client := *network.GetHTTPClient()
	client.Timeout = discoveryTimeout

	resp, err := client.Do(req)
	if err != nil {
		utils.LogWithFields(utils.LevelInfo, "mcp.discovery", "well-known fetch failed", map[string]any{
			"serverName": serverName, "url": wellKnownURL, "error": err.Error(),
		})
		return false, nil
	}
	defer func() {
		if closeErr := resp.Body.Close(); closeErr != nil {
			utils.LogWithFields(utils.LevelInfo, "mcp.discovery", "well-known body close failed", map[string]any{
				"serverName": serverName, "url": wellKnownURL, "error": closeErr.Error(),
			})
		}
	}()

	if resp.StatusCode != http.StatusOK {
		utils.LogWithFields(utils.LevelDebug, "mcp.discovery", "well-known probe missed", map[string]any{
			"serverName": serverName, "url": wellKnownURL, "status": resp.StatusCode,
		})
		return false, nil
	}

	if err := json.NewDecoder(resp.Body).Decode(out); err != nil {
		// A 200 that will not parse is a real defect in the provider's
		// metadata, distinct from a 404: surface it rather than silently
		// falling through to the next candidate.
		utils.LogWithFields(utils.LevelWarn, "mcp.discovery", "well-known document did not parse", map[string]any{
			"serverName": serverName, "url": wellKnownURL, "error": err.Error(),
		})
		return false, nil
	}

	utils.LogWithFields(utils.LevelInfo, "mcp.discovery", "well-known document retrieved", map[string]any{
		"serverName": serverName, "url": wellKnownURL,
	})
	return true, nil
}

// DiscoverProtectedResource fetches the RFC 9728 protected-resource metadata
// for an MCP endpoint URL. Returns an error when neither probe yields a
// document naming at least one authorization server — the caller then knows
// the server is not discovery-capable and an explicit oauth block is required.
//
// Memoized per resource URL for the process lifetime (discovery_cache.go): the
// document is deployment config, and this runs on both the connect path and the
// 401-annotation path, so an uncached call meant two fetches per connect.
func DiscoverProtectedResource(serverName, resourceURL string) (*ProtectedResourceMetadata, error) {
	return cachedProtectedResource(serverName, resourceURL, func() (*ProtectedResourceMetadata, error) {
		return fetchProtectedResource(serverName, resourceURL)
	})
}

// fetchProtectedResource performs the actual probe sequence, uncached.
func fetchProtectedResource(serverName, resourceURL string) (*ProtectedResourceMetadata, error) {
	candidates, err := wellKnownCandidates(resourceURL, "oauth-protected-resource")
	if err != nil {
		return nil, fmt.Errorf("mcp discovery %s: %w", serverName, err)
	}

	for _, candidate := range candidates {
		var doc ProtectedResourceMetadata
		found, fetchErr := fetchWellKnown(serverName, candidate, &doc)
		if fetchErr != nil {
			return nil, fmt.Errorf("mcp discovery %s: %w", serverName, fetchErr)
		}
		if !found {
			continue
		}
		if len(doc.AuthorizationServers) == 0 {
			utils.LogWithFields(utils.LevelWarn, "mcp.discovery", "protected-resource metadata names no authorization server", map[string]any{
				"serverName": serverName, "url": candidate, "resource": doc.Resource,
			})
			continue
		}
		utils.LogWithFields(utils.LevelInfo, "mcp.discovery", "protected resource resolved", map[string]any{
			"serverName": serverName, "url": candidate,
			"resource": doc.Resource, "authServers": doc.AuthorizationServers, "scopes": doc.ScopesSupported,
		})
		return &doc, nil
	}

	return nil, fmt.Errorf("mcp discovery %s: no protected-resource metadata at %s (probed %s)",
		serverName, resourceURL, strings.Join(candidates, ", "))
}

// DiscoverAuthServer fetches RFC 8414 authorization-server metadata for an
// issuer, falling back to the OIDC discovery document. Both probe forms of
// each spelling are tried (see wellKnownCandidates), so an issuer with a path
// component (https://host/auth/v1) resolves either way its provider serves it.
//
// Memoized per issuer for the process lifetime (discovery_cache.go).
func DiscoverAuthServer(serverName, issuer string) (*ServerMetadata, error) {
	return cachedAuthServer(serverName, issuer, func() (*ServerMetadata, error) {
		return fetchAuthServer(serverName, issuer)
	})
}

// fetchAuthServer performs the actual probe sequence, uncached.
func fetchAuthServer(serverName, issuer string) (*ServerMetadata, error) {
	var probed []string
	for _, suffix := range []string{"oauth-authorization-server", "openid-configuration"} {
		candidates, err := wellKnownCandidates(issuer, suffix)
		if err != nil {
			return nil, fmt.Errorf("mcp discovery %s: %w", serverName, err)
		}
		for _, candidate := range candidates {
			probed = append(probed, candidate)
			var doc ServerMetadata
			found, fetchErr := fetchWellKnown(serverName, candidate, &doc)
			if fetchErr != nil {
				return nil, fmt.Errorf("mcp discovery %s: %w", serverName, fetchErr)
			}
			if !found {
				continue
			}
			if doc.AuthorizationEndpoint == "" || doc.TokenEndpoint == "" {
				// A document missing either endpoint cannot drive an
				// authorization-code grant. Keep probing; log so a
				// half-populated provider document is diagnosable.
				utils.LogWithFields(utils.LevelWarn, "mcp.discovery", "authorization-server metadata incomplete", map[string]any{
					"serverName": serverName, "url": candidate,
					"hasAuthorizationEndpoint": doc.AuthorizationEndpoint != "",
					"hasTokenEndpoint":         doc.TokenEndpoint != "",
				})
				continue
			}
			utils.LogWithFields(utils.LevelInfo, "mcp.discovery", "authorization server resolved", map[string]any{
				"serverName": serverName, "url": candidate, "issuer": doc.Issuer,
				"authorizationEndpoint": doc.AuthorizationEndpoint,
				"tokenEndpoint":         doc.TokenEndpoint,
				"registrationEndpoint":  doc.RegistrationEndpoint,
				"supportsDcr":           doc.RegistrationEndpoint != "",
				"scopes":                doc.ScopesSupported,
			})
			return &doc, nil
		}
	}

	return nil, fmt.Errorf("mcp discovery %s: no authorization-server metadata for issuer %s (probed %s)",
		serverName, issuer, strings.Join(probed, ", "))
}

// DiscoverForServer runs the full two-hop discovery for an MCP endpoint URL:
// protected-resource metadata, then the first authorization server it names.
// The returned scope is the resource's advertised scope set (space-joined),
// which is what the authorization request should ask for when the operator
// has expressed no preference.
//
// Memoized per resource URL for the process lifetime (discovery_cache.go).
func DiscoverForServer(serverName, resourceURL string) (meta *ServerMetadata, scope string, err error) {
	return cachedForServer(serverName, resourceURL, func() (*ServerMetadata, string, error) {
		return fetchForServer(serverName, resourceURL)
	})
}

// fetchForServer performs the actual two-hop discovery, uncached. Its two hops
// are themselves memoized, so a miss here can still be served without network
// I/O when the individual documents were already fetched by login.go.
func fetchForServer(serverName, resourceURL string) (*ServerMetadata, string, error) {
	resource, err := DiscoverProtectedResource(serverName, resourceURL)
	if err != nil {
		return nil, "", err
	}

	var lastErr error
	for _, issuer := range resource.AuthorizationServers {
		meta, err := DiscoverAuthServer(serverName, issuer)
		if err != nil {
			lastErr = err
			continue
		}
		return meta, strings.Join(resource.ScopesSupported, " "), nil
	}

	if lastErr != nil {
		return nil, "", lastErr
	}
	return nil, "", fmt.Errorf("mcp discovery %s: protected resource named no reachable authorization server", serverName)
}
