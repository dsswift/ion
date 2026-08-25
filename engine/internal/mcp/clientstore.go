package mcp

// clientstore.go — persistence for per-server OAuth client registrations.
//
// A server that supports RFC 7591 dynamic client registration issues a
// client_id on first contact. That identifier is durable engine state, not
// operator configuration: it is minted by the authorization server, it must be
// reused on every subsequent authorization request, and re-registering on each
// login would litter the provider with orphan clients. So it lives here, in
// ~/.ion/mcp-clients.json, alongside the endpoints discovery resolved for it —
// keeping engine.json purely operator-authored.
//
// Shape mirrors OAuthStore in oauth.go deliberately (mutex, load/save, 0600
// file / 0700 dir, package-level singleton): the two stores are siblings, one
// holding what identifies the client and one holding what authorizes it.

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sync"
	"time"

	"github.com/dsswift/ion/engine/internal/utils"
)

// ClientRegistration is a resolved OAuth client for one MCP server: the
// identity issued by (or configured for) the authorization server, plus the
// endpoints needed to run and refresh the grant. Persisting the endpoints
// alongside the client_id means a token refresh never has to re-run discovery.
//
// RedirectURI is load-bearing, not informational. RFC 7591 binds the redirect
// URI to the issued client_id, so every later authorization request for this
// client must present the byte-identical URI the registration declared —
// including its port. Losing it would make the second login for a server fail
// with an invalid_redirect_uri the operator cannot diagnose.
type ClientRegistration struct {
	ClientID     string    `json:"client_id"`
	ClientSecret string    `json:"client_secret,omitempty"`
	Issuer       string    `json:"issuer,omitempty"`
	AuthURL      string    `json:"auth_url"`
	TokenURL     string    `json:"token_url"`
	Scope        string    `json:"scope,omitempty"`
	RedirectURI  string    `json:"redirect_uri,omitempty"`
	RegisteredAt time.Time `json:"registered_at,omitempty"`
	// Resource is the RFC 8707 resource indicator this client was
	// registered for. Stored so refresh and re-login include it.
	Resource string `json:"resource,omitempty"`
}

// ClientStore manages per-server OAuth client registrations with file
// persistence.
type ClientStore struct {
	mu      sync.RWMutex
	clients map[string]*ClientRegistration
	path    string
}

// NewClientStore creates a registration store backed by
// ~/.ion/mcp-clients.json.
func NewClientStore() *ClientStore {
	home, _ := os.UserHomeDir() //nolint:errcheck // empty home degrades to a relative path; Get/Set log their own failures
	storePath := filepath.Join(home, ".ion", "mcp-clients.json")

	store := &ClientStore{
		clients: make(map[string]*ClientRegistration),
		path:    storePath,
	}
	store.load()
	return store
}

// Get returns the stored registration for a server, or nil when none exists.
func (s *ClientStore) Get(serverName string) *ClientRegistration {
	s.mu.RLock()
	defer s.mu.RUnlock()
	reg, ok := s.clients[serverName]
	if !ok {
		return nil
	}
	return reg
}

// Set stores a registration for the server and persists to disk.
func (s *ClientStore) Set(serverName string, reg *ClientRegistration) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.clients[serverName] = reg
	s.save()
}

// Delete removes a server's registration and persists to disk.
func (s *ClientStore) Delete(serverName string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	delete(s.clients, serverName)
	s.save()
}

// Names returns every server that has a stored registration.
func (s *ClientStore) Names() []string {
	s.mu.RLock()
	defer s.mu.RUnlock()
	names := make([]string, 0, len(s.clients))
	for name := range s.clients {
		names = append(names, name)
	}
	return names
}

func (s *ClientStore) save() {
	data, err := json.MarshalIndent(s.clients, "", "  ")
	if err != nil {
		utils.LogWithFields(utils.LevelError, "mcp.clients", "save marshal failed", map[string]any{"path": s.path, "error": err.Error()})
		return
	}
	if err := utils.AtomicWriteFile(s.path, data, 0o600); err != nil {
		utils.LogWithFields(utils.LevelError, "mcp.clients", "save write failed", map[string]any{"path": s.path, "error": err.Error()})
	}
}

func (s *ClientStore) load() {
	data, err := os.ReadFile(s.path)
	if err != nil {
		// A real read error (not simply "no registrations yet") means every
		// server re-registers on next login.
		if !errors.Is(err, os.ErrNotExist) {
			utils.LogWithFields(utils.LevelError, "mcp.clients", "client store read failed", map[string]any{"path": s.path, "error": err.Error()})
		}
		return
	}
	var clients map[string]*ClientRegistration
	if err := json.Unmarshal(data, &clients); err != nil {
		// Corrupt store: every stored client_id silently vanishes and each
		// server re-registers. Log so the cause is visible.
		utils.LogWithFields(utils.LevelError, "mcp.clients", "client store unmarshal failed; stored registrations ignored", map[string]any{"path": s.path, "error": err.Error()})
		return
	}
	if clients == nil {
		// A file containing literal `null` decodes to a nil map. Keep the
		// allocated map from NewClientStore so Set never writes to nil.
		utils.LogWithFields(utils.LevelWarn, "mcp.clients", "client store decoded to null; starting empty", map[string]any{"path": s.path})
		return
	}
	s.clients = clients
	utils.LogWithFields(utils.LevelInfo, "mcp.clients", "client store loaded", map[string]any{"path": s.path, "count": len(clients)})
}

// getClientStore returns the package-level ClientStore for the current home.
// A changed HOME must select a new backing file, not reuse registrations from
// the previous storage root.
var (
	globalClientStore   *ClientStore
	globalClientStoreMu sync.Mutex
)

func getClientStore() *ClientStore {
	home, _ := os.UserHomeDir() //nolint:errcheck // empty home matches NewClientStore fallback
	path := filepath.Join(home, ".ion", "mcp-clients.json")

	globalClientStoreMu.Lock()
	defer globalClientStoreMu.Unlock()
	if globalClientStore == nil || globalClientStore.path != path {
		globalClientStore = NewClientStore()
	}
	return globalClientStore
}

// resetStoresForTest re-reads both the client and token stores from disk.
// Tests that point HOME at a temp dir need this because the singletons are
// built once per process and would otherwise cache the real home's contents
// (or an earlier test's temp dir).
func resetStoresForTest() {
	globalClientStore = NewClientStore()
	globalOAuthStore = NewOAuthStore()
	// In-memory auth state must be cleared alongside the on-disk stores. A
	// recorded grant failure or a held refresh lock surviving a reset leaks
	// between tests, and the leak is not test-only: both maps are keyed by
	// server name and live for the process, so anything that fails to clear an
	// entry misreports one server using another's state.
	lastGrantErrors.Range(func(k, _ any) bool { lastGrantErrors.Delete(k); return true })
	refreshLocks.Range(func(k, _ any) bool { refreshLocks.Delete(k); return true })
	// Memoized discovery documents are process-global for the same reason and
	// leak the same way: a fixture's answer for one server URL would otherwise
	// be served to the next test that probes it.
	resetDiscoveryCaches()
}

// storeErrUnwritable is returned when a registration cannot be persisted; the
// caller surfaces it rather than proceeding with a client_id that will be lost
// on the next process start.
func (s *ClientStore) verifyWritable() error {
	dir := filepath.Dir(s.path)
	if err := os.MkdirAll(dir, 0700); err != nil {
		return fmt.Errorf("mcp client store directory %s is not writable: %w", dir, err)
	}
	return nil
}
