// subject_context.go — carries the acting principal's raw Subject through
// a context.Context (FR-05 child 10, R-43). Distinct from
// utils.WithPrincipalIdentity, which carries a DISPLAY string for
// telemetry/log attribution: TokenProviderForSubject needs the raw,
// normalized Subject to key its lookup, never a human-readable label.
package auth

import "context"

type subjectContextKey struct{}

// WithSubject returns a new context carrying the acting principal's raw
// Subject. Used at the extension-http call site (session/extcontext.go) so
// DoOperatorHTTPRequest (extension package) can resolve
// auth.TokenProviderForSubject without either package needing a direct
// dependency on the other's session-layer types.
func WithSubject(ctx context.Context, subject string) context.Context {
	return context.WithValue(ctx, subjectContextKey{}, subject)
}

// SubjectFromContext returns the Subject carried by ctx, or "" if absent
// (an unattributed call, e.g. a schedule/webhook-triggered extension with
// no session in scope).
func SubjectFromContext(ctx context.Context) string {
	if v, ok := ctx.Value(subjectContextKey{}).(string); ok {
		return v
	}
	return ""
}
