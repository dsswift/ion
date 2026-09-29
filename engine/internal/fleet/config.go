// Package fleet is `ion fleet`: many Studio hosts managed from one Mac. It
// reads the fleet file, collects each host's status (over SSH, else through
// the relay with the fleet's own pairing), judges which hosts can work with
// which by their Format Versions, and redeploys hosts.
package fleet

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"

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

// Config is the fleet file, ~/.ion/fleet.json.
type Config struct {
	// Checkout is the Ion checkout dev builds and desktop deploys run from.
	Checkout string `json:"checkout,omitempty"`
	// Concurrency is how many hosts deploy at once (default 4).
	Concurrency int    `json:"concurrency,omitempty"`
	Hosts       []Host `json:"hosts"`
	// Profiles are named deploy settings hosts share.
	Profiles map[string]Profile `json:"profiles,omitempty"`
}

// Host is one machine in the fleet.
type Host struct {
	Name string `json:"name"`
	// SSH is the `[user@]host` the host is reached at, or "local".
	SSH string `json:"ssh,omitempty"`
	// URL is the address of a server deployed outside the fleet (a cluster
	// deployment): the fleet only reads it, never changes it. A host has an
	// SSH target or a URL, not both.
	URL  string `json:"url,omitempty"`
	Kind string `json:"kind"`
	// Profile names this host's deploy settings in Config.Profiles.
	Profile string `json:"profile,omitempty"`
	// AskSudo: the host's sudo asks for a password, so its desktop install
	// runs last, alone, on this terminal.
	AskSudo bool `json:"askSudo,omitempty"`
	// BuildDir is where the host builds when it is a Builder Host: an
	// absolute path, or one under its home. Default .ion/fleet-build/ion.
	BuildDir string `json:"buildDir,omitempty"`
}

// External reports whether the host is deployed outside the fleet, which
// only reads it.
func (h Host) External() bool { return h.URL != "" }

// ErrExternal is the refusal for a change to an external host.
func (h Host) ErrExternal() error {
	return fmt.Errorf("%s is deployed outside the fleet (%s); the fleet only reads it, so change it where it is deployed", h.Name, h.URL)
}

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

// Load reads and validates the fleet file. A missing file is an empty fleet.
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

// Save writes the fleet file, owner-only.
func Save(path string, c Config) error {
	if err := c.Validate(); err != nil {
		return err
	}
	sort.SliceStable(c.Hosts, func(i, j int) bool { return c.Hosts[i].Name < c.Hosts[j].Name })
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
	utils.LogWithFields(utils.LevelInfo, logTag, "fleet file saved", map[string]any{"path": path, "host_count": len(c.Hosts)})
	return nil
}

// Validate checks names, targets, kinds, and profile references.
func (c Config) Validate() error {
	seen := map[string]bool{}
	for _, h := range c.Hosts {
		if !hostName.MatchString(h.Name) {
			return fmt.Errorf("host name %q: use letters, digits, dot, dash, underscore", h.Name)
		}
		if seen[h.Name] {
			return fmt.Errorf("host %q is listed twice", h.Name)
		}
		seen[h.Name] = true
		switch {
		case h.SSH == "" && h.URL == "":
			return fmt.Errorf("host %q has no ssh target or url", h.Name)
		case h.SSH != "" && h.URL != "":
			return fmt.Errorf("host %q has both an ssh target and a url; a url is for a server deployed outside the fleet", h.Name)
		case h.URL != "" && !strings.HasPrefix(h.URL, "https://") && !strings.HasPrefix(h.URL, "http://"):
			return fmt.Errorf("host %q: url must start with https://", h.Name)
		case h.URL != "" && h.Kind != KindServer:
			return fmt.Errorf("host %q: a host with a url is a server", h.Name)
		}
		if h.Kind != KindServer && h.Kind != KindDesktop {
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

// Host returns the named host.
func (c Config) Host(name string) (Host, bool) {
	for _, h := range c.Hosts {
		if h.Name == name {
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
			return nil, fmt.Errorf("no host named %q in the fleet file", n)
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
