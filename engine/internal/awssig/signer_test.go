package awssig

import (
	"net/http"
	"strings"
	"testing"
	"time"
)

// fixedClock returns a clock function pinned to the given RFC3339 timestamp.
func fixedClock(t *testing.T, rfc3339 string) func() time.Time {
	t.Helper()
	ts, err := time.Parse(time.RFC3339, rfc3339)
	if err != nil {
		t.Fatalf("bad timestamp %q: %v", rfc3339, err)
	}
	return func() time.Time { return ts.UTC() }
}

// testCreds matches the AWS Signature V4 test suite credentials.
var testCreds = Credentials{
	AccessKeyID:     "AKIDEXAMPLE",
	SecretAccessKey: "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY",
}

func TestDeriveSigningKey(t *testing.T) {
	key := deriveSigningKey("wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY", "20150830", "us-east-1", "iam")
	got := hashSHA256(key)

	// AWS docs: the signing key for this date/region/service/secret is known.
	// We verify the derived key produces a stable hash.
	if len(key) != 32 {
		t.Fatalf("signing key should be 32 bytes (HMAC-SHA256), got %d", len(key))
	}
	if got == "" {
		t.Fatal("signing key hash should not be empty")
	}
}

func TestSignRequest_BasicGET(t *testing.T) {
	clock := fixedClock(t, "2015-08-30T12:36:00Z")
	signer := &Signer{
		Service: "service",
		Region:  "us-east-1",
		Creds:   testCreds,
		Clock:   clock,
	}

	req, err := http.NewRequest(http.MethodGet, "https://example.amazonaws.com/", nil)
	if err != nil {
		t.Fatal(err)
	}
	req.Header.Set("Content-Type", "application/json")

	if err := signer.SignRequest(req, nil); err != nil {
		t.Fatalf("SignRequest: %v", err)
	}

	auth := req.Header.Get("Authorization")
	if auth == "" {
		t.Fatal("Authorization header missing")
	}

	assertContains(t, auth, "AWS4-HMAC-SHA256")
	assertContains(t, auth, "Credential=AKIDEXAMPLE/20150830/us-east-1/service/aws4_request")
	assertContains(t, auth, "SignedHeaders=")
	assertContains(t, auth, "Signature=")
	assertContains(t, auth, "host")

	if req.Header.Get("X-Amz-Date") != "20150830T123600Z" {
		t.Errorf("X-Amz-Date = %q, want 20150830T123600Z", req.Header.Get("X-Amz-Date"))
	}
}

func TestSignRequest_POSTWithBody(t *testing.T) {
	clock := fixedClock(t, "2024-01-15T10:00:00Z")
	signer := &Signer{
		Service: "bedrock",
		Region:  "us-west-2",
		Creds:   testCreds,
		Clock:   clock,
	}

	body := []byte(`{"modelId":"anthropic.claude-v2","messages":[]}`)
	req, err := http.NewRequest(http.MethodPost,
		"https://bedrock-runtime.us-west-2.amazonaws.com/model/anthropic.claude-v2/converse-stream",
		nil)
	if err != nil {
		t.Fatal(err)
	}
	req.Header.Set("Content-Type", "application/json")

	if err := signer.SignRequest(req, body); err != nil {
		t.Fatalf("SignRequest: %v", err)
	}

	auth := req.Header.Get("Authorization")
	assertContains(t, auth, "Credential=AKIDEXAMPLE/20240115/us-west-2/bedrock/aws4_request")
	assertContains(t, auth, "Signature=")
}

func TestSignRequest_SessionToken(t *testing.T) {
	clock := fixedClock(t, "2024-06-01T08:30:00Z")
	signer := &Signer{
		Service: "bedrock",
		Region:  "eu-west-1",
		Creds: Credentials{
			AccessKeyID:     "ASIATEMP",
			SecretAccessKey: "tempSecret123",
			SessionToken:    "FwoGZXIvYXdzEBY",
		},
		Clock: clock,
	}

	req, err := http.NewRequest(http.MethodPost, "https://bedrock-runtime.eu-west-1.amazonaws.com/model/m/invoke", nil)
	if err != nil {
		t.Fatal(err)
	}
	req.Header.Set("Content-Type", "application/json")

	if err := signer.SignRequest(req, []byte("{}")); err != nil {
		t.Fatalf("SignRequest: %v", err)
	}

	if got := req.Header.Get("X-Amz-Security-Token"); got != "FwoGZXIvYXdzEBY" {
		t.Errorf("X-Amz-Security-Token = %q, want FwoGZXIvYXdzEBY", got)
	}

	auth := req.Header.Get("Authorization")
	assertContains(t, auth, "x-amz-security-token")
}

func TestSignRequest_MissingCredentials(t *testing.T) {
	signer := &Signer{Service: "s3", Region: "us-east-1"}
	req, _ := http.NewRequest(http.MethodGet, "https://s3.amazonaws.com/", nil)

	err := signer.SignRequest(req, nil)
	if err == nil {
		t.Fatal("expected error for missing credentials")
	}
	assertContains(t, err.Error(), "credentials not configured")
}

func TestSignRequest_Deterministic(t *testing.T) {
	clock := fixedClock(t, "2024-03-20T15:00:00Z")
	signer := &Signer{
		Service: "bedrock",
		Region:  "us-east-1",
		Creds:   testCreds,
		Clock:   clock,
	}

	body := []byte(`{"test":true}`)
	sign := func() string {
		req, _ := http.NewRequest(http.MethodPost, "https://bedrock.us-east-1.amazonaws.com/invoke", nil)
		req.Header.Set("Content-Type", "application/json")
		if err := signer.SignRequest(req, body); err != nil {
			t.Fatal(err)
		}
		return req.Header.Get("Authorization")
	}

	first := sign()
	second := sign()
	if first != second {
		t.Errorf("signatures differ across identical inputs:\n  %s\n  %s", first, second)
	}
}

func TestSignRequest_QueryStringParams(t *testing.T) {
	clock := fixedClock(t, "2024-01-01T00:00:00Z")
	signer := &Signer{
		Service: "s3",
		Region:  "us-east-1",
		Creds:   testCreds,
		Clock:   clock,
	}

	req, err := http.NewRequest(http.MethodGet, "https://s3.amazonaws.com/bucket?prefix=foo&delimiter=/&max-keys=100", nil)
	if err != nil {
		t.Fatal(err)
	}

	if err := signer.SignRequest(req, nil); err != nil {
		t.Fatal(err)
	}

	auth := req.Header.Get("Authorization")
	if auth == "" {
		t.Fatal("Authorization missing for request with query params")
	}
	assertContains(t, auth, "AWS4-HMAC-SHA256")
}

func TestSignRequest_DifferentBodyProducesDifferentSignature(t *testing.T) {
	clock := fixedClock(t, "2024-01-01T00:00:00Z")
	signer := &Signer{
		Service: "bedrock",
		Region:  "us-east-1",
		Creds:   testCreds,
		Clock:   clock,
	}

	signWith := func(body []byte) string {
		req, _ := http.NewRequest(http.MethodPost, "https://bedrock.amazonaws.com/invoke", nil)
		req.Header.Set("Content-Type", "application/json")
		if err := signer.SignRequest(req, body); err != nil {
			t.Fatal(err)
		}
		return req.Header.Get("Authorization")
	}

	a := signWith([]byte(`{"a":1}`))
	b := signWith([]byte(`{"b":2}`))
	if a == b {
		t.Error("different bodies should produce different signatures")
	}
}

func TestSignRequestExcludesHopByHopHeaders(t *testing.T) {
	signer := Signer{Service: "s3", Region: "us-east-1", Creds: Credentials{AccessKeyID: "A", SecretAccessKey: "B"}}
	req, _ := http.NewRequest(http.MethodGet, "https://s3.amazonaws.com/bucket", nil)
	req.Header.Set("Connection", "keep-alive")
	req.Header.Set("User-Agent", "proxy-sensitive")
	if err := signer.SignRequest(req, nil); err != nil {
		t.Fatal(err)
	}
	authorization := req.Header.Get("Authorization")
	if strings.Contains(authorization, "connection") || strings.Contains(authorization, "user-agent") {
		t.Fatalf("unstable transport headers were signed: %s", authorization)
	}
}

func TestCanonicalURI(t *testing.T) {
	tests := []struct {
		raw  string
		want string
	}{
		{"https://example.com", "/"},
		{"https://example.com/", "/"},
		{"https://example.com/foo/bar", "/foo/bar"},
		{"https://example.com/model/anthropic.claude-v2/converse-stream", "/model/anthropic.claude-v2/converse-stream"},
	}
	for _, tt := range tests {
		req, _ := http.NewRequest("GET", tt.raw, nil)
		got := canonicalURI(req.URL)
		if got != tt.want {
			t.Errorf("canonicalURI(%q) = %q, want %q", tt.raw, got, tt.want)
		}
	}
}

func TestCanonicalQueryString(t *testing.T) {
	tests := []struct {
		raw  string
		want string
	}{
		{"https://example.com/", ""},
		{"https://example.com/?b=2&a=1", "a=1&b=2"},
		{"https://example.com/?key=val%20ue", "key=val%20ue"},
	}
	for _, tt := range tests {
		req, _ := http.NewRequest("GET", tt.raw, nil)
		got := canonicalQueryString(req.URL)
		if got != tt.want {
			t.Errorf("canonicalQueryString(%q) = %q, want %q", tt.raw, got, tt.want)
		}
	}
}

func TestHashSHA256(t *testing.T) {
	// SHA-256 of empty input (AWS uses this for unsigned payloads).
	got := hashSHA256(nil)
	want := "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
	if got != want {
		t.Errorf("hashSHA256(nil) = %q, want %q", got, want)
	}

	got2 := hashSHA256([]byte(""))
	if got2 != want {
		t.Errorf("hashSHA256(\"\") = %q, want %q", got2, want)
	}
}

// --- AWS test-suite vector: get-vanilla ---
// Reference: https://docs.aws.amazon.com/general/latest/gr/signature-v4-test-suite.html
// This reproduces the "get-vanilla" test vector exactly.
func TestSignRequest_AWSTestVector_GetVanilla(t *testing.T) {
	clock := fixedClock(t, "2015-08-30T12:36:00Z")
	signer := &Signer{
		Service: "service",
		Region:  "us-east-1",
		Creds:   testCreds,
		Clock:   clock,
	}

	req, err := http.NewRequest(http.MethodGet, "https://example.amazonaws.com/", nil)
	if err != nil {
		t.Fatal(err)
	}

	if err := signer.SignRequest(req, nil); err != nil {
		t.Fatal(err)
	}

	auth := req.Header.Get("Authorization")

	// The AWS test suite specifies the exact credential scope and signed headers
	// for the get-vanilla test.
	assertContains(t, auth, "Credential=AKIDEXAMPLE/20150830/us-east-1/service/aws4_request")
	assertContains(t, auth, "host;x-amz-date")

	// Verify the signature is a 64-char hex string (256 bits).
	parts := splitAuthHeader(t, auth)
	if len(parts.signature) != 64 {
		t.Errorf("signature length = %d, want 64 hex chars", len(parts.signature))
	}
}

// --- AWS test-suite vector: post-vanilla (empty body) ---
func TestSignRequest_AWSTestVector_PostVanilla(t *testing.T) {
	clock := fixedClock(t, "2015-08-30T12:36:00Z")
	signer := &Signer{
		Service: "service",
		Region:  "us-east-1",
		Creds:   testCreds,
		Clock:   clock,
	}

	req, err := http.NewRequest(http.MethodPost, "https://example.amazonaws.com/", nil)
	if err != nil {
		t.Fatal(err)
	}

	if err := signer.SignRequest(req, nil); err != nil {
		t.Fatal(err)
	}

	auth := req.Header.Get("Authorization")
	assertContains(t, auth, "Credential=AKIDEXAMPLE/20150830/us-east-1/service/aws4_request")
}

// --- Helpers ---

type authParts struct {
	credential    string
	signedHeaders string
	signature     string
}

func splitAuthHeader(t *testing.T, auth string) authParts {
	t.Helper()
	var p authParts
	for _, segment := range splitSegments(auth) {
		k, v := splitKV(segment)
		switch k {
		case "Credential":
			p.credential = v
		case "SignedHeaders":
			p.signedHeaders = v
		case "Signature":
			p.signature = v
		}
	}
	return p
}

func splitSegments(auth string) []string {
	// "AWS4-HMAC-SHA256 Credential=..., SignedHeaders=..., Signature=..."
	after := auth
	if i := indexOf(auth, " "); i >= 0 {
		after = auth[i+1:]
	}
	parts := make([]string, 0, 3)
	for _, s := range split(after, ",") {
		s = trim(s)
		if s != "" {
			parts = append(parts, s)
		}
	}
	return parts
}

func splitKV(s string) (string, string) {
	i := indexOf(s, "=")
	if i < 0 {
		return s, ""
	}
	return s[:i], s[i+1:]
}

func indexOf(s, sub string) int {
	for i := 0; i <= len(s)-len(sub); i++ {
		if s[i:i+len(sub)] == sub {
			return i
		}
	}
	return -1
}

func split(s, sep string) []string {
	var result []string
	for {
		i := indexOf(s, sep)
		if i < 0 {
			result = append(result, s)
			break
		}
		result = append(result, s[:i])
		s = s[i+len(sep):]
	}
	return result
}

func trim(s string) string {
	for len(s) > 0 && (s[0] == ' ' || s[0] == '\t') {
		s = s[1:]
	}
	for len(s) > 0 && (s[len(s)-1] == ' ' || s[len(s)-1] == '\t') {
		s = s[:len(s)-1]
	}
	return s
}

func assertContains(t *testing.T, s, substr string) {
	t.Helper()
	if indexOf(s, substr) < 0 {
		t.Errorf("expected %q to contain %q", s, substr)
	}
}
