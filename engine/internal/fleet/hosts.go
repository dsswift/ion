package fleet

import (
	"net/url"
	"strconv"
	"strings"

	"github.com/dsswift/ion/engine/internal/utils"
)

// The fleet's hosts are this machine and every server in the device's
// Environment catalog. A catalog entry names a server by a label a person
// chose; a host name is that label made safe for a command line.

// hostSlug turns a catalog label into a host name: letters, digits, dot,
// dash, and underscore, with every other run of characters one dash.
func hostSlug(label string) string {
	var b strings.Builder
	dash := false
	for _, r := range label {
		ok := (r >= 'a' && r <= 'z') || (r >= 'A' && r <= 'Z') || (r >= '0' && r <= '9') || r == '.' || r == '_' || r == '-'
		if ok {
			if dash && b.Len() > 0 {
				b.WriteByte('-')
			}
			dash = false
			b.WriteRune(r)
			continue
		}
		dash = true
	}
	slug := strings.TrimLeft(b.String(), "._-")
	if slug == "" {
		return "server"
	}
	return slug
}

// LocalHostName names this machine in the fleet.
func LocalHostName() string {
	return hostSlug(shortHostname())
}

// hostFromEntry is the fleet's view of one catalog entry.
func hostFromEntry(e Entry, name string) Host {
	h := Host{Name: name, ManageOnly: e.ManageOnly}
	if e.Label != name {
		h.Label = e.Label
	}
	// A `via: ssh` entry's url is the server's loopback as seen from its own
	// host, so the server does not answer there from here.
	if e.Via != ViaSSHTunnel {
		h.URL = e.URL
	}
	if e.SSH != nil && e.SSH.Port == 0 {
		h.SSH = e.SSH.Destination
	}
	if d := e.Deploy; d != nil {
		if d.SSH != "" {
			h.SSH = d.SSH
		}
		h.Kind, h.Profile, h.AskSudo, h.BuildDir = d.Kind, d.Profile, d.AskSudo, d.BuildDir
	}
	entry := e
	h.Entry = &entry
	return h
}

// UseCatalog sets the fleet's hosts: this machine first, then every catalog
// entry in catalog order. Two entries whose labels make the same name get a
// number after the first.
func (c *Config) UseCatalog(cat *Catalog) error {
	entries, err := cat.Entries()
	if err != nil {
		return err
	}
	local := Host{Name: LocalHostName(), SSH: LocalSSH}
	hosts := []Host{local}
	taken := map[string]bool{local.Name: true}
	for _, e := range entries {
		base := hostSlug(e.Label)
		name := base
		for n := 2; taken[name]; n++ {
			name = base + "-" + strconv.Itoa(n)
		}
		taken[name] = true
		hosts = append(hosts, hostFromEntry(e, name))
	}
	c.Hosts = hosts
	utils.LogWithFields(utils.LevelDebug, logTag, "fleet hosts read from the catalog", map[string]any{"host_count": len(hosts)})
	return c.Validate()
}

// entryPort is the port of the server behind an entry: its SSH leg's remote
// port, else its url's, else the default.
func entryPort(e Entry) string {
	if e.SSH != nil && e.SSH.RemotePort > 0 {
		return strconv.Itoa(e.SSH.RemotePort)
	}
	if u, err := url.Parse(e.URL); err == nil && u.Port() != "" {
		return u.Port()
	}
	return "7331"
}

// platformFromReport maps a host report's platform and CPU, as Node names
// them, to Go's names.
func platformFromReport(platform, arch string) (goos, goarch string) {
	goos, goarch = platform, arch
	if platform == "win32" {
		goos = "windows"
	}
	if arch == "x64" {
		goarch = "amd64"
	}
	return goos, goarch
}
