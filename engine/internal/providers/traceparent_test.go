package providers

import (
	"context"
	"net/http"
	"testing"

	"github.com/dsswift/ion/engine/internal/utils"
)

func TestApplyTraceparentHeader(t *testing.T) {
	const trace = "4bf92f3577b34da6a3ce929d0e0e4736"
	const span = "00f067aa0ba902b7"
	req, err := http.NewRequest(http.MethodPost, "https://api.example.test/v1", nil)
	if err != nil {
		t.Fatal(err)
	}
	applyTraceparent(utils.WithSpanID(utils.WithTraceID(context.Background(), trace), span), req, "test")
	if got := req.Header.Get("traceparent"); got != "00-"+trace+"-"+span+"-01" {
		t.Errorf("traceparent = %q", got)
	}
	bare, err := http.NewRequest(http.MethodPost, "https://api.example.test/v1", nil)
	if err != nil {
		t.Fatal(err)
	}
	applyTraceparent(context.Background(), bare, "test")
	if got := bare.Header.Get("traceparent"); got != "" {
		t.Errorf("request outside a trace must send no traceparent, got %q", got)
	}
}
