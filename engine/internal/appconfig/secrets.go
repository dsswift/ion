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
	// ErrNotSecret means the key resolves to a plain value. Plain values are
	// visible to extensions, so the engine refuses to inject one as a secret.
	ErrNotSecret = errors.New("key is a plain application config value, not a secret")
	// ErrNotFound means the reader's view has no such key.
	ErrNotFound = errors.New("key is not in the resolved application config")
)

// NotReadyError means the reader's view has not resolved.
type NotReadyError struct{ State State }

func (e NotReadyError) Error() string {
	return fmt.Sprintf("application config is %s", e.State)
}

// Secret returns the value of secret key as the extension trusted as
// extensionID, acting as subject, would see it: its own section overlays the
// common section exactly as View does, so an extension-owned secret is only
// ever read on that extension's behalf. An empty extensionID reads the common
// section only. The value is never logged or wrapped into an error.
func (s Snapshot) Secret(subject, extensionID, key string) (string, error) {
	if subject != "" && s.Subject != "" && subject != s.Subject {
		return "", NotReadyError{State: StateDeferred}
	}
	if !s.State.HasValues() || s.Document == nil {
		return "", NotReadyError{State: s.State}
	}
	var value string
	var plain, secret bool
	overlay := func(section Section) {
		if _, ok := section.Values[key]; ok {
			plain, secret = true, false
		}
		if v, ok := section.Secrets[key]; ok {
			value, plain, secret = v, false, true
		}
	}
	overlay(s.Document.Common)
	if extensionID != "" {
		if own, ok := s.Document.Extensions[extensionID]; ok {
			overlay(own)
		}
	}
	switch {
	case plain:
		return "", ErrNotSecret
	case !secret:
		return "", ErrNotFound
	case value == "":
		return "", fmt.Errorf("secret %q is empty", key)
	}
	return value, nil
}

// ReadSecret reads secret key from the installed store. Engine-internal
// only: no extension-facing path calls it.
func ReadSecret(subject, extensionID, key string) (string, error) {
	store := Current()
	if store == nil {
		return "", ErrDisabled
	}
	return store.Snapshot().Secret(subject, extensionID, key)
}
