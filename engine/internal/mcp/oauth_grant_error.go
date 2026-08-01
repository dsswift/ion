package mcp

// oauth_grant_error.go — classifying a refused refresh.
//
// A refresh can fail two ways that call for opposite responses:
//
//   - Transient: a 500, a timeout, a network blip. The grant is fine; the next
//     attempt will probably work. Nothing for the operator to do.
//   - Permanent: the refresh token is spent, revoked, or the client was deleted.
//     No amount of retrying helps. The operator must re-authorize interactively,
//     and until they do, every tool on that server stays unavailable.
//
// Both used to surface identically — "refresh token failed with status 400" plus
// a raw provider body. That reads like a glitch, so the natural response is to
// retry or wait, which never resolves a spent grant. The distinction matters
// enough to name: the whole point of the refresh machinery is that expiry
// recovers silently, so the one case that genuinely needs a human should say so
// in those terms.
//
// The trigger for this file: a spent Supabase grant surfaced as
// `refresh_token_already_used` inside a generic failure, and the log gave no
// indication that `ion mcp login` was the fix.

import (
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"sync"
)

// ErrGrantUnrecoverable marks a refresh failure that re-running cannot fix.
// Callers test for it with errors.Is to decide whether to advise re-authorizing
// rather than retrying.
var ErrGrantUnrecoverable = errors.New("oauth grant is no longer valid")

// GrantError describes a refused refresh in terms an operator can act on.
type GrantError struct {
	ServerName string
	// Status is the HTTP status the token endpoint returned.
	Status int
	// Code is the provider's machine-readable reason, from either the RFC 6749
	// `error` field or a provider extension such as Supabase's `error_code`.
	Code string
	// Description is the provider's human-readable message, when it sent one.
	Description string
	// Unrecoverable reports whether the grant is permanently dead.
	Unrecoverable bool
}

func (e *GrantError) Error() string {
	var b strings.Builder
	fmt.Fprintf(&b, "refresh failed for %s", e.ServerName)
	switch {
	case e.Code != "":
		fmt.Fprintf(&b, " (%s", e.Code)
		if e.Description != "" {
			fmt.Fprintf(&b, ": %s", e.Description)
		}
		b.WriteString(")")
	case e.Status > 0 && e.Description != "":
		// No parseable code, but the provider said something. Carry both so the
		// message is never less informative than the pre-classification form.
		fmt.Fprintf(&b, " with status %d: %s", e.Status, e.Description)
	case e.Status > 0:
		fmt.Fprintf(&b, " with status %d", e.Status)
	}
	if e.Unrecoverable {
		// The remediation is the payload of this message. An operator reading
		// engine.jsonl needs the command, not a diagnosis they must translate.
		fmt.Fprintf(&b, " — the stored authorization for %q can no longer be renewed; run `ion mcp login %s` to re-authorize",
			e.ServerName, e.ServerName)
	}
	return b.String()
}

// Unwrap lets errors.Is(err, ErrGrantUnrecoverable) work for the permanent case
// while a transient failure stays a plain error.
func (e *GrantError) Unwrap() error {
	if e.Unrecoverable {
		return ErrGrantUnrecoverable
	}
	return nil
}

// unrecoverableGrantCodes are the OAuth error codes that mean "this grant is
// finished — stop retrying and re-authorize".
//
// `invalid_grant` is the RFC 6749 code for a refresh token that is expired,
// revoked, or already consumed, and is what most providers return.
// `refresh_token_already_used` is Supabase's more specific `error_code` for a
// rotated single-use token, which is the exact failure this classification was
// built for. `invalid_client` and `unauthorized_client` mean the client
// registration itself is gone (deleted at the provider, or the stored
// dynamic-registration record no longer matches), which re-registration during
// the next login repairs.
var unrecoverableGrantCodes = map[string]bool{
	"invalid_grant":              true,
	"refresh_token_already_used": true,
	"refresh_token_not_found":    true,
	"invalid_client":             true,
	"unauthorized_client":        true,
	"unsupported_grant_type":     true,
}

// providerErrorBody is the union of the error shapes token endpoints return:
// RFC 6749's `error`/`error_description`, plus the `error_code`/`msg` pair
// Supabase and some others use.
type providerErrorBody struct {
	Error            string `json:"error"`
	ErrorDescription string `json:"error_description"`
	ErrorCode        string `json:"error_code"`
	Message          string `json:"msg"`
}

// classifyGrantFailure turns a token-endpoint rejection into a GrantError.
//
// Classification is by error CODE, not status. A 400 covers both a spent grant
// and a malformed request, and providers disagree on which status accompanies
// which code, so the code is the only reliable signal. A 401 or 403 with no
// parseable code is treated as unrecoverable on the reasoning that the endpoint
// refused the credential itself; a 5xx never is.
func classifyGrantFailure(serverName string, status int, body []byte) *GrantError {
	grantErr := &GrantError{ServerName: serverName, Status: status}

	var parsed providerErrorBody
	if len(body) > 0 && json.Unmarshal(body, &parsed) == nil {
		// Prefer the provider-specific code: it is strictly more informative
		// than the RFC bucket it maps into.
		grantErr.Code = parsed.ErrorCode
		if grantErr.Code == "" {
			grantErr.Code = parsed.Error
		}
		grantErr.Description = parsed.ErrorDescription
		if grantErr.Description == "" {
			grantErr.Description = parsed.Message
		}
	}

	switch {
	case grantErr.Code != "" && unrecoverableGrantCodes[grantErr.Code]:
		grantErr.Unrecoverable = true
	case status >= 500:
		// Server-side trouble. The grant is very likely fine.
		grantErr.Unrecoverable = false
	case grantErr.Code == "" && (status == 401 || status == 403):
		// The endpoint refused the credential and told us nothing more.
		grantErr.Unrecoverable = true
	}

	// Keep the raw body when the provider sent something unparseable, so the
	// error is never less informative than it was before classification. Bounded,
	// because a token endpoint behind a proxy can answer with a full HTML page.
	if grantErr.Code == "" && grantErr.Description == "" && len(body) > 0 {
		raw := strings.TrimSpace(string(body))
		if len(raw) > 200 {
			raw = raw[:200] + "…"
		}
		grantErr.Description = raw
	}

	return grantErr
}

// lastGrantErrors records the most recent unrecoverable refresh failure per
// server, so a later connect failure can cite the real cause.
//
// Why this indirection is needed: when a grant is spent, resolveOAuthHeaders
// cannot produce a token, so the request goes out unauthenticated and the server
// answers a plain 401. By the time Connect builds its error, the specific reason
// ("already used") is two layers back. Without carrying it, the operator is told
// "this server requires authorization" — true, but it reads like the server was
// never set up, when in fact their grant died. Recording the classification lets
// the connect error say which of those two situations they are in.
//
// Cleared on a successful refresh and on login, so a stale reason can never
// outlive the problem it described.
var lastGrantErrors sync.Map // serverName -> *GrantError

// recordGrantFailure stores an unrecoverable grant failure for later citation.
// Recoverable failures are not recorded: they resolve on their own, and citing
// one would misattribute a transient blip as a dead credential.
func recordGrantFailure(serverName string, grantErr *GrantError) {
	if grantErr == nil || !grantErr.Unrecoverable {
		return
	}
	lastGrantErrors.Store(serverName, grantErr)
}

// clearGrantFailure forgets a recorded failure after the grant works again.
func clearGrantFailure(serverName string) {
	lastGrantErrors.Delete(serverName)
}

// lastGrantFailure returns the recorded unrecoverable failure for a server, or
// nil when the grant has not permanently failed.
func lastGrantFailure(serverName string) *GrantError {
	v, ok := lastGrantErrors.Load(serverName)
	if !ok {
		return nil
	}
	grantErr, ok := v.(*GrantError)
	if !ok {
		return nil
	}
	return grantErr
}
