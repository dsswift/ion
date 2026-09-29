package fleet

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"

	"github.com/dsswift/ion/engine/internal/auth"
	"github.com/dsswift/ion/engine/internal/studioclient"
	"github.com/dsswift/ion/engine/internal/utils"
)

// Pairings keeps the fleet's own pairing with each host, encrypted, apart
// from the engine's credential store: ~/.ion/fleet/credentials.enc.
type Pairings struct {
	store *auth.FileStore
}

// OpenPairings opens the pairing store in dir.
func OpenPairings(dir string) *Pairings {
	return &Pairings{store: auth.NewFileStoreAt(dir)}
}

func pairingKey(host string) string { return "fleet-pairing:" + host }

// Get returns the host's pairing, or false when it has none.
func (p *Pairings) Get(host string) (studioclient.Pairing, bool, error) {
	raw, err := p.store.GetKey(pairingKey(host))
	if errors.Is(err, auth.ErrKeyNotFound) || errors.Is(err, os.ErrNotExist) {
		return studioclient.Pairing{}, false, nil
	}
	if err != nil {
		return studioclient.Pairing{}, false, fmt.Errorf("read pairing for %s: %w", host, err)
	}
	var out studioclient.Pairing
	if err := json.Unmarshal([]byte(raw), &out); err != nil {
		return out, false, fmt.Errorf("decode pairing for %s: %w", host, err)
	}
	return out, true, nil
}

// Put stores the host's pairing, replacing any earlier one.
func (p *Pairings) Put(host string, pairing studioclient.Pairing) error {
	data, err := json.Marshal(pairing)
	if err != nil {
		return err
	}
	if err := p.store.SetKey(pairingKey(host), string(data)); err != nil {
		return fmt.Errorf("store pairing for %s: %w", host, err)
	}
	utils.LogWithFields(utils.LevelInfo, logTag, "pairing stored", map[string]any{"fleet_host": host, "client_id": pairing.ClientID, "relay_count": len(pairing.Relays)})
	return nil
}

// Delete forgets the host's pairing.
func (p *Pairings) Delete(host string) error {
	return p.store.DeleteKey(pairingKey(host))
}

func signInKey(host string) string { return "fleet-signin:" + host }

// GetSignIn returns the fleet's own sign-in to an external host, or false.
func (p *Pairings) GetSignIn(host string) (studioclient.SignIn, bool, error) {
	var out studioclient.SignIn
	raw, err := p.store.GetKey(signInKey(host))
	if errors.Is(err, auth.ErrKeyNotFound) || errors.Is(err, os.ErrNotExist) {
		return out, false, nil
	}
	if err != nil {
		return out, false, fmt.Errorf("read sign-in for %s: %w", host, err)
	}
	if err := json.Unmarshal([]byte(raw), &out); err != nil {
		return out, false, fmt.Errorf("decode sign-in for %s: %w", host, err)
	}
	return out, true, nil
}

// PutSignIn stores the host's sign-in, replacing an earlier one: after a
// sign-in, and after every refresh that rotated the refresh token.
func (p *Pairings) PutSignIn(host string, s studioclient.SignIn) error {
	data, err := json.Marshal(s)
	if err != nil {
		return err
	}
	if err := p.store.SetKey(signInKey(host), string(data)); err != nil {
		return fmt.Errorf("store sign-in for %s: %w", host, err)
	}
	utils.LogWithFields(utils.LevelDebug, logTag, "sign-in stored", map[string]any{"fleet_host": host, "issuer": s.Issuer, "client_id": s.ClientID})
	return nil
}

// DeleteSignIn forgets the host's sign-in.
func (p *Pairings) DeleteSignIn(host string) error {
	return p.store.DeleteKey(signInKey(host))
}
