package fleet

import (
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"

	"github.com/dsswift/ion/engine/internal/studioclient"
	"github.com/dsswift/ion/engine/internal/utils"
)

// The fleet is every server this device is paired with: the Environment
// catalog Studio keeps in <data dir>/desktop.json (`environments`), and the
// secret of each pairing in ~/.ion/desktop-connections.json. The fleet reads
// and writes both, so a server paired in Studio is in the fleet and one
// added here shows up in Studio, with one pairing on the server either way.

// Entry kinds and reach, as the catalog names them.
const (
	EntryPaired  = "paired"
	EntryBearer  = "bearer"
	ViaLAN       = "lan"
	ViaRelayOnly = "relay"
	ViaSSHTunnel = "ssh"
)

// SSHLeg is how a `via: ssh` target is reached: a forward to the server's
// own port on the host.
type SSHLeg struct {
	Destination string `json:"destination"`
	Port        int    `json:"port,omitempty"`
	RemotePort  int    `json:"remotePort"`
}

// DeploySettings is how a server is deployed to from this device.
type DeploySettings struct {
	SSH      string `json:"ssh,omitempty"`
	Kind     string `json:"kind,omitempty"`
	Profile  string `json:"profile,omitempty"`
	AskSudo  bool   `json:"askSudo,omitempty"`
	BuildDir string `json:"buildDir,omitempty"`
}

// EntryOIDC is the sign-in a `bearer` target's server accepts.
type EntryOIDC struct {
	Issuer   string `json:"issuer"`
	Audience string `json:"audience"`
	Scope    string `json:"scope"`
	ClientID string `json:"clientId,omitempty"`
}

// Entry is one catalog entry. Fields the fleet does not know are kept in
// extra and written back unchanged.
type Entry struct {
	Kind          string          `json:"kind"`
	Label         string          `json:"label"`
	URL           string          `json:"url"`
	CredentialRef string          `json:"credentialRef,omitempty"`
	Via           string          `json:"via,omitempty"`
	RelayURLs     []string        `json:"relayUrls,omitempty"`
	SSH           *SSHLeg         `json:"ssh,omitempty"`
	OIDC          *EntryOIDC      `json:"oidc,omitempty"`
	EnvironmentID string          `json:"environmentId,omitempty"`
	Managed       bool            `json:"managed,omitempty"`
	ManageOnly    bool            `json:"manageOnly,omitempty"`
	Deploy        *DeploySettings `json:"deploy,omitempty"`

	extra map[string]json.RawMessage
}

// entryFields are the keys Entry itself carries.
var entryFields = []string{"kind", "label", "url", "credentialRef", "via", "relayUrls", "ssh", "oidc", "environmentId", "managed", "manageOnly", "deploy"}

// UnmarshalJSON keeps the keys Entry does not name.
func (t *Entry) UnmarshalJSON(data []byte) error {
	type plain Entry
	if err := json.Unmarshal(data, (*plain)(t)); err != nil {
		return err
	}
	if err := json.Unmarshal(data, &t.extra); err != nil {
		return err
	}
	for _, k := range entryFields {
		delete(t.extra, k)
	}
	return nil
}

// MarshalJSON writes the named fields and the kept ones.
func (t Entry) MarshalJSON() ([]byte, error) {
	type plain Entry
	known, err := json.Marshal(plain(t))
	if err != nil {
		return nil, err
	}
	if len(t.extra) == 0 {
		return known, nil
	}
	merged := map[string]json.RawMessage{}
	if err := json.Unmarshal(known, &merged); err != nil {
		return nil, err
	}
	for k, v := range t.extra {
		merged[k] = v
	}
	return json.Marshal(merged)
}

// CredentialKey is where the target's secret is stored: its credentialRef
// when it is paired, else its environment id.
func (t Entry) CredentialKey() string {
	if t.Kind == EntryPaired && t.CredentialRef != "" {
		return t.CredentialRef
	}
	return t.EnvironmentID
}

// Catalog is the device's Environment catalog and its secrets.
type Catalog struct {
	// settingsPath is desktop.json; connectionsPath the secrets file.
	settingsPath    string
	connectionsPath string
	keyDir          string
}

// OpenCatalog opens the catalog under the Ion data directory. The secrets
// file sits under the home directory's .ion whatever the data directory is,
// as the desktop keeps it.
func OpenCatalog() *Catalog {
	dir := utils.IonDir()
	home, err := utils.UserHomeDir()
	connections := filepath.Join(dir, "desktop-connections.json")
	if err == nil && home != "" {
		connections = filepath.Join(home, ".ion", "desktop-connections.json")
	}
	return &Catalog{settingsPath: filepath.Join(dir, "desktop.json"), connectionsPath: connections, keyDir: dir}
}

// OpenCatalogAt opens a catalog whose files all sit in dir.
func OpenCatalogAt(dir string) *Catalog {
	return &Catalog{settingsPath: filepath.Join(dir, "desktop.json"), connectionsPath: filepath.Join(dir, "desktop-connections.json"), keyDir: dir}
}

// readSettings reads desktop.json as a map of its keys. A missing file is
// an empty map.
func (c *Catalog) readSettings() (map[string]json.RawMessage, error) {
	out := map[string]json.RawMessage{}
	data, err := os.ReadFile(c.settingsPath)
	if errors.Is(err, os.ErrNotExist) {
		return out, nil
	}
	if err != nil {
		return nil, fmt.Errorf("read %s: %w", c.settingsPath, err)
	}
	if err := json.Unmarshal(data, &out); err != nil {
		return nil, fmt.Errorf("parse %s: %w", c.settingsPath, err)
	}
	return out, nil
}

// writeSettings writes desktop.json back, every key it read included.
func (c *Catalog) writeSettings(settings map[string]json.RawMessage) error {
	data, err := json.MarshalIndent(settings, "", "  ")
	if err != nil {
		return err
	}
	if err := utils.AtomicWriteFile(c.settingsPath, data, 0o644); err != nil {
		return fmt.Errorf("write %s: %w", c.settingsPath, err)
	}
	return nil
}

// Entries is every non-local catalog entry, in catalog order.
func (c *Catalog) Entries() ([]Entry, error) {
	settings, err := c.readSettings()
	if err != nil {
		return nil, err
	}
	raw, ok := settings["environments"]
	if !ok {
		return nil, nil
	}
	var entries []Entry
	if err := json.Unmarshal(raw, &entries); err != nil {
		return nil, fmt.Errorf("parse environments in %s: %w", c.settingsPath, err)
	}
	return entries, nil
}

// SetEntries replaces the catalog's entries, leaving every other setting.
func (c *Catalog) SetEntries(entries []Entry) error {
	settings, err := c.readSettings()
	if err != nil {
		return err
	}
	if entries == nil {
		entries = []Entry{}
	}
	raw, err := json.Marshal(entries)
	if err != nil {
		return err
	}
	settings["environments"] = raw
	if err := c.writeSettings(settings); err != nil {
		return err
	}
	utils.LogWithFields(utils.LevelInfo, logTag, "environment catalog written", map[string]any{"path": c.settingsPath, "entry_count": len(entries)})
	return nil
}

// DeviceID is this device's stable id as a paired client, the one Studio
// pairs with. A server keeps one pairing per device id, so the fleet pairing
// under it replaces Studio's on that server and the two share it. Minted
// when the device has none.
func (c *Catalog) DeviceID() (string, error) {
	settings, err := c.readSettings()
	if err != nil {
		return "", err
	}
	var id string
	if raw, ok := settings["deviceId"]; ok && json.Unmarshal(raw, &id) == nil && id != "" {
		return id, nil
	}
	b := make([]byte, 16)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	b[6], b[8] = (b[6]&0x0f)|0x40, (b[8]&0x3f)|0x80
	id = fmt.Sprintf("%x-%x-%x-%x-%x", b[0:4], b[4:6], b[6:8], b[8:10], b[10:16])
	raw, err := json.Marshal(id)
	if err != nil {
		return "", err
	}
	settings["deviceId"] = raw
	if err := c.writeSettings(settings); err != nil {
		return "", err
	}
	utils.LogWithFields(utils.LevelInfo, logTag, "device id minted", map[string]any{"path": c.settingsPath})
	return id, nil
}

// credentialRecord is one entry of the secrets file.
type credentialRecord struct {
	Kind string `json:"kind"`
	Ref  string `json:"ref"`
}

func (c *Catalog) readCredentials() (map[string]credentialRecord, error) {
	out := map[string]credentialRecord{}
	data, err := os.ReadFile(c.connectionsPath)
	if errors.Is(err, os.ErrNotExist) {
		return out, nil
	}
	if err != nil {
		return nil, fmt.Errorf("read %s: %w", c.connectionsPath, err)
	}
	if err := json.Unmarshal(data, &out); err != nil {
		return nil, fmt.Errorf("parse %s: %w", c.connectionsPath, err)
	}
	return out, nil
}

func (c *Catalog) writeCredentials(records map[string]credentialRecord) error {
	data, err := json.MarshalIndent(records, "", "  ")
	if err != nil {
		return err
	}
	if err := utils.AtomicWriteFile(c.connectionsPath, data, 0o600); err != nil {
		return fmt.Errorf("write %s: %w", c.connectionsPath, err)
	}
	return nil
}

func (c *Catalog) loadSecret(key, kind string) (string, bool, error) {
	records, err := c.readCredentials()
	if err != nil {
		return "", false, err
	}
	rec, ok := records[key]
	if !ok || rec.Kind != kind {
		return "", false, nil
	}
	secret, err := secretKey(c.keyDir, false)
	if err != nil {
		return "", false, err
	}
	plain, err := openSecret(rec.Ref, secret)
	if err != nil {
		return "", false, fmt.Errorf("secret %s: %w", key, err)
	}
	return plain, true, nil
}

func (c *Catalog) saveSecret(key, kind, plaintext string) error {
	secret, err := secretKey(c.keyDir, true)
	if err != nil {
		return err
	}
	ref, err := sealSecret(plaintext, secret)
	if err != nil {
		return err
	}
	records, err := c.readCredentials()
	if err != nil {
		return err
	}
	records[key] = credentialRecord{Kind: kind, Ref: ref}
	if err := c.writeCredentials(records); err != nil {
		return err
	}
	utils.LogWithFields(utils.LevelInfo, logTag, "credential saved", map[string]any{"credential_key": key, "kind": kind})
	return nil
}

// DeleteSecret forgets the secret stored under key. A key that holds none
// is not an error.
func (c *Catalog) DeleteSecret(key string) error {
	records, err := c.readCredentials()
	if err != nil {
		return err
	}
	if _, ok := records[key]; !ok {
		return nil
	}
	delete(records, key)
	if err := c.writeCredentials(records); err != nil {
		return err
	}
	utils.LogWithFields(utils.LevelInfo, logTag, "credential removed", map[string]any{"credential_key": key})
	return nil
}

// pairedSecret is the plaintext of a paired credential
// (desktop/src/main/connections/paired-secret.ts).
type pairedSecret struct {
	V               int                  `json:"v"`
	ClientID        string               `json:"clientId"`
	SharedSecret    string               `json:"sharedSecret"`
	Relays          []studioclient.Relay `json:"relays"`
	DirectAddresses []string             `json:"directAddresses,omitempty"`
}

// StoredPairing is a pairing as the catalog holds it: the pairing itself
// and where the server said it answers directly.
type StoredPairing struct {
	studioclient.Pairing
	DirectAddresses []string
}

// Pairing reads the pairing stored under key, or false when there is none.
func (c *Catalog) Pairing(key string) (StoredPairing, bool, error) {
	plain, ok, err := c.loadSecret(key, EntryPaired)
	if err != nil || !ok {
		return StoredPairing{}, false, err
	}
	var rec pairedSecret
	if err := json.Unmarshal([]byte(plain), &rec); err != nil || (rec.V != 1 && rec.V != 2) || rec.ClientID == "" {
		return StoredPairing{}, false, fmt.Errorf("pairing %s: not a pairing record", key)
	}
	secret, err := base64.StdEncoding.DecodeString(rec.SharedSecret)
	if err != nil || len(secret) == 0 {
		return StoredPairing{}, false, fmt.Errorf("pairing %s: unreadable shared secret", key)
	}
	return StoredPairing{
		Pairing:         studioclient.Pairing{ClientID: rec.ClientID, SharedSecret: secret, Relays: rec.Relays},
		DirectAddresses: rec.DirectAddresses,
	}, true, nil
}

// PutPairing stores a pairing under key, replacing any earlier one.
func (c *Catalog) PutPairing(key string, p StoredPairing) error {
	relays := p.Relays
	if relays == nil {
		relays = []studioclient.Relay{}
	}
	data, err := json.Marshal(pairedSecret{V: 2, ClientID: p.ClientID, SharedSecret: base64.StdEncoding.EncodeToString(p.SharedSecret), Relays: relays, DirectAddresses: p.DirectAddresses})
	if err != nil {
		return err
	}
	return c.saveSecret(key, EntryPaired, string(data))
}

// bearerSecret is the plaintext of a bearer credential.
type bearerSecret struct {
	RefreshToken string `json:"refreshToken"`
}

// RefreshToken reads the refresh token stored under key, or false.
func (c *Catalog) RefreshToken(key string) (string, bool, error) {
	plain, ok, err := c.loadSecret(key, EntryBearer)
	if err != nil || !ok {
		return "", false, err
	}
	var rec bearerSecret
	if err := json.Unmarshal([]byte(plain), &rec); err != nil || rec.RefreshToken == "" {
		return "", false, fmt.Errorf("sign-in %s: not a sign-in record", key)
	}
	return rec.RefreshToken, true, nil
}

// PutRefreshToken stores a refresh token under key: after a sign-in, and
// after every refresh that rotated it.
func (c *Catalog) PutRefreshToken(key, token string) error {
	data, err := json.Marshal(bearerSecret{RefreshToken: token})
	if err != nil {
		return err
	}
	return c.saveSecret(key, EntryBearer, string(data))
}

// Upsert writes an entry: over the one for the same server (the same
// environment id, else the same address), else at the end.
func (c *Catalog) Upsert(entry Entry) error {
	entries, err := c.Entries()
	if err != nil {
		return err
	}
	for i, e := range entries {
		if (entry.EnvironmentID != "" && e.EnvironmentID == entry.EnvironmentID) || (entry.EnvironmentID == "" && e.URL == entry.URL && e.Label == entry.Label) {
			entry.extra = e.extra
			entries[i] = entry
			return c.SetEntries(entries)
		}
	}
	return c.SetEntries(append(entries, entry))
}

// Update edits the entry a host was read from. It reports false when the
// catalog no longer holds it.
func (c *Catalog) Update(h Host, edit func(*Entry)) (bool, error) {
	if h.Entry == nil {
		return false, nil
	}
	entries, err := c.Entries()
	if err != nil {
		return false, err
	}
	for i := range entries {
		if sameEntry(entries[i], *h.Entry) {
			edit(&entries[i])
			return true, c.SetEntries(entries)
		}
	}
	return false, nil
}

// Remove takes the entry a host was read from out of the catalog.
func (c *Catalog) Remove(h Host) (bool, error) {
	if h.Entry == nil {
		return false, nil
	}
	entries, err := c.Entries()
	if err != nil {
		return false, err
	}
	for i := range entries {
		if sameEntry(entries[i], *h.Entry) {
			return true, c.SetEntries(append(entries[:i], entries[i+1:]...))
		}
	}
	return false, nil
}

// sameEntry reports whether two readings are the same catalog entry.
func sameEntry(a, b Entry) bool {
	if a.EnvironmentID != "" || b.EnvironmentID != "" {
		return a.EnvironmentID == b.EnvironmentID
	}
	return a.Kind == b.Kind && a.URL == b.URL && a.Label == b.Label && a.CredentialRef == b.CredentialRef
}
