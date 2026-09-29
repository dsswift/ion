package auth

import (
	"testing"

	"github.com/dsswift/ion/engine/internal/types"
)

// One person must read as one telemetry user whether a line is stamped from
// their session (SessionPrincipal.AttributionForTelemetry) or from the
// engine's own signed-in identity (OperatorIdentity.AttributionValue, the
// process-wide egress user). A signed-in desktop stamps the second; a server
// fronting bearer sign-in stamps the first for the same token claims.
func TestSessionAttributionMatchesSignedInIdentity(t *testing.T) {
	cases := []struct {
		name string
		id   OperatorIdentity
	}{
		{"attribution claim wins", OperatorIdentity{Subject: "sub-1", Username: "user@example.com", Name: "A User", Attribution: "custom"}},
		{"preferred_username before display name", OperatorIdentity{Subject: "sub-1", Username: "user@example.com", Name: "A User"}},
		{"preferred_username alone", OperatorIdentity{Subject: "sub-1", Username: "user@example.com"}},
		{"subject alone", OperatorIdentity{Subject: "sub-1"}},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			principal := &types.SessionPrincipal{
				Subject:     c.id.Subject,
				Username:    c.id.Username,
				DisplayName: c.id.Name,
				Attribution: c.id.Attribution,
			}
			if got, want := principal.AttributionForTelemetry(), c.id.AttributionValue(); got != want {
				t.Fatalf("session attribution %q, signed-in identity %q", got, want)
			}
		})
	}
}
