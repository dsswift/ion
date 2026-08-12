package extension

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/dsswift/ion/engine/internal/auth"
)

type staticAWSProvider struct{}

func (staticAWSProvider) Kind() string { return "test" }
func (staticAWSProvider) Retrieve(context.Context) (*auth.AWSCredentials, error) {
	return &auth.AWSCredentials{
		AccessKeyID: "AKID", SecretAccessKey: "secret", SessionToken: "session",
		ExpiresAt: time.Now().Add(time.Hour),
	}, nil
}

func TestAuthenticatedHTTP_SigV4OverwritesExtensionAuthorization(t *testing.T) {
	auth.SetAWSCredentialsProvider(staticAWSProvider{})
	t.Cleanup(func() { auth.SetAWSCredentialsProvider(nil) })

	var authorization string
	target := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		authorization = r.Header.Get("Authorization")
		w.WriteHeader(http.StatusNoContent)
	}))
	defer target.Close()

	_, err := DoOperatorHTTPRequest(context.Background(), OperatorHTTPRequestParams{
		URL: target.URL, Method: http.MethodPost, Body: "payload", AllowPrivateNetwork: true,
		AwsService: "execute-api", AwsRegion: "us-east-1",
		Headers: map[string]string{"Authorization": "Bearer extension-value"},
	})
	if err != nil {
		t.Fatal(err)
	}
	if !strings.HasPrefix(authorization, "AWS4-HMAC-SHA256 ") {
		t.Fatalf("Authorization = %q", authorization)
	}
	if strings.Contains(authorization, "extension-value") {
		t.Fatalf("extension Authorization survived SigV4 signing: %q", authorization)
	}
}
