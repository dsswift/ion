package main

// cmd_fleet_deploy.go — `ion fleet deploy`: show the plan and what it changes
// across the fleet, then build once per platform and deploy (--dry-run stops
// after the plan).

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"text/tabwriter"

	"github.com/dsswift/ion/engine/internal/fleet"
	"github.com/dsswift/ion/engine/internal/utils"
)

const fleetDeployUsage = `Usage: ion fleet deploy HOST... --source dev|release|PATH [--component server|desktop] [options]
       ion fleet deploy --to [user@]HOST --kind desktop|server [--source dev|release|PATH] [options]

Redeploys the hosts. The component defaults to each host's kind: a server host
gets the Studio Server bundle, a desktop host the Ion desktop app. The plan and
what it changes between hosts (transfer, Studio wire, stored data) print first,
then the deploy runs. A fleet deploy quits a running desktop.

--to deploys one host that need not be in the fleet file, the way
` + "`make deploy-studio-desktop`" + ` and ` + "`make deploy-studio-server`" + ` do. Its steps
print as they run, and its last line is a JSON receipt. A running desktop
stops it unless --quit-ion is given.

  --source dev       Build the fleet file's checkout once per platform, then deploy it
  --source PATH      Build and ship the Ion checkout at PATH instead: "." is this folder,
                     so a bench or any worktree deploys what it holds, with no fixed branch
  --source release   Install the newest published release
  --pkg PATH         Install this desktop package (.pkg) or Windows installer (.exe)
  --no-build         Install the newest build already in the checkout
  --dry-run          Print the plan and what it changes, and deploy nothing
  --allow-downgrade  Go ahead even though a host's stored data would move to an older format
` + fleet.InstallArgsUsage + `
Hosts deploy in parallel (the fleet file's concurrency, 4 by default). Hosts marked
askSudo deploy last, one at a time, on this terminal. Each host's log is under
~/.ion/fleet/logs.
`

// newDeployer is the deployer the CLI and the dashboard share.
func newDeployer(cfg fleet.Config, progress func(fleet.Event)) *fleet.Deployer {
	return &fleet.Deployer{
		Config:    cfg,
		Runner:    fleet.ExecRunner{},
		Collector: fleetCollector(),
		Artifacts: fleet.Artifacts{CacheDir: filepath.Join(fleet.StateDir(), "cache")},
		LogDir:    filepath.Join(fleet.StateDir(), "logs"),
		Progress:  progress,
	}
}

func fleetDeployCommand(names []string, flags map[string]string) error {
	adHoc := flagValue(flags, "to") != ""
	if flags["help"] == "true" || (len(names) == 0 && !adHoc) {
		fmt.Print(fleetDeployUsage)
		if len(names) == 0 && flags["help"] != "true" {
			return errors.New("name the hosts to deploy, or one with --to")
		}
		return nil
	}
	install, rest, err := fleet.ParseInstallArgs(deployArgs(), fleet.InstallOptions{QuitIon: !adHoc})
	if err != nil {
		return err
	}
	utils.LogWithFields(utils.LevelDebug, "fleet", "deploy arguments", map[string]any{"not_install_flags": rest})
	if install.Relay != "" && !install.RelayOIDC && install.RelayKey == "" {
		install.RelayKey = os.Getenv("ION_RELAY_KEY")
	}
	cfg, err := loadFleet()
	if err != nil {
		return err
	}
	var hosts []fleet.Host
	if adHoc {
		if len(names) > 0 {
			return errors.New("--to deploys one host; name no others")
		}
		var host fleet.Host
		if cfg, host, err = adHocHost(cfg, flagValue(flags, "to"), flagValue(flags, "kind"), install.AskSudo); err != nil {
			return err
		}
		hosts = []fleet.Host{host}
		install.SudoHint = "pass --ask-sudo from a terminal to be asked for the password instead"
	} else if hosts, err = cfg.Select(names); err != nil {
		return err
	}
	source, checkout := fleet.SourceDev, ""
	if s := flagValue(flags, "source"); s != "" || flagValue(flags, "pkg") == "" {
		if source, checkout, err = fleet.ResolveSource(s, cfg); err != nil {
			return err
		}
	}
	req := fleet.Request{
		Hosts: hosts, Source: source, Checkout: checkout, Component: flagValue(flags, "component"),
		AllowDowngrade: flags["allow-downgrade"] == "true", Install: install,
		Artifact: absPath(flagValue(flags, "pkg")), NoBuild: flags["no-build"] == "true", Terminal: stdinIsTerminal(),
	}
	ctx := context.Background()
	d := newDeployer(cfg, func(e fleet.Event) {
		if e.Detail != "" {
			fmt.Printf("%s: %s: %s\n", e.Host, e.Stage, e.Detail)
		} else {
			fmt.Printf("%s: %s\n", e.Host, e.Stage)
		}
	})
	if adHoc {
		d.Echo = os.Stderr
	}
	fmt.Println("reading the fleet and the new build's formats…")
	prepared, err := d.Prepare(ctx, req)
	if err != nil {
		return err
	}
	fmt.Println()
	for _, line := range prepared.PlanLines() {
		fmt.Println(line)
	}
	if prepared.Preflight.Blocks() && !req.AllowDowngrade {
		return errors.New("a host's stored data would move to an older format; rerun with --allow-downgrade to go ahead")
	}
	if flags["dry-run"] == "true" {
		fmt.Println("\nDry run: nothing was deployed.")
		return nil
	}
	fmt.Println()
	results, err := d.Run(ctx, prepared)
	if err != nil {
		return err
	}
	if adHoc {
		return printReceipt(results[0])
	}
	return printDeployResults(results)
}

// deployArgs are the arguments after `ion fleet deploy`.
func deployArgs() []string {
	for i, a := range os.Args {
		if a == "deploy" && i > 0 && os.Args[i-1] == "fleet" {
			return os.Args[i+1:]
		}
	}
	return nil
}

// adHocHost is the --to host: the fleet file's entry for that ssh target
// when it has one, else a host of the given kind added to the fleet for this
// deploy only, so the plan compares it with the rest.
func adHocHost(cfg fleet.Config, target, kind string, askSudo bool) (fleet.Config, fleet.Host, error) {
	for _, h := range cfg.Hosts {
		if h.SSH == target {
			if kind != "" && kind != h.Kind {
				return cfg, h, fmt.Errorf("%s is a %s host in the fleet file", target, h.Kind)
			}
			h.AskSudo = h.AskSudo || askSudo
			return cfg, h, nil
		}
	}
	if kind != fleet.KindDesktop && kind != fleet.KindServer {
		return cfg, fleet.Host{}, errors.New("--to needs --kind desktop or --kind server")
	}
	h := fleet.Host{Name: target, SSH: target, Kind: kind, AskSudo: askSudo}
	cfg.Hosts = append(append([]fleet.Host{}, cfg.Hosts...), h)
	return cfg, h, nil
}

func absPath(p string) string {
	if p == "" {
		return ""
	}
	if abs, err := filepath.Abs(p); err == nil {
		return abs
	}
	return p
}

// printReceipt ends a --to deploy with its JSON receipt, the line a script
// reads.
func printReceipt(r fleet.Result) error {
	rec := r.Receipt
	if rec == nil {
		rec = &fleet.Receipt{Host: r.Host}
	}
	data, err := json.Marshal(rec)
	if err != nil {
		return err
	}
	fmt.Println(string(data))
	if !r.OK {
		return fmt.Errorf("%s (log: %s)", r.Error, r.LogPath)
	}
	return nil
}

func flagValue(flags map[string]string, key string) string {
	if v := flags[key]; v != "true" {
		return v
	}
	return ""
}

func printDeployResults(results []fleet.Result) error {
	fmt.Println()
	tw := tabwriter.NewWriter(os.Stdout, 0, 0, 2, ' ', 0)
	fmt.Fprintln(tw, "HOST\tRESULT\tNOW\tLOG") //nolint:errcheck // tabwriter buffers; Flush reports
	var failed []string
	for _, r := range results {
		outcome := "deployed"
		if !r.OK {
			outcome = "FAILED: " + r.Error
			failed = append(failed, r.Host)
		}
		now := "-"
		if r.After != nil && r.After.Report != nil {
			now = fleet.ServerCell(r.After.Report)
			if r.After.Report.Components.Desktop != nil {
				now = "desktop " + r.After.Report.Components.Desktop.Version
			}
		}
		fmt.Fprintf(tw, "%s\t%s\t%s\t%s\n", r.Host, outcome, now, r.LogPath) //nolint:errcheck // tabwriter buffers; Flush reports
	}
	tw.Flush() //nolint:errcheck // stdout
	if len(failed) > 0 {
		return fmt.Errorf("deploy failed on %s", strings.Join(failed, ", "))
	}
	return nil
}
