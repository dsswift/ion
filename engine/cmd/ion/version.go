package main

import (
	"fmt"
	"io"

	"github.com/dsswift/ion/engine/internal/compat"
)

// versionReport is `ion version --json`: the binary's version and its Format
// Versions. It reads nothing but the binary, so it answers for an installed
// engine that is not running.
type versionReport struct {
	Version string          `json:"version"`
	Formats []compat.Format `json:"formats"`
}

func printVersion(w io.Writer, asJSON bool) {
	if !asJSON {
		fmt.Fprintf(w, "ion-engine %s\n", version) //nolint:errcheck // stdout write; nothing to do on failure
		return
	}
	fmt.Fprintln(w, string(mustMarshalCLI(versionReport{Version: version, Formats: compat.Formats()}))) //nolint:errcheck // stdout write; nothing to do on failure
}
