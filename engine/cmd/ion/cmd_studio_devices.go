package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"strings"
	"time"

	"github.com/dsswift/ion/engine/internal/studiostatus"
)

// devicesTimeout bounds clients.js: a Node start plus one local action.
const devicesTimeout = 10 * time.Second

// readPairedDevices asks the running server for its owner's paired devices
// with its own clients.js, the way `ion studio pair` runs pair.js.
func readPairedDevices(l studioLayout, desktop *desktopInstall) ([]studiostatus.PairedDevice, error) {
	bin, script, env, err := studioServerCLI(l, desktop, "clients.js")
	if err != nil {
		return nil, err
	}
	ctx, cancel := context.WithTimeout(context.Background(), devicesTimeout)
	defer cancel()
	cmd := exec.CommandContext(ctx, bin, script)
	cmd.Env = append(os.Environ(), env...)
	out, err := cmd.Output()
	if err != nil {
		var exitErr *exec.ExitError
		if errors.As(err, &exitErr) && len(exitErr.Stderr) > 0 {
			return nil, fmt.Errorf("%s: %s", script, strings.TrimSpace(string(exitErr.Stderr)))
		}
		return nil, fmt.Errorf("%s: %w", script, err)
	}
	return decodePairedDevices(out)
}

// decodePairedDevices reads clients.js's `{"devices": [...]}`.
func decodePairedDevices(out []byte) ([]studiostatus.PairedDevice, error) {
	var body struct {
		Devices []studiostatus.PairedDevice `json:"devices"`
	}
	if err := json.Unmarshal(out, &body); err != nil {
		return nil, fmt.Errorf("parse clients.js output: %w", err)
	}
	if body.Devices == nil {
		return []studiostatus.PairedDevice{}, nil
	}
	return body.Devices, nil
}
