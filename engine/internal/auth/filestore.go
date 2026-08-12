package auth

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"os/user"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/dsswift/ion/engine/internal/utils"
)

// hostnameFn is a package-level seam over os.Hostname so tests can simulate
// a hostname change between boots when exercising the legacy machine-derived
// decryption fallback.
var hostnameFn = os.Hostname

// FileStore is an encrypted file-based credential store at ~/.ion/credentials.enc.
//
// Encryption uses AES-256-GCM keyed by a random 256-bit key persisted in a
// 0600 keyfile (~/.ion/credentials.key) next to the store. The keyfile is
// created on first use. This provides basic obfuscation, not strong security --
// it prevents casual reading of credentials from disk but won't stop a
// determined attacker with local access (who could read the keyfile too).
//
// Legacy fallback: stores written by earlier builds were keyed from machine
// identity (SHA-256 of hostname + username). That derivation broke whenever
// the hostname changed between boots (DHCP/mDNS renames), silently losing all
// stored credentials. Decryption still tries the legacy key after the keyfile
// key, and a successful legacy read triggers a one-time transparent
// re-encryption under the keyfile key.
type FileStore struct {
	mu      sync.RWMutex
	path    string
	keyPath string
}

// credentialFile is the on-disk JSON structure inside the encrypted file.
type credentialFile struct {
	Version int               `json:"version"`
	Keys    map[string]string `json:"keys"`
}

// NewFileStore creates a FileStore at ~/.ion/credentials.enc with its
// keyfile at ~/.ion/credentials.key.
func NewFileStore() *FileStore {
	home, err := os.UserHomeDir()
	if err != nil {
		utils.LogWithFields(utils.LevelInfo, "auth.filestore", "cannot determine home dir", map[string]any{"error": err.Error()})
		home = "."
	}
	return &FileStore{
		path:    filepath.Join(home, ".ion", "credentials.enc"),
		keyPath: filepath.Join(home, ".ion", "credentials.key"),
	}
}

// GetKey retrieves the API key for the given provider from the encrypted store.
// A successful read that required the legacy machine-derived key triggers a
// transparent re-encryption of the store under the keyfile key.
func (fs *FileStore) GetKey(provider string) (string, error) {
	fs.mu.RLock()
	creds, legacy, err := fs.readFile()
	fs.mu.RUnlock()
	if err != nil {
		return "", err
	}

	if legacy {
		fs.migrateLegacy()
	}

	key, ok := creds.Keys[provider]
	if !ok {
		return "", fmt.Errorf("no key for provider %q in filestore", provider)
	}
	return key, nil
}

// migrateLegacy re-encrypts the store under the keyfile key after a
// successful legacy-key read. Best-effort: a failure leaves the store
// legacy-encrypted (still readable while the hostname is unchanged) and is
// retried on the next read.
func (fs *FileStore) migrateLegacy() {
	fs.mu.Lock()
	defer fs.mu.Unlock()

	// Re-read under the write lock: another goroutine may have migrated or
	// mutated the file since the read-locked read.
	creds, stillLegacy, err := fs.readFile()
	if err != nil || !stillLegacy {
		return
	}
	if err := fs.writeFile(creds); err != nil {
		utils.LogWithFields(utils.LevelError, "auth.filestore", "legacy credential migration failed", map[string]any{"error": err.Error(), "path": fs.path})
		return
	}
	utils.LogWithFields(utils.LevelInfo, "auth.filestore", "migrated credentials from legacy machine-derived key to keyfile", map[string]any{"path": fs.path, "keyPath": fs.keyfilePath()})
}

// SetKey stores an API key for the given provider in the encrypted store.
func (fs *FileStore) SetKey(provider, key string) error {
	fs.mu.Lock()
	defer fs.mu.Unlock()

	// A negative cached for this provider is now wrong. Invalidating up front
	// rather than on the success path means an interrupted write cannot leave
	// a stale negative behind, which would make a credential that DID land
	// look absent.
	InvalidateHasKey(provider)

	creds, _, err := fs.readFile()
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			// File doesn't exist yet; start fresh. Normal on first use.
			utils.LogWithFields(utils.LevelInfo, "auth.filestore", "credentials file absent; creating new store", map[string]any{"path": fs.path})
		} else {
			// File exists but cannot be read/decrypted. Never silently
			// discard it -- preserve a timestamped backup so no other
			// stored credential (OAuth tokens, other providers) is
			// destroyed, then start fresh.
			bak := fmt.Sprintf("%s.bak-%d", fs.path, time.Now().Unix())
			utils.LogWithFields(utils.LevelError, "auth.filestore", "credentials file undecryptable; preserving backup and starting fresh", map[string]any{"error": err.Error(), "path": fs.path, "backup": bak})
			if renameErr := os.Rename(fs.path, bak); renameErr != nil {
				utils.LogWithFields(utils.LevelError, "auth.filestore", "credentials backup rename failed", map[string]any{"error": renameErr.Error(), "path": fs.path, "backup": bak})
			}
		}
		creds = &credentialFile{
			Version: 1,
			Keys:    make(map[string]string),
		}
	}

	creds.Keys[provider] = key
	return fs.writeFile(creds)
}

// DeleteKey removes the API key for the given provider from the encrypted store.
func (fs *FileStore) DeleteKey(provider string) error {
	fs.mu.Lock()
	defer fs.mu.Unlock()

	// Deleting only ever makes HasKey MORE negative, so this is not strictly
	// required for correctness. It is here so every write path treats the
	// cache identically and nobody has to reason about which ones matter.
	InvalidateHasKey(provider)

	creds, _, err := fs.readFile()
	if err != nil {
		return err
	}

	if _, ok := creds.Keys[provider]; !ok {
		return nil // Nothing to delete
	}

	delete(creds.Keys, provider)
	return fs.writeFile(creds)
}

// readFile reads and decrypts the credential file. The second return value
// reports whether decryption required the legacy machine-derived key (the
// caller should re-encrypt under the keyfile key).
func (fs *FileStore) readFile() (*credentialFile, bool, error) {
	data, err := os.ReadFile(fs.path)
	if err != nil {
		return nil, false, fmt.Errorf("read credentials file: %w", err)
	}

	// File content is hex-encoded ciphertext
	ciphertext, err := hex.DecodeString(string(data))
	if err != nil {
		return nil, false, fmt.Errorf("decode credentials file: %w", err)
	}

	plaintext, legacy, err := fs.decrypt(ciphertext)
	if err != nil {
		return nil, false, fmt.Errorf("decrypt credentials file: %w", err)
	}

	var creds credentialFile
	if err := json.Unmarshal([]byte(plaintext), &creds); err != nil {
		return nil, false, fmt.Errorf("parse credentials file: %w", err)
	}

	if creds.Keys == nil {
		creds.Keys = make(map[string]string)
	}

	return &creds, legacy, nil
}

// writeFile encrypts and writes the credential file with 0600 permissions.
func (fs *FileStore) writeFile(creds *credentialFile) error {
	data, err := json.Marshal(creds)
	if err != nil {
		return fmt.Errorf("marshal credentials: %w", err)
	}

	ciphertext, err := fs.encrypt(string(data))
	if err != nil {
		return fmt.Errorf("encrypt credentials: %w", err)
	}

	encoded := hex.EncodeToString(ciphertext)
	if err := utils.AtomicWriteFile(fs.path, []byte(encoded), 0o600); err != nil {
		return fmt.Errorf("write credentials file: %w", err)
	}

	return nil
}

// keyfilePath returns the configured keyfile path, defaulting to a
// credentials.key sibling of the store file when unset (covers FileStore
// values constructed with only a path, e.g. in tests).
func (fs *FileStore) keyfilePath() string {
	if fs.keyPath != "" {
		return fs.keyPath
	}
	return filepath.Join(filepath.Dir(fs.path), "credentials.key")
}

// loadOrCreateKeyfile returns the 32-byte store key from the keyfile,
// creating the keyfile with fresh random bytes if it does not exist.
// Creation uses O_CREATE|O_EXCL so a concurrent daemon/CLI race resolves to
// one winner; the loser re-reads the winner's key.
func (fs *FileStore) loadOrCreateKeyfile() ([]byte, error) {
	keyPath := fs.keyfilePath()
	if key, err := readKeyfile(keyPath); err == nil {
		return key, nil
	} else if !errors.Is(err, os.ErrNotExist) {
		// Present but malformed/unreadable. Do not overwrite -- an existing
		// store may be encrypted under it and regenerating would orphan it.
		return nil, err
	}

	key := make([]byte, 32)
	if _, err := io.ReadFull(rand.Reader, key); err != nil {
		return nil, fmt.Errorf("generate keyfile key: %w", err)
	}

	if err := os.MkdirAll(filepath.Dir(keyPath), 0o700); err != nil {
		return nil, fmt.Errorf("create keyfile dir: %w", err)
	}

	f, err := os.OpenFile(keyPath, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o600)
	if err != nil {
		if errors.Is(err, os.ErrExist) {
			// Lost the creation race to another process; use its key.
			return readKeyfile(keyPath)
		}
		return nil, fmt.Errorf("create keyfile: %w", err)
	}
	if _, err := f.WriteString(hex.EncodeToString(key)); err != nil {
		closeErr := f.Close()
		if closeErr != nil {
			utils.LogWithFields(utils.LevelError, "auth.filestore", "keyfile close failed after write error", map[string]any{"error": closeErr.Error(), "keyPath": keyPath})
		}
		return nil, fmt.Errorf("write keyfile: %w", err)
	}
	if err := f.Close(); err != nil {
		return nil, fmt.Errorf("close keyfile: %w", err)
	}

	utils.LogWithFields(utils.LevelInfo, "auth.filestore", "created credential keyfile", map[string]any{"keyPath": keyPath})
	return key, nil
}

// readKeyfile reads and validates a hex-encoded 32-byte key from path.
func readKeyfile(path string) ([]byte, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	key, err := hex.DecodeString(strings.TrimSpace(string(data)))
	if err != nil {
		return nil, fmt.Errorf("decode keyfile %s: %w", path, err)
	}
	if len(key) != 32 {
		return nil, fmt.Errorf("keyfile %s: expected 32-byte key, got %d bytes", path, len(key))
	}
	return key, nil
}

// deriveLegacyKey produces the legacy 32-byte AES key from machine identity
// (SHA-256 of hostname + username). Retained only as a decryption fallback
// for stores written by earlier builds; the hostname component made this
// derivation break across reboots when DHCP/mDNS renamed the machine.
func deriveLegacyKey() []byte {
	hostname, _ := hostnameFn() //nolint:errcheck // empty hostname is an acceptable key-derivation input
	u, _ := user.Current()      //nolint:errcheck // nil user handled below
	username := ""
	if u != nil {
		username = u.Username
	}

	h := sha256.New()
	h.Write([]byte("ion-credentials:"))
	h.Write([]byte(hostname))
	h.Write([]byte(":"))
	h.Write([]byte(username))
	return h.Sum(nil)
}

// encrypt performs AES-GCM encryption under the keyfile key and returns
// nonce + ciphertext.
func (fs *FileStore) encrypt(plaintext string) ([]byte, error) {
	key, err := fs.loadOrCreateKeyfile()
	if err != nil {
		return nil, fmt.Errorf("load keyfile: %w", err)
	}
	return encryptWithKey(key, plaintext)
}

// decrypt performs AES-GCM decryption. Expects nonce prepended to ciphertext.
// Tries the keyfile key first, then the legacy machine-derived key; the bool
// return reports whether the legacy key was required.
func (fs *FileStore) decrypt(data []byte) (string, bool, error) {
	key, err := fs.loadOrCreateKeyfile()
	if err != nil {
		utils.LogWithFields(utils.LevelError, "auth.filestore", "keyfile load failed; trying legacy key only", map[string]any{"error": err.Error(), "keyPath": fs.keyfilePath()})
	} else {
		if plaintext, decErr := decryptWithKey(key, data); decErr == nil {
			return plaintext, false, nil
		}
	}

	if plaintext, decErr := decryptWithKey(deriveLegacyKey(), data); decErr == nil {
		return plaintext, true, nil
	}

	return "", false, errors.New("not decryptable with keyfile or legacy machine-derived key")
}

// encryptWithKey performs AES-GCM encryption with the given 32-byte key and
// returns nonce + ciphertext.
func encryptWithKey(key []byte, plaintext string) ([]byte, error) {
	block, err := aes.NewCipher(key)
	if err != nil {
		return nil, fmt.Errorf("create cipher: %w", err)
	}

	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return nil, fmt.Errorf("create GCM: %w", err)
	}

	nonce := make([]byte, gcm.NonceSize())
	if _, err := io.ReadFull(rand.Reader, nonce); err != nil {
		return nil, fmt.Errorf("generate nonce: %w", err)
	}

	ciphertext := gcm.Seal(nonce, nonce, []byte(plaintext), nil)
	return ciphertext, nil
}

// decryptWithKey performs AES-GCM decryption with the given 32-byte key.
// Expects nonce prepended to ciphertext.
func decryptWithKey(key []byte, data []byte) (string, error) {
	block, err := aes.NewCipher(key)
	if err != nil {
		return "", fmt.Errorf("create cipher: %w", err)
	}

	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return "", fmt.Errorf("create GCM: %w", err)
	}

	nonceSize := gcm.NonceSize()
	if len(data) < nonceSize {
		return "", fmt.Errorf("ciphertext too short")
	}

	nonce, ciphertext := data[:nonceSize], data[nonceSize:]
	plaintext, err := gcm.Open(nil, nonce, ciphertext, nil)
	if err != nil {
		return "", fmt.Errorf("decrypt: %w", err)
	}

	return string(plaintext), nil
}
