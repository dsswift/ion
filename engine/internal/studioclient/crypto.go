// Package studioclient is a Go client for a Studio server that works through
// a relay: it pairs, derives the shared secret, joins the pairing's relay
// channel, seals every Studio wire frame, says hello, and runs read-only
// actions. `ion fleet` uses it to read a host's status when SSH cannot reach
// the host.
//
// The crypto matches packages/shared/src/e2e (and iOS CryptoKit): X25519, then
// HKDF-SHA256 with a zero salt and info E2EKeyDerivationVersion; AES-256-GCM
// with a 12-byte nonce and the 16-byte tag appended to the ciphertext, both
// base64. packages/shared/src/e2e/__fixtures__/e2e-vectors.json, written by
// the TypeScript side and read by vectors_test.go, pins the two together.
package studioclient

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/ecdh"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"fmt"
)

// E2EKeyDerivationVersion is the HKDF info string of the pairing key
// derivation. Both ends of a pairing must share it.
const E2EKeyDerivationVersion = "ion-remote-v1"

const (
	keyLength   = 32
	nonceLength = 12
	tagLength   = 16
)

// KeyPair is an X25519 key pair as raw 32-byte keys.
type KeyPair struct {
	Public  []byte
	private *ecdh.PrivateKey
}

// GenerateKeyPair makes a fresh X25519 key pair for one pairing.
func GenerateKeyPair() (KeyPair, error) {
	priv, err := ecdh.X25519().GenerateKey(rand.Reader)
	if err != nil {
		return KeyPair{}, fmt.Errorf("generate x25519 key: %w", err)
	}
	return KeyPair{Public: priv.PublicKey().Bytes(), private: priv}, nil
}

// keyPairFromPrivate rebuilds a key pair from a raw private key (test vectors).
func keyPairFromPrivate(raw []byte) (KeyPair, error) {
	priv, err := ecdh.X25519().NewPrivateKey(raw)
	if err != nil {
		return KeyPair{}, err
	}
	return KeyPair{Public: priv.PublicKey().Bytes(), private: priv}, nil
}

// SharedSecret derives the pairing secret from our key and the peer's public key.
func (k KeyPair) SharedSecret(peerPublic []byte) ([]byte, error) {
	pub, err := ecdh.X25519().NewPublicKey(peerPublic)
	if err != nil {
		return nil, fmt.Errorf("peer public key: %w", err)
	}
	raw, err := k.private.ECDH(pub)
	if err != nil {
		return nil, fmt.Errorf("x25519: %w", err)
	}
	return hkdfSHA256(raw, []byte(E2EKeyDerivationVersion), keyLength), nil
}

// hkdfSHA256 is RFC 5869 with a zero salt and a single expand round, the
// same derivation the TypeScript side runs.
func hkdfSHA256(ikm, info []byte, length int) []byte {
	extract := hmac.New(sha256.New, make([]byte, 32))
	extract.Write(ikm) //nolint:errcheck // hash writes never fail
	prk := extract.Sum(nil)
	expand := hmac.New(sha256.New, prk)
	expand.Write(info)         //nolint:errcheck // hash writes never fail
	expand.Write([]byte{0x01}) //nolint:errcheck // hash writes never fail
	return expand.Sum(nil)[:length]
}

// ChannelID is the relay channel a pairing's two ends meet on: the first 16
// bytes of SHA-256(secret), hex.
func ChannelID(secret []byte) string {
	sum := sha256.Sum256(secret)
	return hex.EncodeToString(sum[:16])
}

// AuthProof is HMAC-SHA256(secret, base64-decoded nonce), base64.
func AuthProof(nonceB64 string, secret []byte) (string, error) {
	nonce, err := base64.StdEncoding.DecodeString(nonceB64)
	if err != nil {
		return "", fmt.Errorf("decode nonce: %w", err)
	}
	mac := hmac.New(sha256.New, secret)
	mac.Write(nonce) //nolint:errcheck // hash writes never fail
	return base64.StdEncoding.EncodeToString(mac.Sum(nil)), nil
}

// encrypt seals plaintext with AES-256-GCM, returning base64 nonce and
// ciphertext-with-tag.
func encrypt(plaintext, key []byte) (nonceB64, ciphertextB64 string, err error) {
	nonce := make([]byte, nonceLength)
	if _, err := rand.Read(nonce); err != nil {
		return "", "", fmt.Errorf("nonce: %w", err)
	}
	return encryptWithNonce(plaintext, key, nonce)
}

func encryptWithNonce(plaintext, key, nonce []byte) (string, string, error) {
	gcm, err := newGCM(key)
	if err != nil {
		return "", "", err
	}
	sealed := gcm.Seal(nil, nonce, plaintext, nil)
	return base64.StdEncoding.EncodeToString(nonce), base64.StdEncoding.EncodeToString(sealed), nil
}

// decrypt opens what encrypt sealed; any tampering or wrong key is an error.
func decrypt(nonceB64, ciphertextB64 string, key []byte) ([]byte, error) {
	nonce, err := base64.StdEncoding.DecodeString(nonceB64)
	if err != nil || len(nonce) != nonceLength {
		return nil, errors.New("bad nonce")
	}
	sealed, err := base64.StdEncoding.DecodeString(ciphertextB64)
	if err != nil || len(sealed) < tagLength {
		return nil, errors.New("bad ciphertext")
	}
	gcm, err := newGCM(key)
	if err != nil {
		return nil, err
	}
	return gcm.Open(nil, nonce, sealed, nil)
}

func newGCM(key []byte) (cipher.AEAD, error) {
	if len(key) != keyLength {
		return nil, fmt.Errorf("key is %d bytes, want %d", len(key), keyLength)
	}
	block, err := aes.NewCipher(key)
	if err != nil {
		return nil, err
	}
	return cipher.NewGCMWithTagSize(block, tagLength)
}
