package mcp

import "fmt"

// ReauthorizationRequiredError reports a server challenge that needs new user
// consent. It intentionally contains no token material. The transport retries
// neither refresh nor login for this error; a caller starts the asynchronous
// PKCE flow and reconnects after storing the resulting grant.
type ReauthorizationRequiredError struct {
	Scope     string
	Challenge string
	Status    int
}

func (e *ReauthorizationRequiredError) Error() string {
	if e.Scope == "" {
		return fmt.Sprintf("MCP server requires reauthorization (HTTP %d)", e.Status)
	}
	return fmt.Sprintf("MCP server requires reauthorization for scope %q (HTTP %d)", e.Scope, e.Status)
}
