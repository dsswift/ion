package fleet

import (
	"context"
	"errors"
	"fmt"
	"net/url"
	"strings"

	"github.com/dsswift/ion/engine/internal/studioclient"
	"github.com/dsswift/ion/engine/internal/utils"
)

// An earlier fleet kept its own list of hosts in the fleet file and its own
// pairing with each, beside Studio's. Migrate moves every such host into
// the Environment catalog, so the fleet and Studio share one list and one
// pairing per server, and revokes the fleet's old pairing on the host.
//
// It runs before any fleet command while the fleet file still lists hosts,
// and every step can be run again: a host stays in the fleet file until all
// of its steps are done.

// Migration moves the fleet file's hosts into the Environment catalog.
type Migration struct {
	Path    string
	Catalog *Catalog
	// Legacy is the store of the fleet's old pairings and sign-ins.
	Legacy *Pairings
	Pairer Pairer
	Studio Studio
	// Say reports each step to the person; nil is silent.
	Say func(string)
}

func (m Migration) say(format string, args ...any) {
	if m.Say != nil {
		m.Say(fmt.Sprintf(format, args...))
	}
}

// Run migrates every legacy host it can. The fleet file is saved after each
// host that moves, so a run that is cut short keeps what it finished. It
// returns the hosts that still need another run and why.
func (m Migration) Run(ctx context.Context, cfg *Config) map[string]error {
	pending := map[string]error{}
	hosts := cfg.LegacyHosts
	utils.LogWithFields(utils.LevelInfo, logTag, "fleet migration started", map[string]any{"host_count": len(hosts)})
	var left []Host
	for i, h := range hosts {
		if err := m.one(ctx, h); err != nil {
			utils.LogWithFields(utils.LevelWarn, logTag, "fleet host not migrated yet", map[string]any{"fleet_host": h.Name, "error": err.Error()})
			pending[h.Name] = err
			left = append(left, h)
			continue
		}
		utils.LogWithFields(utils.LevelInfo, logTag, "fleet host migrated to the environment catalog", map[string]any{"fleet_host": h.Name})
		// Still owed: the hosts that failed so far, and the ones not reached yet.
		saved := *cfg
		saved.Hosts = nil
		saved.LegacyHosts = append(append([]Host{}, left...), hosts[i+1:]...)
		if err := Save(m.Path, saved); err != nil {
			utils.LogWithFields(utils.LevelWarn, logTag, "fleet file not saved after a host moved", map[string]any{"fleet_host": h.Name, "error": err.Error()})
			pending["fleet file"] = err
		}
	}
	cfg.LegacyHosts = left
	utils.LogWithFields(utils.LevelInfo, logTag, "fleet migration finished", map[string]any{"moved": len(hosts) - len(left), "pending": len(left)})
	return pending
}

func (m Migration) one(ctx context.Context, h Host) error {
	if h.SSH == LocalSSH {
		// This machine is always in the fleet; it needs no entry.
		m.say("%s: this machine is always in the fleet", h.Name)
		return nil
	}
	entries, err := m.Catalog.Entries()
	if err != nil {
		return err
	}
	deploy := deployOf(h)
	entry, found := matchEntry(entries, h)
	if !found {
		if entry, err = m.adopt(ctx, h, entries); err != nil {
			return err
		}
	}
	if deploy != nil {
		entry.Deploy = deploy
		if err := m.Catalog.Upsert(entry); err != nil {
			return err
		}
	}
	if found {
		m.say("%s: already paired in Studio as %q; kept that pairing", h.Name, entry.Label)
	}
	return m.revokeLegacy(ctx, h, entry)
}

// deployOf is how the fleet file said to deploy a host.
func deployOf(h Host) *DeploySettings {
	d := DeploySettings{Kind: h.Kind, Profile: h.Profile, AskSudo: h.AskSudo, BuildDir: h.BuildDir}
	if h.SSH != LocalSSH {
		d.SSH = h.SSH
	}
	if d == (DeploySettings{}) {
		return nil
	}
	return &d
}

// matchEntry finds the catalog entry for the server a fleet host names: the
// same address, the same name, or an address or SSH target on the same
// machine.
func matchEntry(entries []Entry, h Host) (Entry, bool) {
	legacyURL := strings.TrimSuffix(h.URL, "/")
	machine := machineOf(h.SSH)
	for _, e := range entries {
		switch {
		case legacyURL != "" && strings.TrimSuffix(e.URL, "/") == legacyURL:
			return e, true
		case strings.EqualFold(e.Label, h.Name):
			return e, true
		case machine != "" && (machineOf(urlHost(e.URL)) == machine && e.Via != ViaSSHTunnel):
			return e, true
		case machine != "" && e.SSH != nil && machineOf(e.SSH.Destination) == machine:
			return e, true
		case machine != "" && e.Deploy != nil && machineOf(e.Deploy.SSH) == machine:
			return e, true
		}
	}
	return Entry{}, false
}

func urlHost(raw string) string {
	u, err := url.Parse(raw)
	if err != nil {
		return ""
	}
	return u.Hostname()
}

// machineOf is the machine an SSH target or a host name refers to: the host
// part, lower case, without a `.local` suffix.
func machineOf(target string) string {
	if at := strings.LastIndexByte(target, '@'); at >= 0 {
		target = target[at+1:]
	}
	return strings.TrimSuffix(strings.ToLower(strings.TrimSpace(target)), ".local")
}

// adopt brings a host Studio does not know into the catalog as a
// Manage-Only Server: it was in the fleet to be watched and deployed to,
// not to hold conversations.
func (m Migration) adopt(ctx context.Context, h Host, entries []Entry) (Entry, error) {
	if h.SSH == "" {
		return m.adoptSignedIn(ctx, h)
	}
	paired, err := m.Pairer.Pair(ctx, h)
	if err != nil {
		return Entry{}, err
	}
	entry := paired.Entry(h.Name, h)
	entry.ManageOnly = true
	// Pairing under this device's id replaced any pairing Studio held with
	// the same server, so an entry for that server takes the new secret.
	for _, e := range entries {
		if paired.EnvironmentID != "" && e.EnvironmentID == paired.EnvironmentID {
			if err := m.Catalog.PutPairing(e.CredentialKey(), StoredPairing{Pairing: paired.Pairing}); err != nil {
				return Entry{}, err
			}
			m.say("%s: Studio already knows this server as %q; refreshed its pairing", h.Name, e.Label)
			return e, nil
		}
	}
	if err := m.Catalog.PutPairing(entry.CredentialKey(), StoredPairing{Pairing: paired.Pairing}); err != nil {
		return Entry{}, err
	}
	if err := m.Catalog.Upsert(entry); err != nil {
		return Entry{}, err
	}
	m.say("%s: paired and added to Studio as a manage-only server", h.Name)
	return entry, nil
}

// adoptSignedIn brings a host the fleet read at its own address into the
// catalog with the sign-in the fleet held for it.
func (m Migration) adoptSignedIn(ctx context.Context, h Host) (Entry, error) {
	if m.Legacy == nil {
		return Entry{}, errors.New("no sign-in to carry over; add it with `ion fleet add NAME --url URL`")
	}
	old, ok, err := m.Legacy.GetSignIn(h.Name)
	if err != nil {
		return Entry{}, err
	}
	if !ok {
		return Entry{}, fmt.Errorf("the fleet held no sign-in for it; add it with `ion fleet add %s --url %s`", h.Name, h.URL)
	}
	pub, err := studioclient.ReadPublic(ctx, h.URL)
	if err != nil {
		return Entry{}, err
	}
	if pub.Auth.OIDC == nil {
		return Entry{}, errors.New("the server no longer accepts a sign-in")
	}
	o := pub.Auth.OIDC
	entry := Entry{Kind: EntryBearer, Label: h.Name, URL: strings.TrimSuffix(h.URL, "/"), EnvironmentID: pub.Auth.EnvironmentID, ManageOnly: true,
		OIDC: &EntryOIDC{Issuer: o.Issuer, Audience: o.Audience, Scope: o.Scope, ClientID: o.ClientID}}
	if err := m.Catalog.PutRefreshToken(entry.CredentialKey(), old.RefreshToken); err != nil {
		return Entry{}, err
	}
	if err := m.Catalog.Upsert(entry); err != nil {
		return Entry{}, err
	}
	m.say("%s: added to Studio as a manage-only server, with the fleet's sign-in", h.Name)
	return entry, nil
}

// revokeLegacy removes the fleet's old pairing from the host and then from
// this machine. The host is told first: a pairing forgotten only here would
// stay on the host as a device nobody uses.
func (m Migration) revokeLegacy(ctx context.Context, h Host, entry Entry) error {
	if m.Legacy == nil {
		return nil
	}
	if _, ok, err := m.Legacy.GetSignIn(h.Name); err == nil && ok {
		if err := m.Legacy.DeleteSignIn(h.Name); err != nil {
			return err
		}
	}
	old, ok, err := m.Legacy.Get(h.Name)
	if err != nil {
		return err
	}
	if !ok {
		return nil
	}
	reach := h
	reach.Entry = &entry
	link, err := m.Studio.OpenWith(ctx, reach, StoredPairing{Pairing: old})
	if err != nil {
		var refused *studioclient.ActionError
		if errors.Is(err, studioclient.ErrUnknownClient) || strings.Contains(err.Error(), "unauthorized") || errors.As(err, &refused) {
			// The host no longer knows the pairing: there is nothing to revoke.
			m.say("%s: the host had already dropped the old fleet pairing", h.Name)
			return m.Legacy.Delete(h.Name)
		}
		return fmt.Errorf("could not reach the host to revoke the old fleet pairing: %w", err)
	}
	defer link.Close()
	if _, err := link.Action(ctx, "auth.forgetSelf"); err != nil {
		return fmt.Errorf("the host did not revoke the old fleet pairing: %w", err)
	}
	m.say("%s: revoked the old fleet pairing on the host", h.Name)
	return m.Legacy.Delete(h.Name)
}
