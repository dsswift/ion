// Package fleet is `ion fleet`: every server this device is paired with,
// managed from one place. The hosts are the device's Environment catalog,
// the one Studio keeps; the fleet file adds only how deploys run. It
// collects each host's status (over SSH, else over a Studio connection with
// the device's pairing), judges which hosts can work with which by their
// Format Versions, and redeploys hosts.
package fleet

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"regexp"

	"github.com/dsswift/ion/engine/internal/utils"
)

const logTag = "fleet"

// Host kinds: what a host runs, which decides how it is deployed.
const (
	KindServer  = "server"
	KindDesktop = "desktop"
)

// LocalSSH as a host's ssh target runs its commands on this Mac, without SSH.
const LocalSSH = "local"

// Config is the fleet: its hosts, from the device's Environment catalog, and
// the fleet file ~/.ion/fleet.json, which holds how deploys run.
type Config struct {
	// Checkout is the Ion checkout dev builds and desktop deploys run from.
	Checkout string `json:"checkout,omitempty"`
	// Concurrency is how many hosts deploy at once (default 4).
	Concurrency int `json:"concurrency,omitempty"`
	// Hosts are this machine and every server in the Environment catalog
	// (UseCatalog). Never written to the fleet file.
	Hosts []Host `json:"-"`
	// LegacyHosts are hosts an earlier fleet file listed itself, before the
	// fleet read the catalog. Migrate moves each into the catalog.
	LegacyHosts []Host `json:"hosts,omitempty"`
	// Profiles are named deploy settings hosts share.
	Profiles map[string]Profile `json:"profiles,omitempty"`
}

// Host is one machine in the fleet.
type Host struct {
	Name string `json:"name"`
	// Label is the server's name in the Environment catalog, when it differs
	// from Name.
	Label string `json:"label,omitempty"`
	// SSH is the `[user@]host` the host is reached at for a deploy, or
	// "local". Empty for a server the device only talks to over its Studio
	// connection.
	SSH string `json:"ssh,omitempty"`
	// URL is the server's own address, when it answers there directly.
	URL string `json:"url,omitempty"`
	// Kind is what the host runs, when the catalog says; empty means read it
	// from the host.
	Kind string `json:"kind,omitempty"`
	// ManageOnly: the server is in the fleet but no conversation surface
	// offers it.
	ManageOnly bool `json:"manageOnly,omitempty"`
	// Entry is the host's catalog entry; nil for this machine.
	Entry *Entry `json:"-"`
	// Profile names this host's deploy settings in Config.Profiles.
	Profile string `json:"profile,omitempty"`
	// AskSudo: the host's sudo asks for a password, so its desktop install
	// runs last, alone, on this terminal.
	AskSudo bool `json:"askSudo,omitempty"`
	// BuildDir is where the host builds when it is a Builder Host: an
	// absolute path, or one under its home. Default .ion/fleet-build/ion.
	BuildDir string `json:"buildDir,omitempty"`
}

// External reports whether the fleet cannot reach into the host over SSH:
// it has no SSH target. Such a host is read, restarted, and updated over its
// Studio connection only.
func (h Host) External() bool { return h.SSH == "" }

// ErrExternal is the refusal for a change that needs SSH on a host that has
// no SSH target.
func (h Host) ErrExternal() error {
	return fmt.Errorf("%s has no SSH target, so the fleet cannot reach into it; name one with `ion fleet set %s --ssh [user@]host`", h.Name, h.Name)
}

// Paired reports whether the device holds a credential for the host's
// Studio connection.
func (h Host) Paired() bool { return h.Entry != nil }

// BuildDirOrDefault is the host's build folder.
func (h Host) BuildDirOrDefault() string {
	if h.BuildDir != "" {
		return h.BuildDir
	}
	return defaultBuildDir
}

// Profile is how hosts are deployed: the relay they join and extra install
// arguments. A relay key is never stored: RelayKeyCommand prints it at
// deploy time.
type Profile struct {
	Relay           string   `json:"relay,omitempty"`
	RelayOIDC       bool     `json:"relayOidc,omitempty"`
	RelayKeyCommand string   `json:"relayKeyCommand,omitempty"`
	Args            []string `json:"args,omitempty"`
}

var hostName = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._-]*$`)

// DefaultPath is ~/.ion/fleet.json.
func DefaultPath() string {
	return filepath.Join(utils.IonDir(), "fleet.json")
}

// StateDir is ~/.ion/fleet: pairings and deploy logs.
func StateDir() string {
	return filepath.Join(utils.IonDir(), "fleet")
}

// Load reads and validates the fleet file. A missing file is an empty one.
// The hosts come from the catalog: call UseCatalog.
func Load(path string) (Config, error) {
	var c Config
	data, err := os.ReadFile(path)
	if errors.Is(err, os.ErrNotExist) {
		return Config{Profiles: map[string]Profile{}}, nil
	}
	if err != nil {
		return c, fmt.Errorf("read %s: %w", path, err)
	}
	if err := json.Unmarshal(data, &c); err != nil {
		return c, fmt.Errorf("parse %s: %w", path, err)
	}
	if c.Profiles == nil {
		c.Profiles = map[string]Profile{}
	}
	return c, c.Validate()
}

// Save writes the fleet file, owner-only: the checkout, concurrency,
// profiles, and any legacy hosts not yet migrated.
func Save(path string, c Config) error {
	if err := c.Validate(); err != nil {
		return err
	}
	data, err := json.MarshalIndent(c, "", "  ")
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return err
	}
	if err := utils.AtomicWriteFile(path, append(data, '\n'), 0o600); err != nil {
		return fmt.Errorf("write %s: %w", path, err)
	}
	utils.LogWithFields(utils.LevelInfo, logTag, "fleet file saved", map[string]any{"path": path, "legacy_host_count": len(c.LegacyHosts)})
	return nil
}

// Validate checks host names and kinds and profile references.
func (c Config) Validate() error {
	// A host an earlier fleet file listed can also be in the server list
	// already: it moved, and only the revoke of its old pairing is still
	// owed. That is one host, so a name is checked within each list only.
	seen := map[string]bool{}
	for i, h := range append(append([]Host{}, c.Hosts...), c.LegacyHosts...) {
		if i == len(c.Hosts) {
			seen = map[string]bool{}
		}
		if !hostName.MatchString(h.Name) {
			return fmt.Errorf("host name %q: use letters, digits, dot, dash, underscore", h.Name)
		}
		if seen[h.Name] {
			return fmt.Errorf("host %q is listed twice", h.Name)
		}
		seen[h.Name] = true
		if h.Kind != "" && h.Kind != KindServer && h.Kind != KindDesktop {
			return fmt.Errorf("host %q: kind must be %q or %q", h.Name, KindServer, KindDesktop)
		}
		if h.Profile != "" {
			if _, ok := c.Profiles[h.Profile]; !ok {
				return fmt.Errorf("host %q names profile %q, which the fleet file does not define", h.Name, h.Profile)
			}
		}
	}
	for name, p := range c.Profiles {
		if p.RelayOIDC && p.RelayKeyCommand != "" {
			return fmt.Errorf("profile %q: choose relayOidc or relayKeyCommand, not both", name)
		}
		if p.Relay == "" && (p.RelayOIDC || p.RelayKeyCommand != "") {
			return fmt.Errorf("profile %q sets relay auth but no relay", name)
		}
	}
	return nil
}

// Host returns the host of that name. A server is also named by its
// environment id, which is how a program that knows the catalog names it.
func (c Config) Host(name string) (Host, bool) {
	for _, h := range c.Hosts {
		if h.Name == name {
			return h, true
		}
	}
	for _, h := range c.Hosts {
		if h.Entry != nil && h.Entry.EnvironmentID != "" && h.Entry.EnvironmentID == name {
			return h, true
		}
	}
	return Host{}, false
}

// ProfileOf is the host's profile, or the zero profile.
func (c Config) ProfileOf(h Host) Profile {
	return c.Profiles[h.Profile]
}

// Select resolves host names; none means every host. An unknown name is an error.
func (c Config) Select(names []string) ([]Host, error) {
	if len(names) == 0 {
		return append([]Host(nil), c.Hosts...), nil
	}
	var out []Host
	for _, n := range names {
		h, ok := c.Host(n)
		if !ok {
			return nil, fmt.Errorf("no host named %q in the fleet (`ion fleet status` lists them)", n)
		}
		out = append(out, h)
	}
	return out, nil
}

// ConcurrencyOrDefault is Concurrency, or 4.
func (c Config) ConcurrencyOrDefault() int {
	if c.Concurrency > 0 {
		return c.Concurrency
	}
	return 4
}
