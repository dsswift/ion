package studioclient

import (
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

// e2eVectors is packages/shared/src/e2e/__fixtures__/e2e-vectors.json, which
// the TypeScript implementation computes and checks in.
type e2eVectors struct {
	KeyDerivationInfo     string `json:"keyDerivationInfo"`
	RelayEnvelopeVersion  int    `json:"relayEnvelopeVersion"`
	StudioProtocolVersion int    `json:"studioProtocolVersion"`
	ClientPrivateKey      string `json:"clientPrivateKey"`
	ClientPublicKey       string `json:"clientPublicKey"`
	ServerPrivateKey      string `json:"serverPrivateKey"`
	ServerPublicKey       string `json:"serverPublicKey"`
	SharedSecret          string `json:"sharedSecret"`
	ChannelID             string `json:"channelId"`
	HTTPNonce             string `json:"httpNonce"`
	HTTPProof             string `json:"httpProof"`
	RelayProof            string `json:"relayProof"`
	EnvelopePlaintext     string `json:"envelopePlaintext"`
	Envelope              string `json:"envelope"`
}

func loadVectors(t *testing.T) e2eVectors {
	t.Helper()
	path := filepath.Join("..", "..", "..", "packages", "shared", "src", "e2e", "__fixtures__", "e2e-vectors.json")
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read vectors: %v", err)
	}
	var v e2eVectors
	if err := json.Unmarshal(data, &v); err != nil {
		t.Fatalf("parse vectors: %v", err)
	}
	return v
}

func mustHex(t *testing.T, s string) []byte {
	t.Helper()
	b, err := hex.DecodeString(s)
	if err != nil {
		t.Fatal(err)
	}
	return b
}

// TestVectors_ServerFormatCopies pins the Go client's copies of the server's
// formats to the server's own values.
func TestVectors_ServerFormatCopies(t *testing.T) {
	v := loadVectors(t)
	if v.RelayEnvelopeVersion != RelayEnvelopeVersion {
		t.Errorf("relay envelope: server %d, Go client %d", v.RelayEnvelopeVersion, RelayEnvelopeVersion)
	}
	if v.StudioProtocolVersion != studioProtocolVersion {
		t.Errorf("studio wire: server %d, Go client %d", v.StudioProtocolVersion, studioProtocolVersion)
	}
}

func TestVectors_KeyDerivationMatchesTypeScript(t *testing.T) {
	v := loadVectors(t)
	if v.KeyDerivationInfo != E2EKeyDerivationVersion {
		t.Fatalf("info = %q, Go derives with %q", v.KeyDerivationInfo, E2EKeyDerivationVersion)
	}
	client, err := keyPairFromPrivate(mustHex(t, v.ClientPrivateKey))
	if err != nil {
		t.Fatal(err)
	}
	if got := base64.StdEncoding.EncodeToString(client.Public); got != v.ClientPublicKey {
		t.Errorf("client public = %s, want %s", got, v.ClientPublicKey)
	}
	serverPublic, err := base64.StdEncoding.DecodeString(v.ServerPublicKey)
	if err != nil {
		t.Fatal(err)
	}
	secret, err := client.SharedSecret(serverPublic)
	if err != nil {
		t.Fatal(err)
	}
	if hex.EncodeToString(secret) != v.SharedSecret {
		t.Fatalf("shared secret = %x, want %s", secret, v.SharedSecret)
	}
	if ChannelID(secret) != v.ChannelID {
		t.Errorf("channel = %s, want %s", ChannelID(secret), v.ChannelID)
	}
	if proof, err := AuthProof(v.HTTPNonce, secret); err != nil || proof != v.HTTPProof {
		t.Errorf("http proof = %s (%v), want %s", proof, err, v.HTTPProof)
	}
	if proof := RelayProof(secret); proof != v.RelayProof {
		t.Errorf("relay proof = %s, want %s", proof, v.RelayProof)
	}
}

func TestVectors_EnvelopeOpensAndSealsLikeTypeScript(t *testing.T) {
	v := loadVectors(t)
	secret := mustHex(t, v.SharedSecret)
	frame, isBinary, err := OpenFrame(v.Envelope, secret)
	if err != nil || isBinary || string(frame) != v.EnvelopePlaintext {
		t.Fatalf("open = %q binary=%v err=%v", frame, isBinary, err)
	}
	var e envelope
	if err := json.Unmarshal([]byte(v.Envelope), &e); err != nil {
		t.Fatal(err)
	}
	nonce, err := base64.StdEncoding.DecodeString(e.Nonce)
	if err != nil {
		t.Fatal(err)
	}
	_, ct, err := encryptWithNonce([]byte(v.EnvelopePlaintext), secret, nonce)
	if err != nil || ct != e.Ciphertext {
		t.Errorf("Go sealing with the same nonce = %s (%v), want %s", ct, err, e.Ciphertext)
	}
	sealed, err := SealFrame([]byte("hello"), secret)
	if err != nil {
		t.Fatal(err)
	}
	if back, _, err := OpenFrame(sealed, secret); err != nil || string(back) != "hello" {
		t.Errorf("round trip = %q %v", back, err)
	}
	wrong := make([]byte, 32)
	if _, _, err := OpenFrame(v.Envelope, wrong); err == nil {
		t.Error("a wrong key must not open the envelope")
	}
}
