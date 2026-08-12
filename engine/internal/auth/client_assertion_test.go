package auth

import (
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/rsa"
	"crypto/sha1" //nolint:gosec // Test verifies x5t which is SHA-1 by protocol.
	"crypto/sha256"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/base64"
	"encoding/json"
	"encoding/pem"
	"fmt"
	"math/big"
	"strings"
	"testing"
	"time"

	"crypto"
)

func generateRSACertAndKey(t *testing.T) (*x509.Certificate, *rsa.PrivateKey, []byte, []byte) {
	t.Helper()
	key, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatal(err)
	}
	tmpl := &x509.Certificate{
		SerialNumber: big.NewInt(1),
		Subject:      pkix.Name{CommonName: "test"},
		NotBefore:    time.Now().Add(-time.Hour),
		NotAfter:     time.Now().Add(24 * time.Hour),
	}
	certDER, err := x509.CreateCertificate(rand.Reader, tmpl, tmpl, &key.PublicKey, key)
	if err != nil {
		t.Fatal(err)
	}
	cert, err := x509.ParseCertificate(certDER)
	if err != nil {
		t.Fatal(err)
	}
	certPEM := pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: certDER})
	keyDER, err := x509.MarshalPKCS8PrivateKey(key)
	if err != nil {
		t.Fatal(err)
	}
	keyPEM := pem.EncodeToMemory(&pem.Block{Type: "PRIVATE KEY", Bytes: keyDER})
	return cert, key, certPEM, keyPEM
}

func generateECCertAndKey(t *testing.T) (*x509.Certificate, *ecdsa.PrivateKey, []byte, []byte) {
	t.Helper()
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	tmpl := &x509.Certificate{
		SerialNumber: big.NewInt(2),
		Subject:      pkix.Name{CommonName: "ec-test"},
		NotBefore:    time.Now().Add(-time.Hour),
		NotAfter:     time.Now().Add(24 * time.Hour),
	}
	certDER, err := x509.CreateCertificate(rand.Reader, tmpl, tmpl, &key.PublicKey, key)
	if err != nil {
		t.Fatal(err)
	}
	cert, err := x509.ParseCertificate(certDER)
	if err != nil {
		t.Fatal(err)
	}
	certPEM := pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: certDER})
	ecDER, err := x509.MarshalECPrivateKey(key)
	if err != nil {
		t.Fatal(err)
	}
	keyPEM := pem.EncodeToMemory(&pem.Block{Type: "EC PRIVATE KEY", Bytes: ecDER})
	return cert, key, certPEM, keyPEM
}

func decodeJWTParts(t *testing.T, jwt string) (header, claims map[string]any) {
	t.Helper()
	parts := strings.SplitN(jwt, ".", 3)
	if len(parts) != 3 {
		t.Fatalf("JWT has %d parts, want 3", len(parts))
	}
	h, err := base64.RawURLEncoding.DecodeString(parts[0])
	if err != nil {
		t.Fatalf("decode header: %v", err)
	}
	c, err := base64.RawURLEncoding.DecodeString(parts[1])
	if err != nil {
		t.Fatalf("decode claims: %v", err)
	}
	if err := json.Unmarshal(h, &header); err != nil {
		t.Fatalf("parse header: %v", err)
	}
	if err := json.Unmarshal(c, &claims); err != nil {
		t.Fatalf("parse claims: %v", err)
	}
	return
}

func TestBuildClientAssertion_RSA_ClaimsAndSignature(t *testing.T) {
	cert, key, _, _ := generateRSACertAndKey(t)
	now := time.Date(2025, 6, 15, 12, 0, 0, 0, time.UTC)

	jwt, err := buildClientAssertion("client-id", "https://idp.example.com/token", cert, key, "RS256", now)
	if err != nil {
		t.Fatal(err)
	}

	header, claims := decodeJWTParts(t, jwt)

	if header["alg"] != "RS256" {
		t.Errorf("alg = %v, want RS256", header["alg"])
	}
	if header["typ"] != "JWT" {
		t.Errorf("typ = %v, want JWT", header["typ"])
	}
	thumbprint := sha1.Sum(cert.Raw) //nolint:gosec
	wantX5t := base64.RawURLEncoding.EncodeToString(thumbprint[:])
	if header["x5t"] != wantX5t {
		t.Errorf("x5t = %v, want %v", header["x5t"], wantX5t)
	}

	if claims["iss"] != "client-id" || claims["sub"] != "client-id" {
		t.Errorf("iss=%v sub=%v, want client-id", claims["iss"], claims["sub"])
	}
	if claims["aud"] != "https://idp.example.com/token" {
		t.Errorf("aud = %v", claims["aud"])
	}
	iat := int64(claims["iat"].(float64))
	nbf := int64(claims["nbf"].(float64))
	exp := int64(claims["exp"].(float64))
	if iat != now.Unix() {
		t.Errorf("iat = %d, want %d", iat, now.Unix())
	}
	if nbf != now.Add(-30*time.Second).Unix() {
		t.Errorf("nbf = %d, want %d", nbf, now.Add(-30*time.Second).Unix())
	}
	if exp != now.Add(5*time.Minute).Unix() {
		t.Errorf("exp = %d, want %d", exp, now.Add(5*time.Minute).Unix())
	}
	if claims["jti"] == nil || claims["jti"].(string) == "" {
		t.Error("jti should be non-empty")
	}

	// Verify RSA signature.
	parts := strings.SplitN(jwt, ".", 3)
	sigBytes, err := base64.RawURLEncoding.DecodeString(parts[2])
	if err != nil {
		t.Fatalf("decode signature: %v", err)
	}
	unsigned := parts[0] + "." + parts[1]
	digest := sha256.Sum256([]byte(unsigned))
	if err := rsa.VerifyPKCS1v15(&key.PublicKey, crypto.SHA256, digest[:], sigBytes); err != nil {
		t.Errorf("RSA signature verification failed: %v", err)
	}
}

func TestBuildClientAssertion_EC_ClaimsAndSignature(t *testing.T) {
	cert, key, _, _ := generateECCertAndKey(t)
	now := time.Date(2025, 6, 15, 12, 0, 0, 0, time.UTC)

	jwt, err := buildClientAssertion("ec-client", "https://idp.example.com/token", cert, key, "ES256", now)
	if err != nil {
		t.Fatal(err)
	}

	header, claims := decodeJWTParts(t, jwt)
	if header["alg"] != "ES256" {
		t.Errorf("alg = %v, want ES256", header["alg"])
	}
	if claims["iss"] != "ec-client" {
		t.Errorf("iss = %v, want ec-client", claims["iss"])
	}

	thumbprint := sha1.Sum(cert.Raw) //nolint:gosec
	wantX5t := base64.RawURLEncoding.EncodeToString(thumbprint[:])
	if header["x5t"] != wantX5t {
		t.Errorf("x5t = %v, want %v", header["x5t"], wantX5t)
	}

	// Verify ECDSA signature.
	parts := strings.SplitN(jwt, ".", 3)
	sigBytes, err := base64.RawURLEncoding.DecodeString(parts[2])
	if err != nil {
		t.Fatal(err)
	}
	unsigned := parts[0] + "." + parts[1]
	digest := sha256.Sum256([]byte(unsigned))
	size := (key.Curve.Params().BitSize + 7) / 8
	if len(sigBytes) != size*2 {
		t.Fatalf("ECDSA sig length = %d, want %d", len(sigBytes), size*2)
	}
	r := new(big.Int).SetBytes(sigBytes[:size])
	s := new(big.Int).SetBytes(sigBytes[size:])
	if !ecdsa.Verify(&key.PublicKey, digest[:], r, s) {
		t.Error("ECDSA signature verification failed")
	}
}

func TestParseCertificatePEM(t *testing.T) {
	_, _, certPEM, _ := generateRSACertAndKey(t)
	cert, err := parseCertificatePEM(certPEM)
	if err != nil {
		t.Fatalf("parseCertificatePEM: %v", err)
	}
	if cert.Subject.CommonName != "test" {
		t.Errorf("CN = %q, want test", cert.Subject.CommonName)
	}
}

func TestParseCertificatePEM_NoCert(t *testing.T) {
	key, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatal(err)
	}
	keyDER, err := x509.MarshalPKCS8PrivateKey(key)
	if err != nil {
		t.Fatal(err)
	}
	keyPEM := pem.EncodeToMemory(&pem.Block{Type: "PRIVATE KEY", Bytes: keyDER})

	_, err = parseCertificatePEM(keyPEM)
	if err == nil {
		t.Fatal("expected error when PEM has no CERTIFICATE block")
	}
}

func TestParseSignerPEM_RSA(t *testing.T) {
	_, _, _, keyPEM := generateRSACertAndKey(t)
	signer, alg, err := parseSignerPEM(keyPEM)
	if err != nil {
		t.Fatal(err)
	}
	if alg != "RS256" {
		t.Errorf("alg = %q, want RS256", alg)
	}
	if _, ok := signer.(*rsa.PrivateKey); !ok {
		t.Errorf("signer type = %T, want *rsa.PrivateKey", signer)
	}
}

func TestParseSignerPEM_EC(t *testing.T) {
	_, _, _, keyPEM := generateECCertAndKey(t)
	signer, alg, err := parseSignerPEM(keyPEM)
	if err != nil {
		t.Fatal(err)
	}
	if alg != "ES256" {
		t.Errorf("alg = %q, want ES256", alg)
	}
	if _, ok := signer.(*ecdsa.PrivateKey); !ok {
		t.Errorf("signer type = %T, want *ecdsa.PrivateKey", signer)
	}
}

func TestParseSignerPEM_NoKey(t *testing.T) {
	_, _, err := parseSignerPEM([]byte("not a pem"))
	if err != nil {
		return
	}
	t.Fatal("expected error for garbage input")
}

func TestCertificateMatchesSigner_Mismatch(t *testing.T) {
	cert, _, _, _ := generateRSACertAndKey(t)
	otherKey, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatal(err)
	}
	if certificateMatchesSigner(cert, otherKey) {
		t.Error("mismatched cert/key should return false")
	}
}

func TestCertificateMatchesSigner_Match(t *testing.T) {
	cert, key, _, _ := generateRSACertAndKey(t)
	if !certificateMatchesSigner(cert, key) {
		t.Error("matching cert/key should return true")
	}
}

func TestParseSignerPEM_PKCS1RSA(t *testing.T) {
	key, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatal(err)
	}
	keyPEM := pem.EncodeToMemory(&pem.Block{
		Type:  "RSA PRIVATE KEY",
		Bytes: x509.MarshalPKCS1PrivateKey(key),
	})
	signer, alg, err := parseSignerPEM(keyPEM)
	if err != nil {
		t.Fatal(err)
	}
	if alg != "RS256" {
		t.Errorf("alg = %q, want RS256", alg)
	}
	_ = signer
}

func TestParseSignerPEM_UnsupportedKeyType(t *testing.T) {
	// Feed a PEM that decodes but is not RSA/EC. Use a garbage PRIVATE KEY block.
	_, _, err := parseSignerPEM(pem.EncodeToMemory(&pem.Block{
		Type:  "PRIVATE KEY",
		Bytes: []byte("not-a-real-key"),
	}))
	if err == nil {
		t.Fatal("expected error for unparseable key")
	}
	_ = fmt.Sprint(err)
}
