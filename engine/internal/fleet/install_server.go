package fleet

import (
	"bytes"
	"context"
	"fmt"
	"io"
	"path/filepath"
	"strings"
)

// InstallServer installs a Studio Server bundle built from a checkout on a
// macOS or Linux host with the checkout's own installer, the one a consumer
// pipes from the one-line install: the host runs exactly this checkout's
// version of it. server.json is written only when the host has none.
func InstallServer(ctx context.Context, r Runner, h Host, bundle string, installer []byte, o InstallOptions, w io.Writer) (Receipt, error) {
	log := installLog{w: w, host: h.Name}
	rec := Receipt{Host: h.Name, RelayApplied: true}
	if err := o.checkRelay(); err != nil {
		return rec, err
	}
	log.step("preflight: %s", h.Name)
	plat, err := r.Platform(ctx, h)
	if err != nil {
		return rec, fmt.Errorf("cannot reach %s over ssh (key authentication is required): %w", h.Name, err)
	}
	if plat.Windows() {
		return rec, fmt.Errorf("%s runs Windows, which has no Studio Server bundle; deploy the desktop there", h.Name)
	}
	if want := "ion-studio-server-" + plat.GOOS + "-" + plat.GOARCH + ".tar.gz"; filepath.Base(bundle) != want {
		return rec, fmt.Errorf("%s is %s and takes %s, not %s", h.Name, plat, want, filepath.Base(bundle))
	}

	log.step("ship %s to %s", filepath.Base(bundle), h.Name)
	incoming := ".ion/studio-server/incoming"
	if _, err := hostCmd(ctx, r, h, false, "mkdir -p \"$HOME/"+incoming+"\"", nil, log); err != nil {
		return rec, err
	}
	remote := incoming + "/" + filepath.Base(bundle)
	if err := r.CopyTo(ctx, h, bundle, remote); err != nil {
		return rec, fmt.Errorf("copy to %s failed: %w", h.Name, err)
	}

	log.step("install on %s", h.Name)
	args, err := serverInstallArgs(o)
	if err != nil {
		return rec, err
	}
	script := "ION_STUDIO_BUNDLE=\"$HOME/" + remote + "\" ION_STUDIO_INSTALL_ARGS=" + shellQuote(strings.Join(args, " ")) + " sh -s"
	out, err := hostCmd(ctx, r, h, false, script, bytes.NewReader(installer), log)
	log.output(out)
	if err != nil {
		return rec, fmt.Errorf("the installer failed on %s: %w", h.Name, err)
	}
	rec.Install = lastReceipt(out)
	if ok, _ := rec.Install["ok"].(bool); !ok { //nolint:errcheck // a missing or non-bool ok is a failed receipt
		return rec, fmt.Errorf("the install on %s did not end with an ok receipt", h.Name)
	}
	if v, ok := rec.Install["version"].(string); ok {
		rec.Version = v
	}
	if _, err := hostCmd(ctx, r, h, false, "rm -f \"$HOME/"+remote+"\"", nil, log); err != nil {
		log.note("could not remove the copied bundle on %s: %v", h.Name, err)
	}

	ion := "\"$HOME/.ion/studio-server/current/bin/ion\""
	if o.Relay != "" {
		log.step("relay: %s", o.Relay)
		relayArgs, stdin := o.relayArgs(false)
		quoted := make([]string, len(relayArgs))
		for i, a := range relayArgs {
			quoted[i] = shellQuote(a)
		}
		out, err := hostCmd(ctx, r, h, false, ion+" "+strings.Join(quoted, " "), stdin, log)
		log.output(out)
		if err != nil {
			return rec, fmt.Errorf("could not set the relay on %s: %w", h.Name, err)
		}
		rec.Relay = o.Relay
	}
	if o.Pair != "" {
		log.step("mint a pairing link on %s", h.Name)
		out, err := hostCmd(ctx, r, h, false, ion+" studio pair --label "+shellQuote(o.Pair), nil, log)
		if err != nil {
			return rec, fmt.Errorf("could not mint a pairing link on %s: %w", h.Name, err)
		}
		rec.PairingLink = strings.TrimSpace(string(out))
		log.note("pairing link (treat it as a password): %s", rec.PairingLink)
	}
	rec.OK = true
	return rec, nil
}

// serverInstallArgs are `ion studio install`'s flags for a first install.
// The installer word-splits them (ION_STUDIO_INSTALL_ARGS), so a value with
// a space or a quote cannot pass through and is refused.
func serverInstallArgs(o InstallOptions) ([]string, error) {
	var args []string
	for _, f := range []struct{ flag, value string }{{"--label", o.Label}, {"--advertise-url", o.Advertise}, {"--tenancy", o.Tenancy}} {
		if f.value == "" {
			continue
		}
		if strings.ContainsAny(f.value, " \t\n'\"$`\\") {
			return nil, fmt.Errorf("%s %q: the installer takes one word here, with no spaces or quotes", f.flag, f.value)
		}
		args = append(args, f.flag, f.value)
	}
	if o.System {
		args = append(args, "--system")
	}
	return args, nil
}
