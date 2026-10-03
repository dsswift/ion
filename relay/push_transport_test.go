package main

import (
	"crypto/tls"
	"crypto/x509"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

// TestAPNsTransportSpeaksHTTP2 pins that a push sent on the production
// transport reaches the server over HTTP/2. APNs accepts nothing else, and a
// transport carrying its own TLS config only negotiates HTTP/2 when told to.
func TestAPNsTransportSpeaksHTTP2(t *testing.T) {
	var gotProtoMajor int
	srv := httptest.NewUnstartedServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotProtoMajor = r.ProtoMajor
		w.WriteHeader(http.StatusOK)
	}))
	srv.EnableHTTP2 = true
	srv.StartTLS()
	t.Cleanup(srv.Close)

	roots := x509.NewCertPool()
	roots.AddCert(srv.Certificate())
	transport := newAPNsTransport()
	transport.TLSClientConfig = &tls.Config{RootCAs: roots, MinVersion: tls.VersionTLS12}
	t.Cleanup(transport.CloseIdleConnections)

	p := newTestPusher(t, srv.URL, 8)
	p.client = &http.Client{Transport: transport, Timeout: 10 * time.Second}

	req := pushRequest{deviceToken: "tok", title: "t", body: "b", kind: "k", resourceId: "r"}
	if err := p.sendAsync(req); err != nil {
		t.Fatalf("push over the APNs transport failed: %v", err)
	}
	if gotProtoMajor != 2 {
		t.Fatalf("APNs request used HTTP/%d, want HTTP/2", gotProtoMajor)
	}
}
