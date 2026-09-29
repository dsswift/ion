package main

// cmd_fleet.go — `ion fleet`: many Studio hosts from this Mac. The work lives
// in engine/internal/fleet; this file parses the verbs and prints.

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

Manage many Ion Studio hosts from this machine. Hosts live in ~/.ion/fleet.json.
With no command, opens the fleet dashboard; ion fleet --source PATH makes its dev deploys
build the checkout at PATH ("." for this folder).

Commands:
  status [HOST...]            Every host's installs, engine, load, running conversations, relays,
                              and transfer format (--json for everything, including all formats)
  compat [--format ID]        Which hosts can work with which, per format: transfer first
                              (--json)
  add NAME --url URL [--no-pair]
                              Add a server deployed outside the fleet (a cluster deployment). The
                              fleet only reads it: its versions and formats without a sign-in, and
                              its load, running conversations, and devices once you sign in to it
                              with a device code (skipped with --no-pair; later: ion fleet pair NAME)
  add NAME SSH --kind server|desktop [--profile P] [--ask-sudo] [--no-pair]
                              Add a host (SSH is [user@]host, or "local" for this Mac) and pair
                              with it read-only, so its status reads through the relay when SSH
                              cannot reach it
  remove NAME                 Forget a host and its pairing
  pair NAME                   Pair again (after the host was reinstalled or the pairing revoked), or
                              sign in again to a host with a url
  restart HOST...             Restart Ion on the hosts (a desktop's running conversations stop)
  relay set HOST...           Put the hosts on their profile's relay
  deploy HOST... --source dev|release|PATH [--component server|desktop] [--dry-run] [--allow-downgrade]
                              Redeploy the hosts, after a plan of what changes between them
                              (ion fleet deploy --help)
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
	case "compat":
		err = fleetCompat(flags["format"], flags["json"] == "true")
	case "add":
		err = fleetAdd(rest, flags)
	case "remove":
		err = fleetRemove(rest)
	case "pair":
		err = fleetPair(rest)
	case "restart":
		err = fleetEach(rest, flags, "restart", func(ctx context.Context, c fleet.Config, h fleet.Host) error {
			return fleet.Restart(ctx, fleet.ExecRunner{}, h)
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

func fleetCollector() fleet.Collector {
	store := fleet.OpenPairings(fleet.StateDir())
	return fleet.Collector{Runner: fleet.ExecRunner{}, Pairings: store, SignIns: store, Tokens: fleetEngineTokens()}
}

func loadFleet() (fleet.Config, error) {
	return fleet.Load(fleet.DefaultPath())
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
	if len(hosts) == 0 {
		return errors.New("the fleet has no hosts; add one with `ion fleet add NAME SSH --kind server|desktop`")
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
	url := flagValue(flags, "url")
	if (url == "" && len(rest) != 2) || (url != "" && len(rest) != 1) {
		return errors.New("usage: ion fleet add NAME SSH --kind server|desktop [--profile P] [--ask-sudo] [--no-pair]\n       ion fleet add NAME --url URL [--no-pair]")
	}
	cfg, err := loadFleet()
	if err != nil {
		return err
	}
	if _, exists := cfg.Host(rest[0]); exists {
		return fmt.Errorf("host %q is already in the fleet", rest[0])
	}
	if url != "" {
		return addExternal(cfg, fleet.Host{Name: rest[0], URL: strings.TrimSuffix(url, "/"), Kind: fleet.KindServer}, flags["no-pair"] == "true")
	}
	h := fleet.Host{Name: rest[0], SSH: rest[1], Kind: flags["kind"], AskSudo: flags["ask-sudo"] == "true"}
	if p := flags["profile"]; p != "" && p != "true" {
		h.Profile = p
	}
	cfg.Hosts = append(cfg.Hosts, h)
	if err := fleet.Save(fleet.DefaultPath(), cfg); err != nil {
		return err
	}
	fmt.Printf("added %s (%s, %s)\n", h.Name, h.SSH, h.Kind)
	if flags["no-pair"] == "true" {
		return nil
	}
	if err := pairHost(h); err != nil {
		return fmt.Errorf("%w (the host is added; pair later with `ion fleet pair %s`)", err, h.Name)
	}
	return nil
}

// addExternal adds a server deployed outside the fleet, after reading it
// once so a wrong address is caught now, and signs in unless told not to.
func addExternal(cfg fleet.Config, h fleet.Host, noSignIn bool) error {
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	pub, err := studioclient.ReadPublic(ctx, h.URL)
	if err != nil {
		return fmt.Errorf("%s does not answer as an Ion server: %w", h.URL, err)
	}
	cfg.Hosts = append(cfg.Hosts, h)
	if err := fleet.Save(fleet.DefaultPath(), cfg); err != nil {
		return err
	}
	fmt.Printf("added %s (%s, %q, server %s); the fleet only reads it\n", h.Name, h.URL, pub.Auth.Label, orDash(pub.Versionz.ServerVersion))
	if noSignIn {
		return nil
	}
	if err := pairHost(h); err != nil {
		return fmt.Errorf("%w (the host is added and its public status reads; sign in later with `ion fleet pair %s`)", err, h.Name)
	}
	return nil
}

func pairHost(h fleet.Host) error {
	if h.External() {
		ctx, cancel := context.WithTimeout(context.Background(), 16*time.Minute)
		defer cancel()
		err := fleet.SignInExternal(ctx, h, fleet.OpenPairings(fleet.StateDir()), func(msg string) { fmt.Println(msg) })
		if err == nil {
			fmt.Printf("signed in to %s; the fleet reads its load, running conversations, and devices\n", h.Name)
		}
		return err
	}
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
	defer cancel()
	pairer := fleet.Pairer{Runner: fleet.ExecRunner{}, Pairings: fleet.OpenPairings(fleet.StateDir()), Tokens: fleetEngineTokens()}
	p, err := pairer.Pair(ctx, h)
	if err != nil {
		return err
	}
	relays := make([]string, 0, len(p.Relays))
	for _, r := range p.Relays {
		relays = append(relays, r.URL)
	}
	fmt.Printf("paired with %s (read-only); relays: %s\n", h.Name, orDash(strings.Join(relays, ", ")))
	return nil
}

func fleetPair(rest []string) error {
	if len(rest) != 1 {
		return errors.New("usage: ion fleet pair NAME")
	}
	cfg, err := loadFleet()
	if err != nil {
		return err
	}
	h, ok := cfg.Host(rest[0])
	if !ok {
		return fmt.Errorf("no host named %q", rest[0])
	}
	return pairHost(h)
}

func fleetRemove(rest []string) error {
	if len(rest) != 1 {
		return errors.New("usage: ion fleet remove NAME")
	}
	cfg, err := loadFleet()
	if err != nil {
		return err
	}
	var kept []fleet.Host
	for _, h := range cfg.Hosts {
		if h.Name != rest[0] {
			kept = append(kept, h)
		}
	}
	if len(kept) == len(cfg.Hosts) {
		return fmt.Errorf("no host named %q", rest[0])
	}
	cfg.Hosts = kept
	if err := fleet.Save(fleet.DefaultPath(), cfg); err != nil {
		return err
	}
	store := fleet.OpenPairings(fleet.StateDir())
	if err := store.Delete(rest[0]); err != nil {
		utils.LogWithFields(utils.LevelInfo, "fleet", "no pairing to forget", map[string]any{"fleet_host": rest[0], "error": err.Error()})
	}
	if err := store.DeleteSignIn(rest[0]); err != nil {
		utils.LogWithFields(utils.LevelInfo, "fleet", "no sign-in to forget", map[string]any{"fleet_host": rest[0], "error": err.Error()})
	}
	fmt.Printf("removed %s\n", rest[0])
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
	var failed []string
	for _, h := range hosts {
		ctx, cancel := context.WithTimeout(context.Background(), 3*time.Minute)
		err := op(ctx, cfg, h)
		cancel()
		if err != nil {
			fmt.Printf("%s: %s failed: %s\n", h.Name, what, err)
			failed = append(failed, h.Name)
			continue
		}
		fmt.Printf("%s: %s done\n", h.Name, what)
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
