package main

// cmd_auth_login.go — `ion auth login|status|logout`: the operator's OIDC
// sign-in, driven from a terminal. The engine owns the grant; this command
// only starts the login, shows the user-facing half, and waits for the
// engine to report the operator signed in.

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"time"

	"github.com/dsswift/ion/engine/internal/acpagent"
)

// authEngine connects to the running daemon, starting it when it is down.
func authEngine() *acpagent.EngineConn {
	sock := socketPathOrExit()
	releaseSpawnedServer(ensureServer(sock))
	engine, err := acpagent.DialEngine(dialNetwork(sock), sock)
	if err != nil {
		fmt.Fprintf(os.Stderr, "ion auth: %v\n", err)
		os.Exit(1)
	}
	return engine
}

func closeAuthEngine(engine *acpagent.EngineConn) {
	if err := engine.Close(); err != nil {
		fmt.Fprintf(os.Stderr, "ion auth: close engine connection: %v\n", err)
	}
}

func cmdAuthLogin(device bool) {
	engine := authEngine()
	defer closeAuthEngine(engine)
	flow := acpagent.OidcFlowBrowser
	if device {
		flow = acpagent.OidcFlowDevice
	}
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Minute)
	defer cancel()
	status, err := engine.Login(ctx, flow, func(login acpagent.OidcLogin) error {
		if login.UserCode != "" {
			fmt.Printf("Open %s and enter the code %s\n", login.URL, login.UserCode)
			return nil
		}
		fmt.Printf("Sign in in your browser. If it does not open, open this URL:\n%s\n", login.URL)
		if err := openBrowser(login.URL); err != nil {
			fmt.Fprintf(os.Stderr, "ion auth: %v\n", err)
		}
		return nil
	})
	if err != nil {
		fmt.Fprintf(os.Stderr, "ion auth login: %v\n", err)
		os.Exit(1)
	}
	fmt.Printf("Signed in as %s\n", operatorLabel(status))
}

func cmdAuthStatus(asJSON bool) {
	engine := authEngine()
	defer closeAuthEngine(engine)
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	status, err := engine.OidcStatus(ctx)
	if err != nil {
		fmt.Fprintf(os.Stderr, "ion auth status: %v\n", err)
		os.Exit(1)
	}
	if asJSON {
		encoded, err := json.Marshal(map[string]any{
			"signedIn": status.SignedIn, "requireOperatorIdentity": status.RequireOperatorIdentity,
			"provider": status.Provider, "subject": status.Subject, "username": status.Username, "name": status.Name,
		})
		if err != nil {
			fmt.Fprintf(os.Stderr, "ion auth status: %v\n", err)
			os.Exit(1)
		}
		fmt.Println(string(encoded))
	} else if status.SignedIn {
		fmt.Printf("Signed in as %s (%s)\n", operatorLabel(status), status.Provider)
	} else {
		fmt.Println("Not signed in. Run `ion auth login`.")
	}
	if !status.SignedIn {
		os.Exit(1)
	}
}

func cmdAuthLogout() {
	engine := authEngine()
	defer closeAuthEngine(engine)
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	if err := engine.Logout(ctx); err != nil {
		fmt.Fprintf(os.Stderr, "ion auth logout: %v\n", err)
		os.Exit(1)
	}
	fmt.Println("Signed out.")
}

// operatorLabel names the signed-in operator for a terminal line.
func operatorLabel(status acpagent.OidcStatus) string {
	switch {
	case status.Name != "" && status.Username != "":
		return status.Name + " <" + status.Username + ">"
	case status.Username != "":
		return status.Username
	default:
		return status.Subject
	}
}
