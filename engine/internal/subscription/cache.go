package subscription

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"

	"github.com/dsswift/ion/engine/internal/auth"
	"github.com/dsswift/ion/engine/internal/types"
)

// CacheEntry is what the engine remembers for one identity and provider: the
// selected subscription with its key, and the options the lookup offered. It
// is stored encrypted in the engine's credential store.
type CacheEntry struct {
	SelectedID string                     `json:"selectedId"`
	Label      string                     `json:"label"`
	Key        string                     `json:"key"`
	Options    []types.SubscriptionOption `json:"options,omitempty"`
	// ResolvedAt is when the lookup that produced Key ran, Unix milliseconds.
	ResolvedAt int64 `json:"resolvedAt"`
}

// Cache persists one CacheEntry per (identity, provider). Load answers
// (nil, nil) for a miss.
type Cache interface {
	Load(identity, provider string) (*CacheEntry, error)
	Save(identity, provider string, entry CacheEntry) error
	Delete(identity, provider string) error
}

// FileStoreCache keeps entries in the encrypted credential store, in the
// identity's own partition, so one person's key never serves another.
type FileStoreCache struct {
	Store *auth.FileStore
}

// NewFileStoreCache uses the engine's default credential store.
func NewFileStoreCache() *FileStoreCache {
	return &FileStoreCache{Store: auth.NewFileStore()}
}

func cacheName(provider string) string {
	return auth.SubscriptionCachePrefix + provider
}

func (c *FileStoreCache) Load(identity, provider string) (*CacheEntry, error) {
	raw, err := c.Store.GetKeyFor(identity, cacheName(provider))
	if errors.Is(err, auth.ErrKeyNotFound) || errors.Is(err, os.ErrNotExist) {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("read subscription cache: %w", err)
	}
	var entry CacheEntry
	if err := json.Unmarshal([]byte(raw), &entry); err != nil {
		return nil, fmt.Errorf("decode subscription cache: %w", err)
	}
	return &entry, nil
}

func (c *FileStoreCache) Save(identity, provider string, entry CacheEntry) error {
	raw, err := json.Marshal(entry)
	if err != nil {
		return fmt.Errorf("encode subscription cache: %w", err)
	}
	if err := c.Store.SetKeyFor(identity, cacheName(provider), string(raw)); err != nil {
		return fmt.Errorf("write subscription cache: %w", err)
	}
	return nil
}

func (c *FileStoreCache) Delete(identity, provider string) error {
	err := c.Store.DeleteKeyFor(identity, cacheName(provider))
	if err != nil && !errors.Is(err, os.ErrNotExist) {
		return fmt.Errorf("delete subscription cache: %w", err)
	}
	return nil
}
