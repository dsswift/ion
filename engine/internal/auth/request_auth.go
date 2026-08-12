package auth

import (
	"bytes"
	"context"
	"fmt"
	"io"
	"net/http"
	"time"

	"github.com/dsswift/ion/engine/internal/awssig"
)

// RequestAuthenticator injects authentication into an engine-owned request.
// Raw credentials never appear in extension request params or responses.
type RequestAuthenticator interface {
	Authenticate(ctx context.Context, req *http.Request, body []byte) error
}

type BearerAuthenticator struct {
	Provider TokenProvider
	Scope    string
	Audience string
}

func (a BearerAuthenticator) Authenticate(ctx context.Context, req *http.Request, _ []byte) error {
	if a.Provider == nil {
		return fmt.Errorf("no identity token provider available (configure auth.identityProvider in engine.json)")
	}
	token, err := a.Provider.GetTokenWithAudience(ctx, a.Scope, a.Audience)
	if err != nil {
		return err
	}
	req.Header.Set("Authorization", "Bearer "+token)
	return nil
}

type SigV4Authenticator struct {
	Provider AWSCredentialsProvider
	Service  string
	Region   string
	Clock    func() time.Time
}

func (a SigV4Authenticator) Authenticate(ctx context.Context, req *http.Request, body []byte) error {
	if a.Provider == nil {
		return fmt.Errorf("no AWS credential provider available")
	}
	if a.Service == "" || a.Region == "" {
		return fmt.Errorf("AWS authentication requires awsService and awsRegion")
	}
	credentials, err := a.Provider.Retrieve(ctx)
	if err != nil {
		return err
	}
	if body != nil {
		req.Body = io.NopCloser(bytes.NewReader(body))
	}
	clock := a.Clock
	if clock == nil {
		clock = func() time.Time { return time.Now().UTC() }
	}
	signer := awssig.Signer{
		Service: a.Service,
		Region:  a.Region,
		Creds: awssig.Credentials{
			AccessKeyID: credentials.AccessKeyID, SecretAccessKey: credentials.SecretAccessKey,
			SessionToken: credentials.SessionToken,
		},
		Clock: clock,
	}
	return signer.SignRequest(req, body)
}
