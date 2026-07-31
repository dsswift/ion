package mcp

// register.go — RFC 7591 OAuth 2.0 Dynamic Client Registration.
//
// Servers like the one behind api.mobbin.com issue no static client_id: the
// client registers itself and receives one. Without this, an operator has
// nothing to put in engine.json's `oauth.client_id` and the grant cannot
// start at all.
//
// The engine registers as a PUBLIC client (token_endpoint_auth_method "none"):
// it runs on the operator's machine and cannot keep a secret. When a server
// nonetheless returns a client_secret, it is stored and used — some providers
// issue one regardless of the requested auth method.

import (
	"bytes"
	"encoding/json"
	"fmt"
	"net/http"
	"time"

	"github.com/dsswift/ion/engine/internal/network"
	"github.com/dsswift/ion/engine/internal/utils"
)

// registrationTimeout bounds the registration POST. Registration happens on
// the interactive login path, so a hung endpoint must fail rather than hang.
const registrationTimeout = 30 * time.Second

// clientName is the client_name presented to authorization servers during
// dynamic registration. Providers surface it on the user's consent screen and
// in their client list, so it identifies Ion rather than the operator.
const clientName = "Ion Engine"

// registrationRequest is the RFC 7591 client-metadata document the engine
// submits. Only the fields the engine actually relies on are sent — a minimal
// request is accepted by more servers than a maximal one.
type registrationRequest struct {
	ClientName              string   `json:"client_name"`
	RedirectURIs            []string `json:"redirect_uris"`
	GrantTypes              []string `json:"grant_types"`
	ResponseTypes           []string `json:"response_types"`
	TokenEndpointAuthMethod string   `json:"token_endpoint_auth_method"`
	Scope                   string   `json:"scope,omitempty"`
	ApplicationType         string   `json:"application_type"`
}

// registrationResponse is the subset of the RFC 7591 registration response the
// engine consumes.
type registrationResponse struct {
	ClientID     string `json:"client_id"`
	ClientSecret string `json:"client_secret"`
	// RFC 7591 error shape, returned with a 4xx status.
	Error            string `json:"error"`
	ErrorDescription string `json:"error_description"`
}

// RegisterClient obtains an OAuth client for an MCP server via dynamic
// registration and persists it.
//
// Idempotent: when a registration is already stored for serverName whose
// endpoints still match the supplied metadata, that record is returned and no
// HTTP request is made. A metadata mismatch (the provider moved its endpoints,
// or the operator repointed the server at a different issuer) re-registers,
// because the stored client_id belongs to the OLD authorization server and
// would be rejected by the new one.
//
// redirectURI must be the exact loopback URI the PKCE flow will use. RFC 7591
// registration binds the redirect URI, so a mismatch at authorization time is
// rejected by the provider. Because auth.StartPKCEFlow assigns an ephemeral
// port, callers register the fixed-port URI they then pin the flow to (see
// login.go).
func RegisterClient(serverName string, meta *ServerMetadata, redirectURI, scope string) (*ClientRegistration, error) {
	if meta == nil {
		return nil, fmt.Errorf("mcp register %s: no authorization-server metadata", serverName)
	}

	store := getClientStore()
	if existing := store.Get(serverName); existing != nil {
		if existing.AuthURL == meta.AuthorizationEndpoint && existing.TokenURL == meta.TokenEndpoint {
			utils.LogWithFields(utils.LevelInfo, "mcp.register", "reusing stored client registration", map[string]any{
				"serverName": serverName, "clientId": existing.ClientID, "issuer": existing.Issuer,
			})
			return existing, nil
		}
		utils.LogWithFields(utils.LevelWarn, "mcp.register", "stored registration endpoints no longer match; re-registering", map[string]any{
			"serverName": serverName,
			"storedAuth": existing.AuthURL, "discoveredAuth": meta.AuthorizationEndpoint,
			"storedToken": existing.TokenURL, "discoveredToken": meta.TokenEndpoint,
		})
	}

	if meta.RegistrationEndpoint == "" {
		return nil, fmt.Errorf("mcp register %s: authorization server %s does not support dynamic client registration; "+
			"set mcpServers.%s.oauth.client_id in engine.json", serverName, meta.Issuer, serverName)
	}

	if err := store.verifyWritable(); err != nil {
		// Registering a client we cannot persist would orphan it with the
		// provider and re-register on every login. Refuse up front.
		return nil, fmt.Errorf("mcp register %s: %w", serverName, err)
	}

	reqBody := registrationRequest{
		ClientName:              clientName,
		RedirectURIs:            []string{redirectURI},
		GrantTypes:              []string{"authorization_code", "refresh_token"},
		ResponseTypes:           []string{"code"},
		TokenEndpointAuthMethod: "none",
		Scope:                   scope,
		ApplicationType:         "native",
	}
	payload, err := json.Marshal(reqBody)
	if err != nil {
		return nil, fmt.Errorf("mcp register %s: marshal request: %w", serverName, err)
	}

	utils.LogWithFields(utils.LevelInfo, "mcp.register", "submitting dynamic client registration", map[string]any{
		"serverName": serverName, "endpoint": meta.RegistrationEndpoint,
		"redirectUri": redirectURI, "scope": scope,
	})

	req, err := http.NewRequest(http.MethodPost, meta.RegistrationEndpoint, bytes.NewReader(payload))
	if err != nil {
		return nil, fmt.Errorf("mcp register %s: build request: %w", serverName, err)
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Accept", "application/json")

	client := *network.GetHTTPClient()
	client.Timeout = registrationTimeout

	resp, err := client.Do(req)
	if err != nil {
		return nil, fmt.Errorf("mcp register %s: post to %s: %w", serverName, meta.RegistrationEndpoint, err)
	}
	defer func() {
		if closeErr := resp.Body.Close(); closeErr != nil {
			utils.LogWithFields(utils.LevelInfo, "mcp.register", "registration body close failed", map[string]any{
				"serverName": serverName, "error": closeErr.Error(),
			})
		}
	}()

	var regResp registrationResponse
	decodeErr := json.NewDecoder(resp.Body).Decode(&regResp)

	// RFC 7591 specifies 201 Created; providers in the wild also return 200.
	if resp.StatusCode != http.StatusCreated && resp.StatusCode != http.StatusOK {
		if regResp.Error != "" {
			utils.LogWithFields(utils.LevelError, "mcp.register", "registration rejected", map[string]any{
				"serverName": serverName, "endpoint": meta.RegistrationEndpoint, "status": resp.StatusCode,
				"oauthError": regResp.Error, "description": regResp.ErrorDescription,
			})
			return nil, fmt.Errorf("mcp register %s: %s: %s", serverName, regResp.Error, regResp.ErrorDescription)
		}
		utils.LogWithFields(utils.LevelError, "mcp.register", "registration returned unexpected status", map[string]any{
			"serverName": serverName, "endpoint": meta.RegistrationEndpoint, "status": resp.StatusCode,
		})
		return nil, fmt.Errorf("mcp register %s: registration endpoint returned status %d", serverName, resp.StatusCode)
	}

	if decodeErr != nil {
		return nil, fmt.Errorf("mcp register %s: parse registration response: %w", serverName, decodeErr)
	}
	if regResp.ClientID == "" {
		return nil, fmt.Errorf("mcp register %s: registration response carried no client_id", serverName)
	}

	reg := &ClientRegistration{
		ClientID:     regResp.ClientID,
		ClientSecret: regResp.ClientSecret,
		Issuer:       meta.Issuer,
		AuthURL:      meta.AuthorizationEndpoint,
		TokenURL:     meta.TokenEndpoint,
		Scope:        scope,
		RedirectURI:  redirectURI,
		RegisteredAt: time.Now(),
	}
	store.Set(serverName, reg)

	utils.LogWithFields(utils.LevelInfo, "mcp.register", "dynamic client registration succeeded", map[string]any{
		"serverName": serverName, "clientId": reg.ClientID, "issuer": reg.Issuer,
		"hasSecret": reg.ClientSecret != "",
	})
	return reg, nil
}
