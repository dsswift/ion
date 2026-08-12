package awssig

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"net/http"
	"net/url"
	"sort"
	"strings"
	"time"
)

// Credentials holds AWS credentials for signing.
type Credentials struct {
	AccessKeyID     string
	SecretAccessKey string
	SessionToken    string
}

// Signer produces AWS Signature Version 4 signatures for HTTP requests.
type Signer struct {
	Service string
	Region  string
	Creds   Credentials

	// Clock returns the current UTC time. When nil, time.Now().UTC() is used.
	// Inject a fixed clock in tests for deterministic signatures.
	Clock func() time.Time
}

// SignRequest signs an HTTP request in place using AWS SigV4. The payload is
// the raw request body; pass nil or an empty slice for bodyless requests (the
// signer hashes whatever is provided).
func (s *Signer) SignRequest(req *http.Request, payload []byte) error {
	if s.Creds.AccessKeyID == "" || s.Creds.SecretAccessKey == "" {
		return fmt.Errorf("AWS credentials not configured")
	}
	if s.Service == "" || s.Region == "" {
		return fmt.Errorf("AWS service and region are required")
	}

	now := s.now()
	datestamp := now.Format("20060102")
	amzDate := now.Format("20060102T150405Z")

	req.Header.Set("X-Amz-Date", amzDate)
	if s.Creds.SessionToken != "" {
		req.Header.Set("X-Amz-Security-Token", s.Creds.SessionToken)
	}
	req.Header.Set("Host", req.URL.Host)

	payloadHash := hashSHA256(payload)

	signedHeaders := sortedHeaderNames(req)
	canonicalReq := strings.Join([]string{
		req.Method,
		canonicalURI(req.URL),
		canonicalQueryString(req.URL),
		buildCanonicalHeaderString(req, signedHeaders),
		strings.Join(signedHeaders, ";"),
		payloadHash,
	}, "\n")

	credentialScope := fmt.Sprintf("%s/%s/%s/aws4_request", datestamp, s.Region, s.Service)
	stringToSign := strings.Join([]string{
		"AWS4-HMAC-SHA256",
		amzDate,
		credentialScope,
		hashSHA256([]byte(canonicalReq)),
	}, "\n")

	signingKey := deriveSigningKey(s.Creds.SecretAccessKey, datestamp, s.Region, s.Service)
	signature := hex.EncodeToString(hmacSHA256(signingKey, []byte(stringToSign)))

	auth := fmt.Sprintf("AWS4-HMAC-SHA256 Credential=%s/%s, SignedHeaders=%s, Signature=%s",
		s.Creds.AccessKeyID, credentialScope, strings.Join(signedHeaders, ";"), signature)
	req.Header.Set("Authorization", auth)

	return nil
}

func (s *Signer) now() time.Time {
	if s.Clock != nil {
		return s.Clock()
	}
	return time.Now().UTC()
}

func canonicalURI(u *url.URL) string {
	path := u.EscapedPath()
	if path == "" {
		return "/"
	}
	return path
}

func canonicalQueryString(u *url.URL) string {
	params := u.Query()
	if len(params) == 0 {
		return ""
	}
	keys := make([]string, 0, len(params))
	for k := range params {
		keys = append(keys, k)
	}
	sort.Strings(keys)

	var pairs []string
	for _, k := range keys {
		vals := params[k]
		sort.Strings(vals)
		for _, v := range vals {
			pairs = append(pairs, awsEncode(k)+"="+awsEncode(v))
		}
	}
	return strings.Join(pairs, "&")
}

func awsEncode(value string) string {
	return strings.ReplaceAll(url.QueryEscape(value), "+", "%20")
}

func shouldSignHeader(name string) bool {
	name = strings.ToLower(name)
	if name == "authorization" || name == "user-agent" || name == "content-length" || name == "transfer-encoding" || name == "connection" {
		return false
	}
	return true
}

func sortedHeaderNames(req *http.Request) []string {
	headers := make([]string, 0, len(req.Header))
	for k := range req.Header {
		if shouldSignHeader(k) {
			headers = append(headers, strings.ToLower(k))
		}
	}
	sort.Strings(headers)
	return headers
}

func buildCanonicalHeaderString(req *http.Request, signedHeaders []string) string {
	var b strings.Builder
	for _, h := range signedHeaders {
		b.WriteString(h)
		b.WriteByte(':')
		values := req.Header.Values(h)
		for i := range values {
			values[i] = strings.Join(strings.Fields(values[i]), " ")
		}
		b.WriteString(strings.Join(values, ","))
		b.WriteByte('\n')
	}
	return b.String()
}

func hashSHA256(data []byte) string {
	h := sha256.Sum256(data)
	return hex.EncodeToString(h[:])
}

func hmacSHA256(key, data []byte) []byte {
	h := hmac.New(sha256.New, key)
	h.Write(data)
	return h.Sum(nil)
}

func deriveSigningKey(secret, datestamp, region, service string) []byte {
	kDate := hmacSHA256([]byte("AWS4"+secret), []byte(datestamp))
	kRegion := hmacSHA256(kDate, []byte(region))
	kService := hmacSHA256(kRegion, []byte(service))
	return hmacSHA256(kService, []byte("aws4_request"))
}
