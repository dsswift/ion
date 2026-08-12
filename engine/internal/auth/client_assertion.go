package auth

import (
	"context"
	"crypto"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/rsa"
	"crypto/sha1" //nolint:gosec // OAuth x5t certificate thumbprints require SHA-1 by protocol.
	"crypto/sha256"
	"crypto/x509"
	"encoding/base64"
	"encoding/json"
	"encoding/pem"
	"fmt"
	"math/big"
	"net/http"
	"os"
	"strings"
	"time"

	"github.com/dsswift/ion/engine/internal/types"
)

type certificateAssertionSource struct {
	certificatePath string
	keyPath         string
	clientID        string
	tokenURL        string
}

func newCertificateSource(cfg types.OAuthConfig, certificatePath, keyPath string) (TokenSource, error) {
	if cfg.ClientID == "" || certificatePath == "" {
		return nil, fmt.Errorf("certificate source requires clientId and certificatePath")
	}
	if err := ensureMachineTokenURL(&cfg); err != nil {
		return nil, err
	}
	assertions := &certificateAssertionSource{
		certificatePath: certificatePath, keyPath: keyPath,
		clientID: cfg.ClientID, tokenURL: cfg.TokenURL,
	}
	return &clientCredentialsSource{
		cfg:       cfg,
		assertion: assertions.assertion,
		client:    &httpClient30s,
	}, nil
}

var httpClient30s = http.Client{Timeout: 30 * time.Second}

func (s *certificateAssertionSource) assertion(context.Context) (string, error) {
	certRaw, err := os.ReadFile(s.certificatePath)
	if err != nil {
		return "", fmt.Errorf("read certificate: %w", err)
	}
	keyRaw := certRaw
	if s.keyPath != "" && s.keyPath != s.certificatePath {
		keyRaw, err = os.ReadFile(s.keyPath)
		if err != nil {
			return "", fmt.Errorf("read certificate key: %w", err)
		}
	}
	cert, err := parseCertificatePEM(certRaw)
	if err != nil {
		return "", err
	}
	signer, alg, err := parseSignerPEM(keyRaw)
	if err != nil {
		return "", err
	}
	if !certificateMatchesSigner(cert, signer) {
		return "", fmt.Errorf("certificate public key does not match private key")
	}
	return buildClientAssertion(s.clientID, s.tokenURL, cert, signer, alg, time.Now().UTC())
}

func parseCertificatePEM(raw []byte) (*x509.Certificate, error) {
	for len(raw) > 0 {
		block, rest := pem.Decode(raw)
		if block == nil {
			break
		}
		raw = rest
		if block.Type == "CERTIFICATE" {
			cert, err := x509.ParseCertificate(block.Bytes)
			if err != nil {
				return nil, fmt.Errorf("parse certificate: %w", err)
			}
			return cert, nil
		}
	}
	return nil, fmt.Errorf("certificate PEM contains no CERTIFICATE block")
}

func parseSignerPEM(raw []byte) (crypto.Signer, string, error) {
	for len(raw) > 0 {
		block, rest := pem.Decode(raw)
		if block == nil {
			break
		}
		raw = rest
		var key any
		var err error
		switch block.Type {
		case "PRIVATE KEY":
			key, err = x509.ParsePKCS8PrivateKey(block.Bytes)
		case "RSA PRIVATE KEY":
			key, err = x509.ParsePKCS1PrivateKey(block.Bytes)
		case "EC PRIVATE KEY":
			key, err = x509.ParseECPrivateKey(block.Bytes)
		default:
			continue
		}
		if err != nil {
			return nil, "", fmt.Errorf("parse private key: %w", err)
		}
		switch k := key.(type) {
		case *rsa.PrivateKey:
			return k, "RS256", nil
		case *ecdsa.PrivateKey:
			if k.Curve != elliptic.P256() {
				return nil, "", fmt.Errorf("unsupported EC curve; ES256 requires P-256")
			}
			return k, "ES256", nil
		default:
			return nil, "", fmt.Errorf("unsupported private key type %T", key)
		}
	}
	return nil, "", fmt.Errorf("PEM contains no supported private key")
}

func certificateMatchesSigner(cert *x509.Certificate, signer crypto.Signer) bool {
	left, err := x509.MarshalPKIXPublicKey(cert.PublicKey)
	if err != nil {
		return false
	}
	right, err := x509.MarshalPKIXPublicKey(signer.Public())
	return err == nil && string(left) == string(right)
}

func buildClientAssertion(clientID, tokenURL string, cert *x509.Certificate, signer crypto.Signer, alg string, now time.Time) (string, error) {
	thumbprint := sha1.Sum(cert.Raw) //nolint:gosec // Required x5t protocol field.
	header := map[string]any{"alg": alg, "typ": "JWT", "x5t": base64.RawURLEncoding.EncodeToString(thumbprint[:])}
	jtiBytes := make([]byte, 24)
	if _, err := rand.Read(jtiBytes); err != nil {
		return "", fmt.Errorf("generate assertion jti: %w", err)
	}
	claims := map[string]any{
		"iss": clientID, "sub": clientID, "aud": tokenURL,
		"iat": now.Unix(), "nbf": now.Add(-30 * time.Second).Unix(),
		"exp": now.Add(5 * time.Minute).Unix(),
		"jti": base64.RawURLEncoding.EncodeToString(jtiBytes),
	}
	encodedHeader, _ := json.Marshal(header) //nolint:errcheck // Maps contain JSON primitives only.
	encodedClaims, _ := json.Marshal(claims) //nolint:errcheck // Maps contain JSON primitives only.
	unsigned := base64.RawURLEncoding.EncodeToString(encodedHeader) + "." + base64.RawURLEncoding.EncodeToString(encodedClaims)
	digest := sha256.Sum256([]byte(unsigned))
	var signature []byte
	var err error
	switch key := signer.(type) {
	case *rsa.PrivateKey:
		signature, err = rsa.SignPKCS1v15(rand.Reader, key, crypto.SHA256, digest[:])
	case *ecdsa.PrivateKey:
		var r, ss *big.Int
		r, ss, err = ecdsa.Sign(rand.Reader, key, digest[:])
		if err == nil {
			size := (key.Curve.Params().BitSize + 7) / 8
			signature = make([]byte, size*2)
			r.FillBytes(signature[:size])
			ss.FillBytes(signature[size:])
		}
	default:
		err = fmt.Errorf("unsupported signer type %T", signer)
	}
	if err != nil {
		return "", fmt.Errorf("sign client assertion: %w", err)
	}
	return strings.Join([]string{unsigned, base64.RawURLEncoding.EncodeToString(signature)}, "."), nil
}
