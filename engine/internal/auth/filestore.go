package auth

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"os/user"
	"path/filepath"
	"sync"

	"github.com/dsswift/ion/engine/internal/utils"
)

// FileStore is an encrypted file-based credential store at ~/.ion/credentials.enc.
// Encryption uses AES-GCM with a key derived from machine identity (hostname + username).
// This provides basic obfuscation, not strong security -- it prevents casual reading
// of credentials from disk but won't stop a determined attacker with local access.
type FileStore struct {
	mu   sync.RWMutex
	path string
}

// credentialFile is the on-disk JSON structure inside the encrypted file.
type credentialFile struct {
	Version int               `json:"version"`
	Keys    map[string]string `json:"keys"`
}

// NewFileStore creates a FileStore at ~/.ion/credentials.enc.
func NewFileStore() *FileStore {
	home, err := os.UserHomeDir()
	if err != nil {
		utils.Log("auth", fmt.Sprintf("cannot determine home dir for filestore: %v", err))
		home = "."
	}
	return &FileStore{
		path: filepath.Join(home, ".ion", "credentials.enc"),
	}
}

// GetKey retrieves the API key for the given provider from the encrypted store.
func (fs *FileStore) GetKey(provider string) (string, error) {
	fs.mu.RLock()
	defer fs.mu.RUnlock()

	creds, err := fs.readFile()
	if err != nil {
		return "", err
	}

	key, ok := creds.Keys[provider]
	if !ok {
		return "", fmt.Errorf("no key for provider %q in filestore", provider)
	}
	return key, nil
}

// SetKey stores an API key for the given provider in the encrypted store.
func (fs *FileStore) SetKey(provider, key string) error {
	fs.mu.Lock()
	defer fs.mu.Unlock()

	creds, err := fs.readFile()
	if err != nil {
		// File doesn't exist yet; start fresh
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

	creds, err := fs.readFile()
	if err != nil {
		return err
	}

	if _, ok := creds.Keys[provider]; !ok {
		return nil // Nothing to delete
	}

	delete(creds.Keys, provider)
	return fs.writeFile(creds)
}

// readFile reads and decrypts the credential file.
func (fs *FileStore) readFile() (*credentialFile, error) {
	data, err := os.ReadFile(fs.path)
	if err != nil {
		return nil, fmt.Errorf("read credentials file: %w", err)
	}

	// File content is hex-encoded ciphertext
	ciphertext, err := hex.DecodeString(string(data))
	if err != nil {
		return nil, fmt.Errorf("decode credentials file: %w", err)
	}

	plaintext, err := fs.decrypt(ciphertext)
	if err != nil {
		return nil, fmt.Errorf("decrypt credentials file: %w", err)
	}

	var creds credentialFile
	if err := json.Unmarshal([]byte(plaintext), &creds); err != nil {
		return nil, fmt.Errorf("parse credentials file: %w", err)
	}

	if creds.Keys == nil {
		creds.Keys = make(map[string]string)
	}

	return &creds, nil
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

	// Ensure parent directory exists
	dir := filepath.Dir(fs.path)
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return fmt.Errorf("create credentials dir: %w", err)
	}

	encoded := hex.EncodeToString(ciphertext)
	if err := os.WriteFile(fs.path, []byte(encoded), 0o600); err != nil {
		return fmt.Errorf("write credentials file: %w", err)
	}

	return nil
}

// deriveKey produces a 32-byte AES key from machine identity.
// Uses SHA-256 of hostname + username. This is basic obfuscation.
func (fs *FileStore) deriveKey() []byte {
	hostname, _ := os.Hostname()
	u, _ := user.Current()
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

// encrypt performs AES-GCM encryption and returns nonce + ciphertext.
func (fs *FileStore) encrypt(plaintext string) ([]byte, error) {
	key := fs.deriveKey()

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

// decrypt performs AES-GCM decryption. Expects nonce prepended to ciphertext.
func (fs *FileStore) decrypt(data []byte) (string, error) {
	key := fs.deriveKey()

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
