package main

import (
	"errors"
	"fmt"
	"io"

	"github.com/dsswift/ion/engine/internal/fleet"
	"github.com/dsswift/ion/engine/internal/utils"
)

// fleetCheckout shows the checkout `--source dev` builds, or sets it to the
// one named. Only the fleet file's own fields are written: its hosts are the
// server list's, and a host still owed a move stays as it is.
func fleetCheckout(args []string, out io.Writer) error {
	return fleetCheckoutAt(fleet.DefaultPath(), args, out)
}

func fleetCheckoutAt(path string, args []string, out io.Writer) error {
	cfg, err := fleet.Load(path)
	if err != nil {
		return err
	}
	if len(args) == 0 {
		if cfg.Checkout == "" {
			fmt.Fprintln(out, "no checkout is set; `ion fleet checkout PATH` sets the one --source dev builds") //nolint:errcheck // answer line
			return nil
		}
		fmt.Fprintln(out, cfg.Checkout) //nolint:errcheck // answer line
		return nil
	}
	if len(args) > 1 {
		return errors.New("usage: ion fleet checkout [PATH]")
	}
	checkout := absPath(args[0])
	if err := fleet.IsCheckout(checkout); err != nil {
		return err
	}
	was := cfg.Checkout
	cfg.Checkout = checkout
	saved := cfg
	saved.Hosts = nil
	if err := fleet.Save(path, saved); err != nil {
		return err
	}
	utils.LogWithFields(utils.LevelInfo, "fleet", "fleet checkout set", map[string]any{"checkout": checkout, "was": was})
	fmt.Fprintf(out, "--source dev now builds %s\n", checkout) //nolint:errcheck // answer line
	return nil
}
