package main

// cmd_fleet_dashboard.go — `ion fleet` with no command: the dashboard
// (engine/internal/fleettui) wired to the real fleet.

import (
	"context"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"

	tea "charm.land/bubbletea/v2"

	"github.com/dsswift/ion/engine/internal/fleet"
	"github.com/dsswift/ion/engine/internal/fleettui"
	"github.com/dsswift/ion/engine/internal/utils"
)

func runFleetDashboard(flags map[string]string) {
	cfg, err := loadFleet()
	if err != nil {
		fmt.Fprintf(os.Stderr, "ion fleet: %s\n", err)
		os.Exit(1)
	}
	if len(cfg.Hosts) == 0 {
		fmt.Print("The fleet has no hosts yet. Add one:\n\n  ion fleet add NAME SSH --kind server|desktop\n\n" + fleetUsage)
		return
	}
	defaultSource, devCheckout := dashboardDefaultSource(flagValue(flags, "source"), cfg)
	var program *tea.Program
	send := func(msg tea.Msg) { program.Send(msg) }
	deployer := newDeployer(cfg, nil)
	deployer.Exec = fleettui.TerminalExec(send)
	collector := fleetCollector()
	model := fleettui.New(fleettui.Deps{
		Config:  cfg,
		Read:    collector.One,
		Latest:  fleet.LatestReleases,
		Prepare: func(ctx context.Context, hosts []fleet.Host, source string, known []fleet.HostStatus) (*fleet.Prepared, error) {
			kind, checkout, err := fleet.ResolveSource(source, cfg)
			if err != nil {
				return nil, err
			}
			// The dashboard hands a sudo prompt the terminal (fleettui.TerminalExec).
			return deployer.Prepare(ctx, fleet.Request{Hosts: hosts, Source: kind, Checkout: checkout, Install: fleet.InstallOptions{QuitIon: true}, Terminal: true, Known: known})
		},
		Run: func(ctx context.Context, p *fleet.Prepared, progress func(fleet.Event)) ([]fleet.Result, error) {
			deployer.Progress = progress
			return deployer.Run(ctx, p)
		},
		Restart: func(ctx context.Context, h fleet.Host) error { return fleet.Restart(ctx, fleet.ExecRunner{}, h) },
		SetRelay: func(ctx context.Context, h fleet.Host, p fleet.Profile) error {
			return fleet.SetRelay(ctx, fleet.ExecRunner{}, h, p)
		},
		Send:          send,
		Checkout:      checkoutVersions(devCheckout),
		DefaultSource: defaultSource,
	})
	program = tea.NewProgram(model)
	utils.LogWithFields(utils.LevelInfo, "fleet", "dashboard opened", map[string]any{"host_count": len(cfg.Hosts)})
	if _, err := program.Run(); err != nil {
		fmt.Fprintf(os.Stderr, "ion fleet: %s\n", err)
		os.Exit(1)
	}
}

// dashboardDefaultSource pre-fills the dashboard's deploy source: --source
// when given, else dev when the fleet file names a checkout, else the folder
// the dashboard was opened in when it is a checkout. Empty makes the deploy
// screen ask. It also returns the checkout a dev deploy would build, for the
// host detail's checkout versions.
func dashboardDefaultSource(flag string, cfg fleet.Config) (string, string) {
	if flag != "" {
		if kind, checkout, err := fleet.ResolveSource(flag, cfg); err == nil && kind == fleet.SourceDev {
			return flag, checkout
		}
		return flag, cfg.Checkout
	}
	if cfg.Checkout != "" {
		return fleet.SourceDev, cfg.Checkout
	}
	if wd, err := os.Getwd(); err == nil && fleet.IsCheckout(wd) == nil {
		return wd, wd
	}
	return "", ""
}

// checkoutVersions reads the versions a dev deploy of the checkout installs.
func checkoutVersions(checkout string) fleettui.CheckoutVersions {
	var v fleettui.CheckoutVersions
	if checkout == "" {
		return v
	}
	if data, err := os.ReadFile(filepath.Join(checkout, "server", "VERSION")); err == nil {
		v.Server = strings.TrimSpace(string(data))
	}
	// The desktop build names its own version from the release manifest and
	// the commit; ask the same script rather than guess.
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, "node", "desktop/scripts/desktop-version.js")
	cmd.Dir = checkout
	if out, err := cmd.Output(); err == nil {
		v.Desktop = strings.TrimSpace(string(out))
	} else {
		utils.LogWithFields(utils.LevelWarn, "fleet", "checkout desktop version unreadable", map[string]any{"checkout": checkout, "error": err.Error()})
	}
	return v
}
