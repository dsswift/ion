package mcp

// cimd.go — Client ID Metadata Document (CIMD) resolution.
//
// A CIMD is a URI that serves a JSON document containing pre-registered
// OAuth client metadata: client_id and optionally client_secret,
// redirect_uris, scope, etc. It lets an operator point the engine at a
// pre-registered client without embedding the client_id in engine.json.
//
// Priority in ResolveClient: explicit oauth.client_id > CIMD > stored DCR > fresh DCR.

import (
	"encoding/json"
	"fmt"
	"net/http"
	"time"

	"github.com/dsswift/ion/engine/internal/network"
	"github.com/dsswift/ion/engine/internal/types"
	"github.com/dsswift/ion/engine/internal/utils"
)

const cimdFetchTimeout = 30 * time.Second

// cimdResponse is the subset of a Client ID Metadata Document the engine
// consumes. Only client_id is required; everything else has defaults or
// falls through to discovery.
type cimdResponse struct {
	ClientID     string   `json:"client_id"`
	ClientSecret string   `json:"client_secret"`
	RedirectURIs []string `json:"redirect_uris"`
	Scope        string   `json:"scope"`
}

// fetchClientMetadataDocument retrieves a Client ID Metadata Document from
// the URI configured in oauth.client_metadata_uri, then resolves the
// authorization endpoints via discovery if the operator did not configure
// them explicitly.
func fetchClientMetadataDocument(serverName string, cfg types.McpServerConfig, scopeOverride string) (*ClientRegistration, error) {
	uri := cfg.OAuth.ClientMetadataURI

	utils.LogWithFields(utils.LevelInfo, "mcp.cimd", "fetching client metadata document", map[string]any{
		"serverName": serverName, "uri": uri,
	})

	req, err := http.NewRequest(http.MethodGet, uri, nil)
	if err != nil {
		return nil, fmt.Errorf("build request: %w", err)
	}
	req.Header.Set("Accept", "application/json")

	client := *network.GetHTTPClient()
	client.Timeout = cimdFetchTimeout

	resp, err := client.Do(req)
	if err != nil {
		return nil, fmt.Errorf("fetch %s: %w", uri, err)
	}
	defer func() {
		if closeErr := resp.Body.Close(); closeErr != nil {
			utils.LogWithFields(utils.LevelInfo, "mcp.cimd", "response body close failed", map[string]any{
				"serverName": serverName, "error": closeErr.Error(),
			})
		}
	}()

	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("fetch %s: status %d", uri, resp.StatusCode)
	}

	var doc cimdResponse
	if err := json.NewDecoder(resp.Body).Decode(&doc); err != nil {
		return nil, fmt.Errorf("parse %s: %w", uri, err)
	}
	if doc.ClientID == "" {
		return nil, fmt.Errorf("document at %s has no client_id", uri)
	}

	scope := doc.Scope
	if scopeOverride != "" {
		scope = scopeOverride
	}

	var redirectURI string
	if len(doc.RedirectURIs) > 0 {
		redirectURI = doc.RedirectURIs[0]
	}

	reg := &ClientRegistration{
		ClientID:     doc.ClientID,
		ClientSecret: doc.ClientSecret,
		Scope:        scope,
		RedirectURI:  redirectURI,
		Resource:     cfg.OAuth.Resource,
	}

	// Fill endpoints from operator config or discovery.
	if cfg.OAuth != nil {
		if cfg.OAuth.AuthURL != "" {
			reg.AuthURL = cfg.OAuth.AuthURL
		}
		if cfg.OAuth.TokenURL != "" {
			reg.TokenURL = cfg.OAuth.TokenURL
		}
	}
	if reg.AuthURL == "" || reg.TokenURL == "" {
		if cfg.URL == "" {
			return nil, fmt.Errorf("cimd client resolved but no auth_url/token_url configured and server has no url for discovery")
		}
		meta, discoveredScope, discErr := DiscoverForServer(serverName, cfg.URL)
		if discErr != nil {
			return nil, fmt.Errorf("discovery for endpoints: %w", discErr)
		}
		if reg.AuthURL == "" {
			reg.AuthURL = meta.AuthorizationEndpoint
		}
		if reg.TokenURL == "" {
			reg.TokenURL = meta.TokenEndpoint
		}
		if reg.Scope == "" {
			reg.Scope = discoveredScope
		}
		reg.Issuer = meta.Issuer
		if reg.Resource == "" {
			reg.Resource = resourceFromDiscovery(serverName, cfg.URL)
		}
	}

	utils.LogWithFields(utils.LevelInfo, "mcp.cimd", "client metadata document resolved", map[string]any{
		"serverName": serverName, "clientId": reg.ClientID,
		"authUrl": reg.AuthURL, "tokenUrl": reg.TokenURL, "scope": reg.Scope,
		"hasSecret": reg.ClientSecret != "",
	})
	return reg, nil
}
