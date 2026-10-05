package main

// cmd_fleet.go — `ion fleet`: every server this device is paired with, from
// one place. The work lives in engine/internal/fleet; this file parses the
// verbs and prints.

import (
	"context"
	"errors"
	"fmt"
	"os"
	"strings"
	"text/tabwriter"
	"time"

	"github.com/dsswift/ion/engine/internal/fleet"
	"github.com/dsswift/ion/engine/internal/studioclient"
	"github.com/dsswift/ion/engine/internal/studiostatus"
	"github.com/dsswift/ion/engine/internal/utils"
)

const fleetUsage = `Usage: ion fleet [command] [options]

Manage every Ion Studio server this machine is paired with. The fleet is the
server list Ion Studio keeps: a server paired in Studio is in the fleet, and one
added here shows up in Studio, with one pairing on the server either way.
~/.ion/fleet.json holds only how deploys run (checkout, concurrency, profiles).
With no command, opens the fleet dashboard; ion fleet --source PATH makes its dev
deploys build the checkout at PATH ("." for this folder).

Commands:
  status [HOST...]            Every host's installs, engine, load, running conversations, relays,
                              and transfer format, then every provider account across the fleet
                              with its usage limits (--json for everything)
  accounts                    The provider accounts across the fleet: usage limits, and the hosts
                              each is signed in on now or was seen on in the last 30 days (--json)
  compat [--format ID]        Which hosts can work with which, per format: transfer first
                              (--json)
  add NAME SSH [--kind server|desktop] [--profile P] [--ask-sudo] [--conversations]
                              Pair this machine with a host over SSH (SSH is [user@]host) and add
                              it to the fleet and to Studio. It is added manage-only: in the
                              fleet, but not offered for conversations (--conversations offers it)
  add NAME --url URL          Add a server reached at its own address (a cluster deployment) and
                              sign in to it with a device code
  set NAME [--ssh TARGET] [--kind server|desktop] [--profile P] [--ask-sudo|--no-ask-sudo]
           [--build-dir DIR] [--manage-only|--conversations]
                              Change how a host is deployed to, or whether Studio offers it for
                              conversations
  remove NAME                 Revoke this machine's pairing on the host and forget the host,
                              here and in Studio
  pair NAME                   Pair again (after the host was reinstalled or the pairing revoked), or
                              sign in again to a host reached at its own address
  restart HOST...             Restart Ion on the hosts (a desktop's running conversations stop).
                              The host restarts itself when it answers; --over-ssh does it over SSH
                              (--json)
  relay set HOST...           Put the hosts on their profile's relay (--json)
  deploy HOST... --source dev|release|PATH [--component server|desktop] [--dry-run] [--allow-downgrade]
                              Redeploy the hosts, after a plan of what changes between them
                              (ion fleet deploy --help)
  builder HOST [--install-tools] [--exclude-build-dir] [--source dev|PATH]
                              Make a host able to build: install the build tools it lacks, and
                              exclude its build folder from Microsoft Defender
  checkout [PATH]             Show, or set, the Ion checkout --source dev builds ("." for this
                              folder). A bench or any worktree works
  migrate                     Move hosts an earlier fleet file listed into Studio's server list
                              (runs by itself before any command while there are any)
`

func cmdFleet(positional []string, flags map[string]string) {
	if len(positional) == 0 {
		runFleetDashboard(flags)
		return
	}
	sub, rest := positional[0], positional[1:]
	utils.LogWithFields(utils.LevelInfo, "fleet", "fleet command", map[string]any{"subcommand": sub, "args": rest})
	var err error
	switch sub {
	case "status":
		err = fleetStatus(rest, flags["json"] == "true")
	case "accounts":
		err = fleetAccounts(flags["json"] == "true")
	case "set":
		err = fleetSet(rest, flags)
	case "migrate":
		err = fleetMigrate()
	case "compat":
		err = fleetCompat(flags["format"], flags["json"] == "true")
	case "add":
		err = fleetAdd(rest, flags)
	case "remove":
		err = fleetRemove(rest)
	case "pair":
		err = fleetPair(rest)
	case "restart":
		ops := fleetOps(flags["over-ssh"] == "true")
		err = fleetEach(rest, flags, "restart", func(ctx context.Context, c fleet.Config, h fleet.Host) error {
			return ops.Restart(ctx, h)
		})
	case "relay":
		if len(rest) == 0 || rest[0] != "set" {
			err = errors.New("usage: ion fleet relay set HOST [HOST ...]")
			break
		}
		err = fleetEach(rest[1:], flags, "relay set", func(ctx context.Context, c fleet.Config, h fleet.Host) error {
			return fleet.SetRelay(ctx, fleet.ExecRunner{}, h, c.ProfileOf(h))
		})
	case "deploy":
		err = fleetDeployCommand(rest, flags)
	case "builder":
		err = fleetBuilderCommand(rest, flags)
	case "checkout":
		err = fleetCheckout(rest, os.Stdout)
	case "help":
		fmt.Print(fleetUsage)
	default:
		fmt.Fprintf(os.Stderr, "Unknown fleet command: %s\n\n%s", sub, fleetUsage)
		os.Exit(1)
	}
	if err != nil {
		utils.LogWithFields(utils.LevelError, "fleet", "fleet command failed", map[string]any{"subcommand": sub, "error": err.Error()})
		fmt.Fprintf(os.Stderr, "ion fleet %s: %s\n", sub, err)
		os.Exit(1)
	}
}

// fleetEngineTokens reaches this Mac's engine for relay OIDC tokens; nil when
// no engine address can be named.
func fleetEngineTokens() studioclient.TokenSource {
	sock, err := resolveSocketPath()
	if err != nil {
		return nil
	}
	return fleet.EngineTokens{Network: dialNetwork(sock), Socket: sock}
}

// fleetStudio opens Studio connections with the device's own pairings.
func fleetStudio() fleet.Studio {
	return fleet.Studio{Catalog: fleet.OpenCatalog(), Tokens: fleetEngineTokens()}
}

func fleetCollector() fleet.Collector {
	return fleet.Collector{Runner: fleet.ExecRunner{}, Studio: fleetStudio()}
}

func fleetOps(forceSSH bool) fleet.Ops {
	return fleet.Ops{Runner: fleet.ExecRunner{}, Open: fleetStudio().Opener(), ForceSSH: forceSSH}
}

func fleetPairer() fleet.Pairer {
	return fleet.Pairer{Runner: fleet.ExecRunner{}, Catalog: fleet.OpenCatalog(), Tokens: fleetEngineTokens()}
}

// loadFleet reads the fleet file and the Environment catalog. Hosts an
// earlier fleet file listed itself are moved into the catalog first.
func loadFleet() (fleet.Config, error) {
	cfg, err := fleet.Load(fleet.DefaultPath())
	if err != nil {
		return cfg, err
	}
	if len(cfg.LegacyHosts) > 0 {
		runFleetMigration(&cfg, os.Stderr)
	}
	return cfg, cfg.UseCatalog(fleet.OpenCatalog())
}

// runFleetMigration moves the fleet file's own hosts into the catalog and
// says, on out, what it did and what is left.
func runFleetMigration(cfg *fleet.Config, out *os.File) map[string]error {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Minute)
	defer cancel()
	fmt.Fprintln(out, "moving the fleet file's hosts into Studio's server list…") //nolint:errcheck // progress line
	m := fleet.Migration{
		Path: fleet.DefaultPath(), Catalog: fleet.OpenCatalog(), Legacy: fleet.OpenPairings(fleet.StateDir()),
		Pairer: fleetPairer(), Studio: fleetStudio(),
		Say: func(line string) { fmt.Fprintln(out, "  "+line) }, //nolint:errcheck // progress line
	}
	pending := m.Run(ctx, cfg)
	for name, err := range pending {
		fmt.Fprintf(out, "  %s: not moved yet: %s\n", name, err) //nolint:errcheck // progress line
	}
	return pending
}

func fleetMigrate() error {
	cfg, err := fleet.Load(fleet.DefaultPath())
	if err != nil {
		return err
	}
	if len(cfg.LegacyHosts) == 0 {
		fmt.Println("nothing to move: the fleet file lists no hosts of its own")
		return nil
	}
	if pending := runFleetMigration(&cfg, os.Stdout); len(pending) > 0 {
		return fmt.Errorf("%d host(s) are not moved yet; run `ion fleet migrate` again once they answer", len(pending))
	}
	fmt.Println("done: every host is in Studio's server list")
	return nil
}

func fleetStatus(names []string, asJSON bool) error {
	cfg, err := loadFleet()
	if err != nil {
		return err
	}
	hosts, err := cfg.Select(names)
	if err != nil {
		return err
	}
	ctx := context.Background()
	statuses := fleetCollector().Collect(ctx, hosts)
	latest, latestErr := fleet.LatestReleases(ctx)
	if asJSON {
		out := map[string]any{"hosts": statuses, "latest": latest}
		if latestErr != nil {
			out["latestError"] = latestErr.Error()
		}
		fmt.Println(string(mustMarshalCLI(out)))
		return nil
	}
	printFleetStatus(statuses, latest)
	return nil
}

func printFleetStatus(statuses []fleet.HostStatus, latest fleet.Latest) {
	drift := fleet.Drift(statuses, fleet.TransferFormat)
	tw := tabwriter.NewWriter(os.Stdout, 0, 0, 2, ' ', 0)
	fmt.Fprintln(tw, "HOST\tREACH\tKIND\tDESKTOP\tSERVER\tENGINE\tTRANSFER\tCPU\tMEMORY\tRUNNING\tDEVICES\tRELAYS") //nolint:errcheck // tabwriter buffers; Flush reports
	for _, st := range statuses {
		r := st.Report
		transfer := fleet.FormatCell(r, fleet.TransferFormat)
		if drift[st.Host.Name] {
			transfer += " (differs)"
		}
		fmt.Fprintf(tw, "%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\n", st.Host.Name, st.Via, fleet.KindCell(st), //nolint:errcheck // tabwriter buffers; Flush reports
			fleet.DesktopCell(r), fleet.ServerCell(r), fleet.EngineCell(r), transfer, fleet.CPUCell(metricsOf(r)), fleet.MemCell(metricsOf(r)), fleet.RunningCell(r), fleet.DevicesCell(r), fleet.RelaysCell(r))
	}
	tw.Flush() //nolint:errcheck // stdout
	if latest.Server != "" || latest.Desktop != "" {
		fmt.Printf("\nlatest release: server %s, desktop %s\n", orDash(latest.Server), orDash(latest.Desktop))
	}
	for _, st := range statuses {
		if st.Error != "" {
			fmt.Printf("%s: unreachable: %s\n", st.Host.Name, st.Error)
		}
		for _, flag := range fleet.HostFlags(st) {
			fmt.Printf("%s: %s\n", st.Host.Name, flag)
		}
		if st.Report != nil && st.Report.Devices != nil {
			fmt.Printf("%s: devices: %s\n", st.Host.Name, studiostatus.DeviceSummary(st.Report.Devices))
		}
	}
	if accounts := fleet.Accounts(statuses); len(accounts) > 0 {
		fmt.Println()
		printFleetAccounts(accounts)
	}
}

func fleetAccounts(asJSON bool) error {
	cfg, err := loadFleet()
	if err != nil {
		return err
	}
	accounts := fleet.Accounts(fleetCollector().Collect(context.Background(), cfg.Hosts))
	if asJSON {
		fmt.Println(string(mustMarshalCLI(map[string]any{"accounts": accounts})))
		return nil
	}
	if len(accounts) == 0 {
		fmt.Println("No host reports a provider account yet. A host reports one once its Claude Code or Codex CLI is signed in.")
		return nil
	}
	printFleetAccounts(accounts)
	return nil
}

// printFleetAccounts prints one row per account: its limits, and the hosts
// it is signed in on now (plain) or was seen on in the last 30 days (in
// parentheses).
func printFleetAccounts(accounts []studiostatus.FleetAccount) {
	now := time.Now()
	tw := tabwriter.NewWriter(os.Stdout, 0, 0, 2, ' ', 0)
	fmt.Fprintln(tw, "ACCOUNT\tPLAN\t7-DAY MODEL\t5-HOUR\t7-DAY\tHOSTS") //nolint:errcheck // tabwriter buffers; Flush reports
	for _, a := range accounts {
		hosts := make([]string, 0, len(a.Machines))
		for _, m := range a.Machines {
			if m.SignedIn {
				hosts = append(hosts, m.Host)
			} else {
				hosts = append(hosts, "("+m.Host+")")
			}
		}
		plan := a.Label
		if !a.SignedIn {
			plan += " · last seen " + fleet.AgoCell(a.LastSeen, now)
		}
		fmt.Fprintf(tw, "%s\t%s\t%s\t%s\t%s\t%s\n", a.Name(), orDash(plan), //nolint:errcheck // tabwriter buffers; Flush reports
			fleet.LimitCell(a.Account, "weekly_model", now), fleet.LimitCell(a.Account, "session", now), fleet.LimitCell(a.Account, "weekly", now), strings.Join(hosts, ", "))
	}
	tw.Flush() //nolint:errcheck // stdout
}

func fleetCompat(format string, asJSON bool) error {
	cfg, err := loadFleet()
	if err != nil {
		return err
	}
	statuses := fleetCollector().Collect(context.Background(), cfg.Hosts)
	refs := fleet.Comparable(statuses)
	if format != "" && format != "true" {
		var pick []fleet.FormatRef
		for _, r := range refs {
			if r.ID == format || r.String() == format {
				pick = append(pick, r)
			}
		}
		if len(pick) == 0 {
			return fmt.Errorf("no host reports a comparable format named %q", format)
		}
		refs = pick
	}
	var matrices []fleet.Matrix
	for _, r := range refs {
		matrices = append(matrices, fleet.BuildMatrix(statuses, r))
	}
	if asJSON {
		fmt.Println(string(mustMarshalCLI(matrices)))
		return nil
	}
	if len(matrices) == 0 {
		fmt.Println("No host reports its formats yet (their Ion predates format reporting); deploy to update them.")
	}
	for _, m := range matrices {
		printMatrix(m)
	}
	return nil
}

func printMatrix(m fleet.Matrix) {
	fmt.Printf("\n%s (%s): %s\n", m.Format, m.Rule, m.Meaning)
	fmt.Println("rows send to columns")
	tw := tabwriter.NewWriter(os.Stdout, 0, 0, 2, ' ', 0)
	fmt.Fprintln(tw, "\t"+strings.Join(m.Columns, "\t")) //nolint:errcheck // tabwriter buffers; Flush reports
	for i, row := range m.Cells {
		cells := make([]string, len(row))
		for j, c := range row {
			cells[j] = map[fleet.Verdict]string{fleet.VerdictOK: "can send", fleet.VerdictBlocked: "can't send", fleet.VerdictUnknown: "unknown"}[c.Verdict]
		}
		fmt.Fprintln(tw, m.Rows[i]+"\t"+strings.Join(cells, "\t")) //nolint:errcheck // tabwriter buffers; Flush reports
	}
	tw.Flush() //nolint:errcheck // stdout
	for _, row := range m.Cells {
		for _, c := range row {
			if c.Verdict == fleet.VerdictBlocked {
				fmt.Printf("  %s -> %s: %s\n", c.From, c.To, c.Reason)
			}
		}
	}
}

func fleetAdd(rest []string, flags map[string]string) error {
	base := strings.TrimSuffix(flagValue(flags, "url"), "/")
	if (base == "" && len(rest) != 2) || (base != "" && len(rest) != 1) {
		return errors.New("usage: ion fleet add NAME SSH [--kind server|desktop] [--profile P] [--ask-sudo] [--conversations]\n       ion fleet add NAME --url URL")
	}
	cfg, err := loadFleet()
	if err != nil {
		return err
	}
	name := rest[0]
	if _, exists := cfg.Host(name); exists {
		return fmt.Errorf("host %q is already in the fleet", name)
	}
	catalog := fleet.OpenCatalog()
	if base != "" {
		ctx, cancel := context.WithTimeout(context.Background(), 16*time.Minute)
		defer cancel()
		signed, err := fleet.SignIn(ctx, name, base, func(msg string) { fmt.Println(msg) })
		if err != nil {
			return err
		}
		signed.Entry.ManageOnly = flags["conversations"] != "true"
		if err := catalog.PutRefreshToken(signed.Entry.CredentialKey(), signed.RefreshToken); err != nil {
			return err
		}
		if err := catalog.Upsert(signed.Entry); err != nil {
			return err
		}
		fmt.Printf("added %s (%s) and signed in; it is in the fleet and in Studio\n", name, base)
		return nil
	}
	h := fleet.Host{Name: name, SSH: rest[1], Kind: flagValue(flags, "kind"), AskSudo: flags["ask-sudo"] == "true", Profile: flagValue(flags, "profile")}
	probe := fleet.Config{Hosts: []fleet.Host{h}, Profiles: cfg.Profiles}
	if err := probe.Validate(); err != nil {
		return err
	}
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
	defer cancel()
	paired, err := fleetPairer().Pair(ctx, h)
	if err != nil {
		return err
	}
	entry := paired.Entry(name, h)
	entry.ManageOnly = flags["conversations"] != "true"
	entry.Deploy = &fleet.DeploySettings{SSH: h.SSH, Kind: h.Kind, Profile: h.Profile, AskSudo: h.AskSudo}
	if err := catalog.PutPairing(entry.CredentialKey(), fleet.StoredPairing{Pairing: paired.Pairing}); err != nil {
		return err
	}
	if err := catalog.Upsert(entry); err != nil {
		return err
	}
	offered := "manage-only: Studio does not offer it for conversations"
	if !entry.ManageOnly {
		offered = "Studio offers it for conversations"
	}
	fmt.Printf("paired with %s (%s, reached by %s) and added it to the fleet and to Studio; %s\n", name, h.SSH, paired.Via, offered)
	return nil
}

// fleetHost is the named host of the fleet.
func fleetHost(name string) (fleet.Config, fleet.Host, error) {
	cfg, err := loadFleet()
	if err != nil {
		return cfg, fleet.Host{}, err
	}
	h, ok := cfg.Host(name)
	if !ok {
		return cfg, h, fmt.Errorf("no host named %q in the fleet (`ion fleet status` lists them)", name)
	}
	if h.Entry == nil {
		return cfg, h, fmt.Errorf("%s is this machine; it is always in the fleet", name)
	}
	return cfg, h, nil
}

func fleetSet(rest []string, flags map[string]string) error {
	if len(rest) != 1 {
		return errors.New("usage: ion fleet set NAME [--ssh TARGET] [--kind server|desktop] [--profile P] [--ask-sudo|--no-ask-sudo] [--build-dir DIR] [--manage-only|--conversations]")
	}
	cfg, h, err := fleetHost(rest[0])
	if err != nil {
		return err
	}
	if kind := flagValue(flags, "kind"); kind != "" && kind != fleet.KindServer && kind != fleet.KindDesktop {
		return fmt.Errorf("kind must be %q or %q", fleet.KindServer, fleet.KindDesktop)
	}
	if profile := flagValue(flags, "profile"); profile != "" {
		if _, ok := cfg.Profiles[profile]; !ok {
			return fmt.Errorf("the fleet file defines no profile %q", profile)
		}
	}
	found, err := fleet.OpenCatalog().Update(h, func(e *fleet.Entry) {
		d := fleet.DeploySettings{}
		if e.Deploy != nil {
			d = *e.Deploy
		}
		for flag, field := range map[string]*string{"ssh": &d.SSH, "kind": &d.Kind, "profile": &d.Profile, "build-dir": &d.BuildDir} {
			if v, given := flags[flag]; given && v != "true" {
				*field = v
			}
		}
		if flags["ask-sudo"] == "true" {
			d.AskSudo = true
		}
		if flags["no-ask-sudo"] == "true" {
			d.AskSudo = false
		}
		if d == (fleet.DeploySettings{}) {
			e.Deploy = nil
		} else {
			e.Deploy = &d
		}
		if flags["manage-only"] == "true" {
			e.ManageOnly = true
		}
		if flags["conversations"] == "true" {
			e.ManageOnly = false
		}
	})
	if err != nil {
		return err
	}
	if !found {
		return fmt.Errorf("%s is no longer in Studio's server list", h.Name)
	}
	fmt.Printf("updated %s\n", h.Name)
	return nil
}

func fleetPair(rest []string) error {
	if len(rest) != 1 {
		return errors.New("usage: ion fleet pair NAME")
	}
	_, h, err := fleetHost(rest[0])
	if err != nil {
		return err
	}
	catalog := fleet.OpenCatalog()
	if h.Entry.Kind == fleet.EntryBearer {
		ctx, cancel := context.WithTimeout(context.Background(), 16*time.Minute)
		defer cancel()
		signed, err := fleet.SignIn(ctx, h.Entry.Label, h.Entry.URL, func(msg string) { fmt.Println(msg) })
		if err != nil {
			return err
		}
		if err := catalog.PutRefreshToken(h.Entry.CredentialKey(), signed.RefreshToken); err != nil {
			return err
		}
		fmt.Printf("signed in to %s again\n", h.Name)
		return nil
	}
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
	defer cancel()
	paired, err := fleetPairer().Pair(ctx, h)
	if err != nil {
		return err
	}
	if err := catalog.PutPairing(h.Entry.CredentialKey(), fleet.StoredPairing{Pairing: paired.Pairing}); err != nil {
		return err
	}
	fmt.Printf("paired with %s again (reached by %s); Studio uses the same pairing\n", h.Name, paired.Via)
	return nil
}

func fleetRemove(rest []string) error {
	if len(rest) != 1 {
		return errors.New("usage: ion fleet remove NAME")
	}
	_, h, err := fleetHost(rest[0])
	if err != nil {
		return err
	}
	if h.Entry.Managed {
		return fmt.Errorf("%s is provided by this device's policy and cannot be removed", h.Name)
	}
	// The host is told first, while the pairing still opens a connection:
	// it revokes the pairing and closes every session on it.
	revoked := false
	if h.Entry.Kind == fleet.EntryPaired {
		ctx, cancel := context.WithTimeout(context.Background(), time.Minute)
		link, openErr := fleetStudio().Open(ctx, h)
		if openErr == nil {
			_, openErr = link.Action(ctx, "auth.forgetSelf")
			link.Close()
		}
		cancel()
		if openErr != nil {
			utils.LogWithFields(utils.LevelWarn, "fleet", "host did not revoke this device's pairing", map[string]any{"fleet_host": h.Name, "error": openErr.Error()})
			fmt.Printf("%s did not answer, so its record of this machine stays until it is revoked there (%s)\n", h.Name, openErr)
		} else {
			revoked = true
		}
	}
	catalog := fleet.OpenCatalog()
	if _, err := catalog.Remove(h); err != nil {
		return err
	}
	if err := catalog.DeleteSecret(h.Entry.CredentialKey()); err != nil {
		return err
	}
	utils.LogWithFields(utils.LevelInfo, "fleet", "host removed", map[string]any{"fleet_host": h.Name, "revoked_on_host": revoked})
	fmt.Printf("removed %s from the fleet and from Studio\n", h.Name)
	return nil
}

// fleetEach runs op on the named hosts, one after another.
func fleetEach(names []string, flags map[string]string, what string, op func(context.Context, fleet.Config, fleet.Host) error) error {
	cfg, err := loadFleet()
	if err != nil {
		return err
	}
	if len(names) == 0 {
		return fmt.Errorf("name the hosts to %s", what)
	}
	hosts, err := cfg.Select(names)
	if err != nil {
		return err
	}
	asJSON := flags["json"] == "true"
	type outcome struct {
		Host  string `json:"host"`
		Op    string `json:"op"`
		OK    bool   `json:"ok"`
		Error string `json:"error,omitempty"`
	}
	var failed []string
	for _, h := range hosts {
		ctx, cancel := context.WithTimeout(context.Background(), 12*time.Minute)
		err := op(ctx, cfg, h)
		cancel()
		if asJSON {
			o := outcome{Host: h.Name, Op: what, OK: err == nil}
			if err != nil {
				o.Error = err.Error()
			}
			fmt.Println(string(mustMarshalCLI(o)))
		}
		if err != nil {
			if !asJSON {
				fmt.Printf("%s: %s failed: %s\n", h.Name, what, err)
			}
			failed = append(failed, h.Name)
			continue
		}
		if !asJSON {
			fmt.Printf("%s: %s done\n", h.Name, what)
		}
	}
	if len(failed) > 0 {
		return fmt.Errorf("%s failed on %s", what, strings.Join(failed, ", "))
	}
	return nil
}

func metricsOf(r *studiostatus.Report) *studiostatus.HostMetrics {
	if r == nil {
		return nil
	}
	return r.Metrics
}
