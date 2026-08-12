package providers

import (
	"context"
	"net/http"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/dsswift/ion/engine/internal/auth"
)

type rotatingBedrockCredentials struct{ calls atomic.Int32 }

func (p *rotatingBedrockCredentials) Kind() string { return "test" }
func (p *rotatingBedrockCredentials) Retrieve(context.Context) (*auth.AWSCredentials, error) {
	call := p.calls.Add(1)
	return &auth.AWSCredentials{
		AccessKeyID: "AKID" + string(rune('0'+call)), SecretAccessKey: "secret",
		SessionToken: "session", ExpiresAt: time.Now().Add(time.Hour),
	}, nil
}

func TestBedrockUsesLiveMachineCredentialsPerRequest(t *testing.T) {
	t.Setenv("AWS_ACCESS_KEY_ID", "")
	t.Setenv("AWS_SECRET_ACCESS_KEY", "")
	credentials := &rotatingBedrockCredentials{}
	auth.SetAWSCredentialsProvider(credentials)
	t.Cleanup(func() { auth.SetAWSCredentialsProvider(nil) })

	provider := NewBedrockProvider(nil).(*bedrockProvider)
	for _, expected := range []string{"AKID1", "AKID2"} {
		request, _ := http.NewRequest(http.MethodPost, "https://bedrock.us-east-1.amazonaws.com/model/x", nil)
		if err := provider.signRequest(context.Background(), request, []byte("{}")); err != nil {
			t.Fatal(err)
		}
		if !strings.Contains(request.Header.Get("Authorization"), expected) {
			t.Fatalf("Authorization missing rotating key %q: %s", expected, request.Header.Get("Authorization"))
		}
	}
	if credentials.calls.Load() != 2 {
		t.Fatalf("credential retrieval calls = %d", credentials.calls.Load())
	}
}
