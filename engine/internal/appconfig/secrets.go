package appconfig

import (
	"errors"
	"fmt"
)

// Errors a secret read can return. Each names a different condition so a
// caller can tell a provisioning mistake from a value that has not landed.
var (
	// ErrDisabled means no applicationConfig source is configured.
	ErrDisabled = errors.New("application config is not configured")
	// ErrNotSecret means the key is not listed in applicationConfig.secretKeys.
	// Only declared secrets are readable this way: an undeclared key is also
	// visible to extensions, so treating it as a secret would be a lie.
	ErrNotSecret = errors.New("key is not declared in applicationConfig.secretKeys")
	// ErrNotFound means the resolved configuration has no such key.
	ErrNotFound = errors.New("key is not in the resolved application config")
)

// NotReadyError means the reader's view has not resolved.
type NotReadyError struct{ State State }

func (e NotReadyError) Error() string {
	return fmt.Sprintf("application config is %s", e.State)
}

// withoutKeys returns a deep copy of s with every key in keys removed from
// Values. This is how secret values are withheld from every extension-facing
// read: the store keeps them, views never carry them.
func (s Snapshot) withoutKeys(keys map[string]struct{}) Snapshot {
	out := s.clone()
	for key := range keys {
		delete(out.Values, key)
	}
	return out
}

// Secret returns the string value of a declared secret key from subject's
// view. It never logs or wraps the value.
func (s *Store) Secret(subject, key string) (string, error) {
	s.mu.Lock()
	_, declared := s.secrets[key]
	view := s.current.For(subject)
	s.mu.Unlock()
	if !declared {
		return "", ErrNotSecret
	}
	if view.State != StateReady {
		return "", NotReadyError{State: view.State}
	}
	value, ok := view.Values[key]
	if !ok {
		return "", ErrNotFound
	}
	text, ok := value.(string)
	if !ok || text == "" {
		return "", fmt.Errorf("secret %q is not a non-empty string", key)
	}
	return text, nil
}

// ReadSecret reads a declared secret key from the installed store for
// subject. Engine-internal only: no extension-facing path calls it.
func ReadSecret(subject, key string) (string, error) {
	store := Current()
	if store == nil {
		return "", ErrDisabled
	}
	return store.Secret(subject, key)
}
