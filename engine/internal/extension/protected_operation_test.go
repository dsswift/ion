package extension

// protected_operation_test.go — behavior pins for DoProtectedOperation.
//
// The secret used throughout contains characters that URL encoding rewrites,
// so every leak check covers the raw form and both URL-encoded forms.

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"

	"github.com/dsswift/ion/engine/internal/auth"
	"github.com/dsswift/ion/engine/internal/types"
	"github.com/dsswift/ion/engine/internal/utils"
)

const testProtectedSecret = "sk live/secret+value=42"

// secretForms is every encoding of the test secret a leak could take.
func secretForms() []string {
	return []string{testProtectedSecret, url.QueryEscape(testProtectedSecret), url.PathEscape(testProtectedSecret)}
}

func assertNoSecret(t *testing.T, surface, s string) {
	t.Helper()
	for _, form := range secretForms() {
		if strings.Contains(s, form) {
			t.Fatalf("%s leaked the secret (%q): %s", surface, form, s)
		}
	}
}

// useProtectedOperations declares ops and a secret source holding secrets
// keyed by "<subject>|<secretSource>|<secretRef>".
func useProtectedOperations(t *testing.T, ops map[string]types.ProtectedOperationConfig, secrets map[string]string) {
	t.Helper()
	prevOps, prevSecret := protectedOperationsSource, protectedSecretSource
	protectedOperationsSource = func() map[string]types.ProtectedOperationConfig { return ops }
	protectedSecretSource = func(subject string, ref types.SecretReference) (string, error) {
		if v, ok := secrets[subject+"|"+ref.SecretSource+"|"+ref.SecretRef]; ok {
			return v, nil
		}
		return "", fmt.Errorf("secret %q is not available: %w", ref.SecretRef, auth.ErrKeyNotFound)
	}
	t.Cleanup(func() { protectedOperationsSource, protectedSecretSource = prevOps, prevSecret })
}

// captureEngineLog points the engine logger at a fresh directory at debug
// level and returns a reader for everything written there.
func captureEngineLog(t *testing.T) func() string {
	t.Helper()
	dir := t.TempDir()
	utils.SetLevel(utils.LevelDebug)
	utils.ConfigureLogging(&types.LoggingConfig{LogDir: dir, OutputMode: "file"})
	t.Cleanup(func() {
		restore := filepath.Join(os.TempDir(), "ion-extension-test-logs")
		if err := os.MkdirAll(restore, 0o700); err != nil {
			t.Logf("restore log dir: %v", err)
		}
		utils.ConfigureLogging(&types.LoggingConfig{LogDir: restore, OutputMode: "file"})
		utils.SetLevel(utils.LevelInfo)
	})
	return func() string {
		var all strings.Builder
		entries, err := os.ReadDir(dir)
		if err != nil {
			t.Fatalf("read log dir: %v", err)
		}
		for _, e := range entries {
			data, err := os.ReadFile(filepath.Join(dir, e.Name()))
			if err != nil {
				t.Fatalf("read log: %v", err)
			}
			all.Write(data)
		}
		return all.String()
	}
}

// echoServer reflects everything it received, including the secret, in both
// its body and a response header.
func echoServer(t *testing.T, hits *atomic.Int32) *httptest.Server {
	t.Helper()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hits.Add(1)
		body, _ := io.ReadAll(r.Body) //nolint:errcheck // test echo
		w.Header().Set("X-Echo-Key", r.Header.Get("X-Api-Key"))
		w.Header().Set("Content-Type", "application/json")
		out, _ := json.Marshal(map[string]any{ //nolint:errcheck // test echo
			"method": r.Method, "key": r.Header.Get("X-Api-Key"), "query": r.URL.RawQuery, "path": r.URL.EscapedPath(),
			"contentType": r.Header.Get("Content-Type"), "fixed": r.Header.Get("X-Fixed"), "body": string(body),
		})
		w.WriteHeader(http.StatusAccepted)
		_, _ = w.Write(out) //nolint:errcheck // test echo
	}))
	t.Cleanup(srv.Close)
	return srv
}

func headerOp(target string) types.ProtectedOperationConfig {
	return types.ProtectedOperationConfig{
		Method: "POST", URL: target, SecretReference: types.SecretReference{SecretRef: "metrics-api-key"},
		InjectAs:            types.ProtectedOperationInjection{Header: "X-Api-Key"},
		BodySchema:          map[string]any{"type": "object", "required": []any{"value"}, "properties": map[string]any{"value": map[string]any{"type": "number"}}},
		Headers:             map[string]string{"X-Fixed": "declared"},
		AllowPrivateNetwork: true,
	}
}

func TestProtectedOperation_InjectsHeaderAndStripsReflection(t *testing.T) {
	readLog := captureEngineLog(t)
	var hits atomic.Int32
	srv := echoServer(t, &hits)
	useProtectedOperations(t, map[string]types.ProtectedOperationConfig{"publish-metric": headerOp(srv.URL + "/v1/metrics")},
		map[string]string{"||metrics-api-key": testProtectedSecret})

	res, err := DoProtectedOperation(context.Background(), ProtectedOperationParams{Name: "publish-metric", Payload: json.RawMessage(`{"value":42}`)})
	if err != nil {
		t.Fatalf("DoProtectedOperation: %v", err)
	}
	if res.Status != http.StatusAccepted || hits.Load() != 1 {
		t.Fatalf("status %d hits %d", res.Status, hits.Load())
	}
	var echoed map[string]string
	if err := json.Unmarshal([]byte(res.Body), &echoed); err != nil {
		t.Fatalf("decode echo: %v", err)
	}
	// The destination saw the secret; the extension sees only the redaction.
	if echoed["key"] != protectedOperationRedaction || res.Headers["X-Echo-Key"] != protectedOperationRedaction {
		t.Fatalf("injected header not delivered or not stripped: body key %q header %q", echoed["key"], res.Headers["X-Echo-Key"])
	}
	if echoed["method"] != "POST" || echoed["body"] != `{"value":42}` || echoed["contentType"] != "application/json" || echoed["fixed"] != "declared" {
		t.Fatalf("request shape not taken from the declaration: %+v", echoed)
	}
	data, err := json.Marshal(res)
	if err != nil {
		t.Fatalf("marshal result: %v", err)
	}
	assertNoSecret(t, "result", string(data))
	assertNoSecret(t, "engine log", readLog())
}

func TestProtectedOperation_InjectsQueryWithPrefix(t *testing.T) {
	var hits atomic.Int32
	srv := echoServer(t, &hits)
	op := headerOp(srv.URL + "/v1/metrics?region=us")
	op.InjectAs = types.ProtectedOperationInjection{Query: "key", Prefix: "Token "}
	useProtectedOperations(t, map[string]types.ProtectedOperationConfig{"publish-metric": op},
		map[string]string{"||metrics-api-key": testProtectedSecret})

	res, err := DoProtectedOperation(context.Background(), ProtectedOperationParams{Name: "publish-metric", Payload: json.RawMessage(`{"value":1}`)})
	if err != nil {
		t.Fatalf("DoProtectedOperation: %v", err)
	}
	var echoed map[string]string
	if err := json.Unmarshal([]byte(res.Body), &echoed); err != nil {
		t.Fatalf("decode echo: %v", err)
	}
	if !strings.Contains(echoed["query"], "region=us") || !strings.Contains(echoed["query"], "key=Token+"+protectedOperationRedaction) {
		t.Fatalf("query injection not delivered or not stripped: %q", echoed["query"])
	}
	assertNoSecret(t, "result body", res.Body)
}

func TestProtectedOperation_SchemaRejectionNeverDispatches(t *testing.T) {
	var hits atomic.Int32
	srv := echoServer(t, &hits)
	useProtectedOperations(t, map[string]types.ProtectedOperationConfig{"publish-metric": headerOp(srv.URL)},
		map[string]string{"||metrics-api-key": testProtectedSecret})

	for _, payload := range []string{`{"value":"not a number"}`, `{}`, `[1,2]`, ``, `not json`} {
		_, err := DoProtectedOperation(context.Background(), ProtectedOperationParams{Name: "publish-metric", Payload: json.RawMessage(payload)})
		if err == nil || !strings.Contains(err.Error(), "payload rejected") {
			t.Fatalf("payload %q: want payload rejection, got %v", payload, err)
		}
	}
	if hits.Load() != 0 {
		t.Fatalf("rejected payloads reached the destination %d times", hits.Load())
	}
}

func TestProtectedOperation_UnknownNameAndAbsentConfig(t *testing.T) {
	var hits atomic.Int32
	srv := echoServer(t, &hits)
	useProtectedOperations(t, map[string]types.ProtectedOperationConfig{"publish-metric": headerOp(srv.URL)},
		map[string]string{"||metrics-api-key": testProtectedSecret})
	if _, err := DoProtectedOperation(context.Background(), ProtectedOperationParams{Name: "other", Payload: json.RawMessage(`{"value":1}`)}); err == nil || !strings.Contains(err.Error(), `unknown protected operation "other"`) {
		t.Fatalf("unknown name: got %v", err)
	}

	useProtectedOperations(t, nil, nil)
	if _, err := DoProtectedOperation(context.Background(), ProtectedOperationParams{Name: "publish-metric"}); !errors.Is(err, ErrProtectedOperationsUnavailable) {
		t.Fatalf("absent config: got %v", err)
	}
	if hits.Load() != 0 {
		t.Fatalf("refused calls reached the destination %d times", hits.Load())
	}
}

func TestProtectedOperation_SecretComesFromActingPrincipalPartition(t *testing.T) {
	var hits atomic.Int32
	srv := echoServer(t, &hits)
	useProtectedOperations(t, map[string]types.ProtectedOperationConfig{"publish-metric": headerOp(srv.URL)},
		map[string]string{"||metrics-api-key": "shared-secret-value"})

	ctx := auth.WithSubject(context.Background(), "user-a")
	_, err := DoProtectedOperation(ctx, ProtectedOperationParams{Name: "publish-metric", Payload: json.RawMessage(`{"value":1}`)})
	if err == nil || !strings.Contains(err.Error(), `secret "metrics-api-key" is not available`) {
		t.Fatalf("attributed caller must not read the shared partition: got %v", err)
	}
	if hits.Load() != 0 {
		t.Fatal("a call with no secret reached the destination")
	}
}

func TestProtectedOperation_DoesNotFollowRedirects(t *testing.T) {
	var elsewhere atomic.Int32
	other := echoServer(t, &elsewhere)
	redirector := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, other.URL, http.StatusTemporaryRedirect)
	}))
	t.Cleanup(redirector.Close)
	useProtectedOperations(t, map[string]types.ProtectedOperationConfig{"publish-metric": headerOp(redirector.URL)},
		map[string]string{"||metrics-api-key": testProtectedSecret})

	res, err := DoProtectedOperation(context.Background(), ProtectedOperationParams{Name: "publish-metric", Payload: json.RawMessage(`{"value":1}`)})
	if err != nil {
		t.Fatalf("DoProtectedOperation: %v", err)
	}
	if res.Status != http.StatusTemporaryRedirect || elsewhere.Load() != 0 {
		t.Fatalf("redirect followed: status %d, redirect target hits %d", res.Status, elsewhere.Load())
	}
}

func TestProtectedOperation_TransportErrorIsRedacted(t *testing.T) {
	readLog := captureEngineLog(t)
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("listen: %v", err)
	}
	closedURL := "http://" + listener.Addr().String() + "/v1"
	if err := listener.Close(); err != nil {
		t.Fatalf("close listener: %v", err)
	}
	op := headerOp(closedURL)
	op.InjectAs = types.ProtectedOperationInjection{Query: "key"}
	useProtectedOperations(t, map[string]types.ProtectedOperationConfig{"publish-metric": op},
		map[string]string{"||metrics-api-key": testProtectedSecret})

	_, err = DoProtectedOperation(context.Background(), ProtectedOperationParams{Name: "publish-metric", Payload: json.RawMessage(`{"value":1}`)})
	if err == nil || !strings.Contains(err.Error(), "request failed") {
		t.Fatalf("want transport failure, got %v", err)
	}
	assertNoSecret(t, "error", err.Error())
	assertNoSecret(t, "engine log", readLog())
}

func TestProtectedOperation_RejectsInvalidDeclarations(t *testing.T) {
	base := headerOp("https://example.invalid/v1")
	cases := map[string]func(*types.ProtectedOperationConfig){
		"missing schema":        func(op *types.ProtectedOperationConfig) { op.BodySchema = nil },
		"both slots":            func(op *types.ProtectedOperationConfig) { op.InjectAs.Query = "key" },
		"no slot":               func(op *types.ProtectedOperationConfig) { op.InjectAs.Header = "" },
		"missing secret ref":    func(op *types.ProtectedOperationConfig) { op.SecretRef = "" },
		"unknown secret source": func(op *types.ProtectedOperationConfig) { op.SecretSource = "vault" },
		"non-http scheme":       func(op *types.ProtectedOperationConfig) { op.URL = "file:///etc/passwd" },
		"private without optin": func(op *types.ProtectedOperationConfig) {
			op.URL = "http://127.0.0.1/v1"
			op.AllowPrivateNetwork = false
		},
		"param in host":  func(op *types.ProtectedOperationConfig) { op.URL = "https://{tenant}.example.com/v1" },
		"param in query": func(op *types.ProtectedOperationConfig) { op.URL = "https://example.invalid/v1?to={dest}" },
	}
	for name, mutate := range cases {
		op := base
		mutate(&op)
		useProtectedOperations(t, map[string]types.ProtectedOperationConfig{"op": op}, map[string]string{"||metrics-api-key": testProtectedSecret})
		if _, err := DoProtectedOperation(context.Background(), ProtectedOperationParams{Name: "op", Payload: json.RawMessage(`{"value":1}`)}); err == nil || !strings.Contains(err.Error(), "misconfigured") {
			t.Fatalf("%s: want misconfiguration error, got %v", name, err)
		}
	}
}

func TestProtectedOperation_ReadsTheDeclaredSecretSource(t *testing.T) {
	var hits atomic.Int32
	srv := echoServer(t, &hits)
	op := headerOp(srv.URL)
	op.SecretReference = types.SecretReference{SecretRef: "gatewayKey", SecretSource: types.SecretSourceApplicationConfig}
	useProtectedOperations(t, map[string]types.ProtectedOperationConfig{"gateway": op}, map[string]string{
		"||gatewayKey": "credential-store-value", "|applicationConfig|gatewayKey": testProtectedSecret,
	})

	res, err := DoProtectedOperation(context.Background(), ProtectedOperationParams{Name: "gateway", Payload: json.RawMessage(`{"value":1}`)})
	if err != nil {
		t.Fatalf("DoProtectedOperation: %v", err)
	}
	// Only the application-config value is redacted, so seeing the
	// redaction proves that value, not the credential-store one, was sent.
	if res.Headers["X-Echo-Key"] != protectedOperationRedaction {
		t.Fatalf("declared source not used: %q", res.Headers["X-Echo-Key"])
	}
}

func pathOp(target string) types.ProtectedOperationConfig {
	op := headerOp(target)
	op.Method = "GET"
	op.BodySchema = map[string]any{"type": "object", "required": []any{"id"}}
	return op
}

func TestProtectedOperation_FillsPathTemplate(t *testing.T) {
	var hits atomic.Int32
	srv := echoServer(t, &hits)
	useProtectedOperations(t, map[string]types.ProtectedOperationConfig{"get-item": pathOp(srv.URL + "/v1/items/{id}/v{version}")},
		map[string]string{"||metrics-api-key": testProtectedSecret})

	res, err := DoProtectedOperation(context.Background(), ProtectedOperationParams{Name: "get-item", Payload: json.RawMessage(`{"id":"a/b c","version":7}`)})
	if err != nil {
		t.Fatalf("DoProtectedOperation: %v", err)
	}
	var echoed map[string]string
	if err := json.Unmarshal([]byte(res.Body), &echoed); err != nil {
		t.Fatalf("decode echo: %v", err)
	}
	// A slash in a value stays inside its segment, and GET carries no body.
	if echoed["path"] != "/v1/items/a%2Fb%20c/v7" || echoed["method"] != "GET" || echoed["body"] != "" {
		t.Fatalf("template not filled safely: %+v", echoed)
	}
}

func TestProtectedOperation_RejectsBadPathValuesBeforeDispatch(t *testing.T) {
	var hits atomic.Int32
	srv := echoServer(t, &hits)
	useProtectedOperations(t, map[string]types.ProtectedOperationConfig{"get-item": pathOp(srv.URL + "/v1/items/{id}")},
		map[string]string{"||metrics-api-key": testProtectedSecret})

	for _, payload := range []string{`{"id":".."}`, `{"id":"."}`, `{"id":""}`, `{"id":true}`, `{"id":{"x":1}}`, `{"other":1,"id":null}`} {
		_, err := DoProtectedOperation(context.Background(), ProtectedOperationParams{Name: "get-item", Payload: json.RawMessage(payload)})
		if err == nil || !strings.Contains(err.Error(), "payload rejected") {
			t.Fatalf("payload %s: want rejection, got %v", payload, err)
		}
	}
	if hits.Load() != 0 {
		t.Fatalf("rejected path values reached the destination %d times", hits.Load())
	}
}
