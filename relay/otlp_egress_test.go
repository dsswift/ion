package main

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

// otlpCollector is a fake OTLP/HTTP endpoint that records every request.
type otlpCollector struct {
	mu     sync.Mutex
	reqs   []otlpCapturedReq
	status func(r *http.Request) int // nil = 200
	srv    *httptest.Server
}

type otlpCapturedReq struct {
	Path string
	Auth string
	Body []byte
}

func newOTLPCollector(t *testing.T) *otlpCollector {
	t.Helper()
	c := &otlpCollector{}
	c.srv = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		c.mu.Lock()
		c.reqs = append(c.reqs, otlpCapturedReq{Path: r.URL.Path, Auth: r.Header.Get("Authorization"), Body: body})
		status := c.status
		c.mu.Unlock()
		code := http.StatusOK
		if status != nil {
			code = status(r)
		}
		w.WriteHeader(code)
	}))
	t.Cleanup(c.srv.Close)
	return c
}

func (c *otlpCollector) requests() []otlpCapturedReq {
	c.mu.Lock()
	defer c.mu.Unlock()
	return append([]otlpCapturedReq(nil), c.reqs...)
}

func (c *otlpCollector) setStatus(f func(r *http.Request) int) {
	c.mu.Lock()
	c.status = f
	c.mu.Unlock()
}

// otlpTestOpts are the production handler options.
var otlpTestOpts = &slog.HandlerOptions{Level: slogLevelTrace, ReplaceAttr: relayReplaceAttr}

func newTestShipper(t *testing.T, cfg otlpConfig) (*otlpShipper, *syncBuffer) {
	t.Helper()
	var local syncBuffer
	s := newOTLPShipper(cfg, newRelayLogger(&local, otlpTestOpts, slogLevelTrace))
	return s, &local
}

func attrMap(attrs []otlpAttr) map[string]string {
	m := make(map[string]string, len(attrs))
	for _, a := range attrs {
		switch {
		case a.Value.StringValue != nil:
			m[a.Key] = *a.Value.StringValue
		case a.Value.IntValue != nil:
			m[a.Key] = *a.Value.IntValue
		case a.Value.BoolValue != nil:
			m[a.Key] = fmt.Sprint(*a.Value.BoolValue)
		case a.Value.DoubleValue != nil:
			m[a.Key] = fmt.Sprint(*a.Value.DoubleValue)
		}
	}
	return m
}

func decodeLogs(t *testing.T, body []byte) otlpLogsRequest {
	t.Helper()
	var req otlpLogsRequest
	if err := json.Unmarshal(body, &req); err != nil {
		t.Fatalf("decode logs body: %v\n%s", err, body)
	}
	return req
}

func TestOTLPLogsBatchingAndBodyShape(t *testing.T) {
	col := newOTLPCollector(t)
	s, _ := newTestShipper(t, otlpConfig{Endpoint: col.srv.URL})
	s.batchSize = 2

	var local syncBuffer
	log := newRelayLogger(io.MultiWriter(s, &local), otlpTestOpts, slogLevelTrace)
	log.Info("client connected", "tag", "relay.connect", "channel_id", "chan-1", "role", "mobile", "count", 3)
	log.Warn("second", "tag", "relay.test")
	log.Error("third", "tag", "relay.test", "err", "boom")

	s.Flush(context.Background())

	reqs := col.requests()
	if len(reqs) != 2 {
		t.Fatalf("want 2 batches (batch size 2, 3 lines), got %d", len(reqs))
	}
	localLines := strings.Split(strings.TrimRight(string(local.Bytes()), "\n"), "\n")
	var records []otlpLogRecord
	for _, r := range reqs {
		if r.Path != "/v1/logs" {
			t.Fatalf("path = %q, want /v1/logs", r.Path)
		}
		if r.Auth != "" {
			t.Fatalf("no token URL configured, but Authorization = %q", r.Auth)
		}
		req := decodeLogs(t, r.Body)
		res := attrMap(req.ResourceLogs[0].Resource.Attributes)
		if res["service.name"] != "ion-relay" {
			t.Fatalf("service.name = %q", res["service.name"])
		}
		if res["host.name"] != s.host {
			t.Fatalf("host.name = %q, want %q", res["host.name"], s.host)
		}
		records = append(records, req.ResourceLogs[0].ScopeLogs[0].LogRecords...)
	}
	if len(records) != 3 {
		t.Fatalf("want 3 records, got %d", len(records))
	}
	for i, rec := range records {
		if got := *rec.Body.StringValue; got != localLines[i] {
			t.Fatalf("record %d body is not the canonical line:\n got %s\nwant %s", i, got, localLines[i])
		}
	}

	first := records[0]
	if first.SeverityText != "INFO" || first.SeverityNumber != 9 {
		t.Fatalf("severity = %s/%d", first.SeverityText, first.SeverityNumber)
	}
	if first.TimeUnixNano == "" {
		t.Fatal("timeUnixNano empty")
	}
	a := attrMap(first.Attributes)
	want := map[string]string{
		"tag":        "relay.connect",
		"channel_id": "chan-1",
		"role":       "mobile",
		"count":      "3",
	}
	for k, v := range want {
		if a[k] != v {
			t.Fatalf("attr %s = %q, want %q (all: %v)", k, a[k], v, a)
		}
	}
	// The component and host are the resource's service.name and host.name.
	for _, k := range []string{"component", "host", "loki.attribute.labels"} {
		if _, ok := a[k]; ok {
			t.Fatalf("attr %s repeats the resource (all: %v)", k, a)
		}
	}
	for i := 1; i < len(first.Attributes); i++ {
		if first.Attributes[i-1].Key > first.Attributes[i].Key {
			t.Fatalf("attributes not sorted by key: %v", first.Attributes)
		}
	}
	if records[2].SeverityText != "ERROR" || records[2].SeverityNumber != 17 {
		t.Fatalf("third severity = %s/%d", records[2].SeverityText, records[2].SeverityNumber)
	}
	if attrMap(records[2].Attributes)["error"] != "boom" {
		t.Fatalf("err not normalized to error attribute: %v", attrMap(records[2].Attributes))
	}
	if s.logs.len() != 0 {
		t.Fatalf("queue not drained: %d left", s.logs.len())
	}
}

// fakeTokenServer is a client_credentials endpoint issuing tok-1, tok-2, ...
type fakeTokenServer struct {
	fetches   atomic.Int32
	expiresIn int
	srv       *httptest.Server
}

func newFakeTokenServer(t *testing.T, expiresIn int) *fakeTokenServer {
	t.Helper()
	ts := &fakeTokenServer{expiresIn: expiresIn}
	ts.srv = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if err := r.ParseForm(); err != nil {
			t.Errorf("parse token form: %v", err)
		}
		if r.Form.Get("grant_type") != "client_credentials" || r.Form.Get("client_id") != "cid" ||
			r.Form.Get("client_secret") != "secret" || r.Form.Get("scope") != "api://aud/.default" {
			t.Errorf("unexpected token form: %v", r.Form)
		}
		n := ts.fetches.Add(1)
		w.Header().Set("Content-Type", "application/json")
		fmt.Fprintf(w, `{"access_token":"tok-%d","token_type":"Bearer","expires_in":%d}`, n, ts.expiresIn)
	}))
	t.Cleanup(ts.srv.Close)
	return ts
}

func TestOTLPTokenFetchCacheAndRefreshOn401(t *testing.T) {
	col := newOTLPCollector(t)
	tok := newFakeTokenServer(t, 3600)
	s, _ := newTestShipper(t, otlpConfig{
		Endpoint: col.srv.URL, AuthMode: otlpAuthSecret, TokenURL: tok.srv.URL,
		ClientID: "cid", ClientSecret: "secret", Scope: "api://aud/.default",
	})
	now := time.Now()
	s.tokens.now = func() time.Time { return now }

	// Two flushes share one cached token.
	s.Write([]byte(`{"level":"INFO","msg":"a","component":"relay","tag":"t","fields":{}}` + "\n"))
	s.Flush(context.Background())
	s.Write([]byte(`{"level":"INFO","msg":"b","component":"relay","tag":"t","fields":{}}` + "\n"))
	s.Flush(context.Background())
	if got := tok.fetches.Load(); got != 1 {
		t.Fatalf("token fetches = %d, want 1 (cached)", got)
	}
	for _, r := range col.requests() {
		if r.Auth != "Bearer tok-1" {
			t.Fatalf("Authorization = %q, want Bearer tok-1", r.Auth)
		}
	}

	// The collector now rejects tok-1: one refresh, one retry, batch delivered.
	col.setStatus(func(r *http.Request) int {
		if r.Header.Get("Authorization") == "Bearer tok-1" {
			return http.StatusUnauthorized
		}
		return http.StatusOK
	})
	s.Write([]byte(`{"level":"INFO","msg":"c","component":"relay","tag":"t","fields":{}}` + "\n"))
	s.Flush(context.Background())
	if got := tok.fetches.Load(); got != 2 {
		t.Fatalf("token fetches after 401 = %d, want 2", got)
	}
	reqs := col.requests()
	if len(reqs) != 4 {
		t.Fatalf("requests = %d, want 4 (2 ok, 401, retry)", len(reqs))
	}
	if reqs[2].Auth != "Bearer tok-1" || reqs[3].Auth != "Bearer tok-2" {
		t.Fatalf("401 retry auth = %q then %q", reqs[2].Auth, reqs[3].Auth)
	}
	if s.logs.len() != 0 {
		t.Fatalf("retried batch should be delivered, %d left", s.logs.len())
	}

	// Inside the refresh skew the cache fetches a fresh token.
	now = now.Add(3600*time.Second - otlpTokenRefreshSkew + time.Second)
	s.Write([]byte(`{"level":"INFO","msg":"d","component":"relay","tag":"t","fields":{}}` + "\n"))
	s.Flush(context.Background())
	if got := tok.fetches.Load(); got != 3 {
		t.Fatalf("token fetches near expiry = %d, want 3", got)
	}
}

func TestOTLPRetryableFailureRequeues(t *testing.T) {
	col := newOTLPCollector(t)
	col.setStatus(func(*http.Request) int { return http.StatusServiceUnavailable })
	s, local := newTestShipper(t, otlpConfig{Endpoint: col.srv.URL})
	s.Write([]byte(`{"level":"INFO","msg":"a","component":"relay","tag":"t","fields":{}}`))
	s.Flush(context.Background())
	if s.logs.len() != 1 {
		t.Fatalf("503 should requeue the batch, queue len %d", s.logs.len())
	}
	if !strings.Contains(string(local.Bytes()), `"msg":"otlp: export failed"`) {
		t.Fatalf("export failure not logged locally:\n%s", local.Bytes())
	}
	col.setStatus(nil)
	s.Flush(context.Background())
	if s.logs.len() != 0 || len(col.requests()) != 2 {
		t.Fatalf("recovered flush: queue %d, requests %d", s.logs.len(), len(col.requests()))
	}
}

func TestOTLPOverflowDropsOldestAndReportsCount(t *testing.T) {
	col := newOTLPCollector(t)
	s, local := newTestShipper(t, otlpConfig{Endpoint: col.srv.URL})
	s.logs = newOTLPQueue[[]byte](3)
	for i := 1; i <= 5; i++ {
		fmt.Fprintf(s, `{"level":"INFO","msg":"m%d","component":"relay","tag":"t","fields":{}}`, i)
	}
	s.Flush(context.Background())

	reqs := col.requests()
	if len(reqs) != 1 {
		t.Fatalf("requests = %d, want 1", len(reqs))
	}
	recs := decodeLogs(t, reqs[0].Body).ResourceLogs[0].ScopeLogs[0].LogRecords
	var msgs []string
	for _, r := range recs {
		var l map[string]any
		if err := json.Unmarshal([]byte(*r.Body.StringValue), &l); err != nil {
			t.Fatal(err)
		}
		msgs = append(msgs, l["msg"].(string))
	}
	if strings.Join(msgs, ",") != "m3,m4,m5" {
		t.Fatalf("kept %v, want the newest three", msgs)
	}
	out := string(local.Bytes())
	if !strings.Contains(out, `"msg":"otlp: log buffer overflow; dropped oldest lines"`) || !strings.Contains(out, `"dropped":2`) {
		t.Fatalf("drop count not reported locally:\n%s", out)
	}
	if strings.Contains(string(reqs[0].Body), "overflow") {
		t.Fatal("drop report must stay local, not ship")
	}
	// The count is reported once per window, then cleared.
	s.Flush(context.Background())
	if n := strings.Count(string(local.Bytes()), "buffer overflow"); n != 1 {
		t.Fatalf("overflow reported %d times, want 1", n)
	}
}

// resetRelayLogFile clears the package-level file target state initLogger sets.
func resetRelayLogFile() {
	logMu.Lock()
	if relayLogFile != nil {
		relayLogFile.Close() //nolint:errcheck // test teardown
		relayLogFile = nil
	}
	relayLogPath = ""
	relayBytesWritten = 0
	logMu.Unlock()
}

func setOTLPEnv(t *testing.T, endpoint, tokenURL string) {
	t.Helper()
	t.Setenv("RELAY_LOG_OUTPUT", "file")
	t.Setenv("RELAY_LOG_FILE", filepath.Join(t.TempDir(), "relay.jsonl"))
	t.Setenv("RELAY_LOG_LEVEL", "info")
	t.Setenv("RELAY_OTLP_ENDPOINT", endpoint)
	t.Setenv("RELAY_OTLP_TOKEN_URL", tokenURL)
	t.Setenv("RELAY_OTLP_CLIENT_ID", "cid")
	t.Setenv("RELAY_OTLP_CLIENT_SECRET", "secret")
	t.Setenv("RELAY_OTLP_SCOPE", "api://aud/.default")
	clearWorkloadIdentityEnv(t)
	resetRelayLogFile()
	t.Cleanup(func() {
		relayOTLP.Shutdown(context.Background())
		relayOTLP = nil
		resetRelayLogFile()
	})
}

func TestOTLPDisabledWhenEndpointUnsetMakesNoCalls(t *testing.T) {
	var hits atomic.Int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hits.Add(1)
	}))
	defer srv.Close()
	setOTLPEnv(t, "", srv.URL)

	log := initLogger()
	log.Info("hello", "tag", "relay.test")
	if relayOTLP != nil {
		t.Fatal("shipper started with RELAY_OTLP_ENDPOINT unset")
	}
	if _, ok := os.LookupEnv("RELAY_OTLP_CLIENT_SECRET"); ok {
		t.Fatal("client secret left in the environment")
	}
	relayOTLP.Flush(context.Background()) // nil-safe
	relayOTLP.Shutdown(context.Background())
	if hits.Load() != 0 {
		t.Fatalf("disabled path made %d HTTP calls", hits.Load())
	}
}

func TestOTLPEnabledFromEnvShipsOnShutdown(t *testing.T) {
	col := newOTLPCollector(t)
	tok := newFakeTokenServer(t, 3600)
	setOTLPEnv(t, col.srv.URL+"/", tok.srv.URL)

	log := initLogger()
	if relayOTLP == nil {
		t.Fatal("shipper not started with RELAY_OTLP_ENDPOINT set")
	}
	if _, ok := os.LookupEnv("RELAY_OTLP_CLIENT_SECRET"); ok {
		t.Fatal("client secret left in the environment")
	}
	log.Info("shipped at shutdown", "tag", "relay.test")

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	relayOTLP.Shutdown(ctx)

	var bodies strings.Builder
	for _, r := range col.requests() {
		if r.Path != "/v1/logs" || r.Auth != "Bearer tok-1" {
			t.Fatalf("request %s auth %q", r.Path, r.Auth)
		}
		bodies.Write(r.Body)
	}
	if !strings.Contains(bodies.String(), "shipped at shutdown") {
		t.Fatalf("shutdown flush did not ship the line:\n%s", bodies.String())
	}
}

func TestOTLPConfigTokenURLWithoutCredentialsIsRejected(t *testing.T) {
	t.Setenv("RELAY_OTLP_ENDPOINT", "https://collector.example.org")
	t.Setenv("RELAY_OTLP_TOKEN_URL", "https://login.example.org/token")
	t.Setenv("RELAY_OTLP_CLIENT_ID", "")
	t.Setenv("RELAY_OTLP_CLIENT_SECRET", "")
	clearWorkloadIdentityEnv(t)
	if _, ok, err := otlpConfigFromEnv(); ok || err == nil {
		t.Fatalf("want config error, got ok=%v err=%v", ok, err)
	}
}
