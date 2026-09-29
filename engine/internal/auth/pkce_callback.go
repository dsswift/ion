package auth

// pkce_callback.go — authorization-code + PKCE where the caller receives the
// redirect instead of an engine-owned loopback listener.
//
// StartPKCEFlow binds a loopback port and completes the exchange itself, which
// only works when the browser runs on the engine's host. A consumer on another
// device (a phone, a remote browser) registers its own redirect URI, catches the
// callback there, and hands the callback URL back. BeginPKCEAuthorization and
// PKCEAuthorization.Complete are that split: the same verifier, state, callback
// validation, and code exchange as the loopback flow, with no listener.

import (
	"fmt"
	"net/url"
)

// Callback rejection reasons. They name why a provider callback was refused so
// a caller can log or branch on the cause without matching message text.
const (
	CallbackReasonProviderError = "auth-error"
	CallbackReasonIssuer        = "iss-mismatch"
	CallbackReasonState         = "state-mismatch"
	CallbackReasonMissingCode   = "missing-code"
)

// CallbackError is a refused authorization callback.
type CallbackError struct {
	Reason string
	// httpText is the plain-text body the loopback listener answers with.
	httpText string
	err      error
}

func (e *CallbackError) Error() string { return e.err.Error() }

// validateAuthorizationCallback checks a provider's redirect query against the
// request it answers and returns the authorization code. Both the loopback
// listener and caller-completed flows run exactly this check.
func validateAuthorizationCallback(q url.Values, state, expectedIssuer string) (string, *CallbackError) {
	if errParam := q.Get("error"); errParam != "" {
		return "", &CallbackError{
			Reason: CallbackReasonProviderError,
			err:    fmt.Errorf("authorization error: %s: %s", errParam, q.Get("error_description")),
		}
	}

	// RFC 9207: validate the `iss` parameter before checking state. A missing
	// `iss` is tolerated when the server did not advertise support, but a
	// present `iss` that does not match is always fatal.
	if expectedIssuer != "" {
		if iss := q.Get("iss"); iss != "" && iss != expectedIssuer {
			return "", &CallbackError{
				Reason:   CallbackReasonIssuer,
				httpText: "issuer mismatch",
				err:      fmt.Errorf("issuer mismatch: callback iss=%q, expected %q", iss, expectedIssuer),
			}
		}
	}

	if q.Get("state") != state {
		return "", &CallbackError{Reason: CallbackReasonState, httpText: "state mismatch", err: fmt.Errorf("state mismatch")}
	}

	code := q.Get("code")
	if code == "" {
		return "", &CallbackError{
			Reason:   CallbackReasonMissingCode,
			httpText: "missing code",
			err:      fmt.Errorf("no authorization code in callback"),
		}
	}
	return code, nil
}

// PKCEAuthorization is a started authorization request whose callback the
// caller delivers to Complete.
type PKCEAuthorization struct {
	AuthorizationURL string
	RedirectURI      string

	cfg      PKCEFlowConfig
	verifier string
	state    string
}

// BeginPKCEAuthorization builds an S256 PKCE authorization request against a
// caller-supplied redirect URI. The redirect may be any scheme the provider
// accepts (a custom app scheme, an https page); the engine never listens on it.
// cfg's RedirectHost/Port/Path are ignored.
func BeginPKCEAuthorization(cfg PKCEFlowConfig, redirectURI string) (*PKCEAuthorization, error) {
	if redirectURI == "" {
		return nil, fmt.Errorf("pkce: caller-completed authorization requires a redirect uri")
	}
	verifier, err := generateCodeVerifier()
	if err != nil {
		return nil, fmt.Errorf("pkce: generate verifier: %w", err)
	}
	state, err := generateState()
	if err != nil {
		return nil, fmt.Errorf("pkce: generate state: %w", err)
	}
	authURL, err := buildAuthorizationURL(cfg, redirectURI, generateCodeChallenge(verifier), state)
	if err != nil {
		return nil, fmt.Errorf("pkce: build auth url: %w", err)
	}
	return &PKCEAuthorization{
		AuthorizationURL: authURL,
		RedirectURI:      redirectURI,
		cfg:              cfg,
		verifier:         verifier,
		state:            state,
	}, nil
}

// Complete validates the provider's callback query and exchanges the code with
// the stored verifier and redirect URI. A refused callback returns a
// *CallbackError; an exchange failure returns the exchange error.
func (a *PKCEAuthorization) Complete(callback url.Values) (*TokenResponse, error) {
	code, rejection := validateAuthorizationCallback(callback, a.state, a.cfg.ExpectedIssuer)
	if rejection != nil {
		return nil, rejection
	}
	return exchangeCodeForToken(a.cfg, code, a.verifier, a.RedirectURI)
}
