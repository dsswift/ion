package providers

import (
	"context"
	"net/http"
	"strings"
)

// testStaticAuthenticator is the minimal auth.RequestAuthenticator test
// double used across this package's tests to attach a request credential to
// a context before calling a provider's Stream/CountTokens directly.
// Providers no longer hold a credential of their own (R-23), so every test
// that exercises a real HTTP round trip must attach one via
// WithRequestCredential exactly as the run loop does at request time.
type testStaticAuthenticator struct {
	key    string
	header string // "", "bearer" -> Authorization: Bearer; "x-api-key"; "urlkey" -> ?key=; else literal header name
}

func (a testStaticAuthenticator) Authenticate(_ context.Context, req *http.Request, _ []byte) error {
	switch strings.ToLower(a.header) {
	case "bearer", "":
		req.Header.Set("Authorization", "Bearer "+a.key)
	case "x-api-key":
		req.Header.Set("x-api-key", a.key)
	case "api-key":
		req.Header.Set("api-key", a.key)
	case "urlkey":
		q := req.URL.Query()
		q.Set("key", a.key)
		req.URL.RawQuery = q.Encode()
	default:
		req.Header.Set(a.header, a.key)
	}
	return nil
}
