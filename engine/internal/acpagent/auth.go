package acpagent

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"

	"github.com/dsswift/ion/engine/internal/rpcstdio"
	"github.com/dsswift/ion/engine/internal/utils"
)

// AuthMethodOidc is the id of the one sign-in method the agent offers: the
// engine's operator OIDC login.
const AuthMethodOidc = "ion-oidc"

// errAuthRequired marks a refusal the client can cure by signing in.
var errAuthRequired = errors.New("authentication required")

// SignIn is the operator sign-in an agent offers its client.
type SignIn struct {
	// Provider names the engine's identity provider (auth.identityProvider),
	// shown in the method's description.
	Provider string
	// OpenURL opens a sign-in URL on this machine. Used when the client
	// cannot show a URL itself; nil leaves such a client without sign-in.
	OpenURL func(url string) error
}

// authMethods is the initialize authMethods list: the OIDC login when the
// engine has an identity provider, else none.
func (o Options) authMethods() []AuthMethod {
	if o.SignIn == nil {
		return []AuthMethod{}
	}
	return []AuthMethod{{
		ID:          AuthMethodOidc,
		Name:        "Sign in",
		Description: fmt.Sprintf("Sign in to %s in your browser", o.SignIn.Provider),
	}}
}

// authCapabilities advertises logout alongside the sign-in.
func (o Options) authCapabilities() *AgentAuthCapabilities {
	if o.SignIn == nil {
		return nil
	}
	return &AgentAuthCapabilities{Logout: &struct{}{}}
}

// authenticate runs the engine's browser login. The sign-in URL goes to the
// client as a url elicitation scoped to this request; a client that cannot
// show one gets the URL opened on this machine instead. The request answers
// once the engine reports the operator signed in.
func (a *Agent) authenticate(id, params json.RawMessage) (any, *rpcstdio.RPCError) {
	var req AuthenticateRequest
	if err := json.Unmarshal(params, &req); err != nil {
		return nil, badParams(err)
	}
	if a.opts.SignIn == nil || req.MethodID != AuthMethodOidc {
		return nil, &rpcstdio.RPCError{Code: -32602, Message: "unknown authentication method: " + req.MethodID}
	}
	ctx, cancel := context.WithTimeout(context.Background(), oidcLoginTimeout)
	defer cancel()
	var elicitationID string
	status, err := a.engine.Login(ctx, OidcFlowBrowser, func(login OidcLogin) error {
		var showErr error
		elicitationID, showErr = a.showSignInURL(ctx, id, login.URL)
		return showErr
	})
	if err == nil && elicitationID != "" {
		if notifyErr := a.rpc.Notify(NotifElicitationComplet, ElicitationCompleteNotification{ElicitationID: elicitationID}); notifyErr != nil {
			utils.LogWithFields(utils.LevelWarn, "acp", "elicitation complete not delivered", map[string]any{"error": notifyErr.Error()})
		}
	}
	if err != nil {
		utils.LogWithFields(utils.LevelWarn, "acp", "authenticate failed", map[string]any{"error": err.Error()})
		return nil, fmtErr("sign-in failed: %v", err)
	}
	utils.LogWithFields(utils.LevelInfo, "acp", "authenticated", map[string]any{"signed_in_user": status.Username})
	return map[string]any{}, nil
}

// showSignInURL puts the sign-in URL in front of the user and returns the
// elicitation id it used, empty when the URL was opened locally. An error
// means the user declined or the URL could not be shown at all.
func (a *Agent) showSignInURL(ctx context.Context, requestID json.RawMessage, url string) (string, error) {
	if !a.clientSupportsURLs() {
		if a.opts.SignIn.OpenURL == nil {
			return "", errors.New("this client cannot show a sign-in URL")
		}
		utils.LogWithFields(utils.LevelInfo, "acp", "sign-in url opened locally", nil)
		return "", a.opts.SignIn.OpenURL(url)
	}
	b := make([]byte, 8)
	if _, err := rand.Read(b); err != nil {
		return "", fmt.Errorf("mint elicitation id: %w", err)
	}
	elicitationID := "ion-signin-" + hex.EncodeToString(b)
	raw, err := a.rpc.Request(ctx, ReqElicitationCreate, ElicitationURLRequest{
		Mode: "url", ElicitationID: elicitationID, URL: url, RequestID: requestID,
		Message: fmt.Sprintf("Sign in to %s to continue.", a.opts.SignIn.Provider),
	})
	if err != nil {
		return "", fmt.Errorf("show sign-in url: %w", err)
	}
	var res ElicitationCreateResponse
	if err := json.Unmarshal(raw, &res); err != nil {
		return "", fmt.Errorf("read sign-in url answer: %w", err)
	}
	utils.LogWithFields(utils.LevelInfo, "acp", "sign-in url answered", map[string]any{"action": res.Action})
	if res.Action != "accept" {
		return elicitationID, fmt.Errorf("sign-in %s", res.Action)
	}
	return elicitationID, nil
}

// logout signs the operator out of the engine.
func (a *Agent) logout() (any, *rpcstdio.RPCError) {
	if a.opts.SignIn == nil {
		return nil, &rpcstdio.RPCError{Code: -32601, Message: "method not found: " + MethodLogout}
	}
	ctx, cancel := context.WithTimeout(context.Background(), clientAnswerTimeout)
	defer cancel()
	if err := a.engine.Logout(ctx); err != nil {
		utils.LogWithFields(utils.LevelWarn, "acp", "logout failed", map[string]any{"error": err.Error()})
		return nil, internalError(err)
	}
	utils.LogWithFields(utils.LevelInfo, "acp", "logged out", nil)
	return map[string]any{}, nil
}

// clientSupportsURLs reports whether the client shows url elicitations.
func (a *Agent) clientSupportsURLs() bool {
	a.mu.Lock()
	defer a.mu.Unlock()
	e := a.client.Elicitation
	return e != nil && len(e.URL) > 0 && string(e.URL) != "null"
}
