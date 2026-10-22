package acpagent

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/dsswift/ion/engine/internal/types"
	"github.com/dsswift/ion/engine/internal/utils"
)

// OIDC login flows the engine runs (oidc_begin_login oidcFlow).
const (
	// OidcFlowBrowser is the interactive authorization-code + PKCE flow. The
	// engine's loopback callback completes it, so the browser must run on
	// the engine's machine.
	OidcFlowBrowser = "pkce"
	// OidcFlowDevice is the device-code flow: the user enters a code on any
	// device while the engine polls.
	OidcFlowDevice = "device"
)

// OidcStatus is the engine's operator identity snapshot (oidc_identity).
type OidcStatus struct {
	SignedIn                bool
	RequireOperatorIdentity bool
	Provider                string
	Subject                 string
	Username                string
	Name                    string
}

// OidcLogin is the user-facing half of a login the engine started: a URL to
// open (browser flow), or a code to enter at a URL (device flow).
type OidcLogin struct {
	URL      string
	UserCode string
}

// OidcStatus asks the engine who the operator is.
func (c *EngineConn) OidcStatus(ctx context.Context) (OidcStatus, error) {
	res, err := c.Send(ctx, map[string]any{"cmd": "oidc_identity"})
	if err != nil {
		return OidcStatus{}, err
	}
	data, _ := res["data"].(map[string]any)               //nolint:errcheck // a result without data reads as signed out
	signedIn, _ := data["signedIn"].(bool)                //nolint:errcheck // absent is false
	required, _ := data["requireOperatorIdentity"].(bool) //nolint:errcheck // absent is false
	return OidcStatus{
		SignedIn: signedIn, RequireOperatorIdentity: required,
		Provider: str(data, "provider"), Subject: str(data, "subject"),
		Username: str(data, "username"), Name: str(data, "name"),
	}, nil
}

// Login starts an operator login, hands its user-facing half to show, and
// waits until the engine reports the operator signed in. show returning an
// error abandons the wait (the user declined). ctx bounds the whole flow.
func (c *EngineConn) Login(ctx context.Context, flow string, show func(OidcLogin) error) (OidcStatus, error) {
	// Identity snapshots are broadcast with no session key; subscribe before
	// the login starts so a fast completion is not missed.
	events := c.Subscribe("")
	defer c.Unsubscribe("")
	res, err := c.Send(ctx, map[string]any{"cmd": "oidc_begin_login", "oidcFlow": flow})
	if err != nil {
		return OidcStatus{}, err
	}
	data, _ := res["data"].(map[string]any) //nolint:errcheck // checked below by the missing URL
	login := OidcLogin{URL: str(data, "authorizationUrl"), UserCode: str(data, "userCode")}
	if flow == OidcFlowDevice {
		login.URL = str(data, "verificationUri")
	}
	if login.URL == "" {
		return OidcStatus{}, errors.New("the engine started a login but returned no sign-in URL")
	}
	utils.LogWithFields(utils.LevelInfo, "acp", "oidc login started", map[string]any{"flow": flow})
	if err := show(login); err != nil {
		utils.LogWithFields(utils.LevelInfo, "acp", "oidc login abandoned", map[string]any{"flow": flow, "error": err.Error()})
		return OidcStatus{}, err
	}
	for {
		ev, ok := events.Next(ctx, c.Closed())
		if !ok {
			if ctx.Err() != nil {
				return OidcStatus{}, fmt.Errorf("sign-in did not complete: %w", ctx.Err())
			}
			return OidcStatus{}, errors.New("the engine connection closed before sign-in completed")
		}
		if ev.Type != types.EventOidcIdentity {
			continue
		}
		if signedIn, _ := ev.Event["oidcSignedIn"].(bool); !signedIn { //nolint:errcheck // absent is signed out
			continue
		}
		status := OidcStatus{
			SignedIn: true, Provider: str(ev.Event, "oidcProvider"), Subject: str(ev.Event, "oidcSubject"),
			Username: str(ev.Event, "oidcUsername"), Name: str(ev.Event, "oidcDisplayName"),
		}
		if required, ok := ev.Event["oidcRequired"].(bool); ok {
			status.RequireOperatorIdentity = required
		}
		utils.LogWithFields(utils.LevelInfo, "acp", "oidc login completed", map[string]any{"flow": flow, "signed_in_user": status.Username})
		return status, nil
	}
}

// Logout signs the operator out of the engine.
func (c *EngineConn) Logout(ctx context.Context) error {
	_, err := c.Send(ctx, map[string]any{"cmd": "oidc_logout"})
	return err
}

// oidcLoginTimeout bounds a sign-in the user has to finish in a browser.
const oidcLoginTimeout = 10 * time.Minute
