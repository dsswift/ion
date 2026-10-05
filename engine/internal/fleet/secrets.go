package fleet

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

// The desktop's secret format (server/src/utils/secretStore.ts): the string
// "enc:v3:" followed by base64(nonce[12] || tag[16] || ciphertext), sealed
// with AES-256-GCM under the 32-byte key stored as hex in
// <data dir>/desktop-secrets.key. Studio writes the pairings it makes this
// way; the fleet reads and writes the same values so both use one pairing.

const (
	secretPrefix     = "enc:v3:"
	secretNonceBytes = 12
	secretTagBytes   = 16
	secretKeyBytes   = 32
	secretKeyFile    = "desktop-secrets.key"
)

// errLegacySecret is a value sealed by a scheme only the desktop app can
// open (its OS keychain). The desktop rewrites it the next time it saves.
var errLegacySecret = errors.New("this secret was stored by an older Ion desktop and only it can read it; open Ion on this machine once, then try again")

// secretKey reads the key file in dir, creating it when create is set and
// none exists.
func secretKey(dir string, create bool) ([]byte, error) {
	path := filepath.Join(dir, secretKeyFile)
	data, err := os.ReadFile(path)
	if errors.Is(err, os.ErrNotExist) && create {
		key := make([]byte, secretKeyBytes)
		if _, err := rand.Read(key); err != nil {
			return nil, err
		}
		if err := os.MkdirAll(dir, 0o700); err != nil {
			return nil, err
		}
		// O_EXCL: a key another process created first is the one to use.
		f, openErr := os.OpenFile(path, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o600)
		if errors.Is(openErr, os.ErrExist) {
			return secretKey(dir, false)
		}
		if openErr != nil {
			return nil, openErr
		}
		defer f.Close() //nolint:errcheck // the write's error is the one returned
		if _, err := f.WriteString(hex.EncodeToString(key)); err != nil {
			return nil, err
		}
		return key, nil
	}
	if err != nil {
		return nil, fmt.Errorf("read the secret key %s: %w", path, err)
	}
	key, err := hex.DecodeString(strings.TrimSpace(string(data)))
	if err != nil || len(key) != secretKeyBytes {
		return nil, fmt.Errorf("the secret key %s is malformed", path)
	}
	return key, nil
}

func secretGCM(key []byte) (cipher.AEAD, error) {
	block, err := aes.NewCipher(key)
	if err != nil {
		return nil, err
	}
	return cipher.NewGCM(block)
}

// sealSecret seals plaintext the way the desktop does.
func sealSecret(plaintext string, key []byte) (string, error) {
	gcm, err := secretGCM(key)
	if err != nil {
		return "", err
	}
	nonce := make([]byte, secretNonceBytes)
	if _, err := rand.Read(nonce); err != nil {
		return "", err
	}
	// Go appends the tag to the ciphertext; the stored layout puts it first.
	sealed := gcm.Seal(nil, nonce, []byte(plaintext), nil)
	ct, tag := sealed[:len(sealed)-secretTagBytes], sealed[len(sealed)-secretTagBytes:]
	out := make([]byte, 0, len(nonce)+len(sealed))
	out = append(out, nonce...)
	out = append(out, tag...)
	out = append(out, ct...)
	return secretPrefix + base64.StdEncoding.EncodeToString(out), nil
}

// openSecret opens a value the desktop sealed.
func openSecret(value string, key []byte) (string, error) {
	if !strings.HasPrefix(value, secretPrefix) {
		if strings.HasPrefix(value, "enc:") {
			return "", errLegacySecret
		}
		return "", errors.New("the stored secret is not sealed")
	}
	raw, err := base64.StdEncoding.DecodeString(strings.TrimPrefix(value, secretPrefix))
	if err != nil || len(raw) < secretNonceBytes+secretTagBytes {
		return "", errors.New("the stored secret is malformed")
	}
	nonce, tag, ct := raw[:secretNonceBytes], raw[secretNonceBytes:secretNonceBytes+secretTagBytes], raw[secretNonceBytes+secretTagBytes:]
	gcm, err := secretGCM(key)
	if err != nil {
		return "", err
	}
	plain, err := gcm.Open(nil, nonce, append(append([]byte{}, ct...), tag...), nil)
	if err != nil {
		return "", errors.New("the stored secret does not open with this machine's key")
	}
	return string(plain), nil
}
