package main

// browser.go — opening a URL in the operator's browser.
//
// The engine daemon never does this: it is headless and may be running for a
// different user or with no session at all, so it returns an authorization URL
// and lets the consumer decide how to surface it. The CLI is a consumer running
// as the operator in their own session, so opening the browser is its job.

import (
	"fmt"
	"os/exec"
	"runtime"
)

// openBrowser opens url in the platform's default browser.
//
// Failure is returned rather than swallowed: the caller prints the URL so the
// operator can open it by hand. A silent failure here would leave them waiting
// on a browser window that is never coming.
func openBrowser(url string) error {
	var cmd *exec.Cmd
	switch runtime.GOOS {
	case "darwin":
		cmd = exec.Command("open", url)
	case "windows":
		// rundll32 avoids cmd.exe's `start`, which treats & and other URL
		// characters as shell metacharacters.
		cmd = exec.Command("rundll32", "url.dll,FileProtocolHandler", url)
	default:
		// xdg-open covers the freedesktop platforms; a headless Linux host
		// legitimately has no browser, which is why the caller always prints
		// the URL as well.
		cmd = exec.Command("xdg-open", url)
	}
	if err := cmd.Start(); err != nil {
		return fmt.Errorf("open browser via %s: %w", cmd.Path, err)
	}
	// Reap the child so it does not linger as a zombie for the life of the CLI
	// process. The handler exits immediately after handing off to the browser;
	// its exit status says nothing about whether the page loaded, so it is
	// deliberately not treated as the operation's success.
	go func() { _ = cmd.Wait() }() //nolint:errcheck // exit status is not meaningful for a browser handoff
	return nil
}
