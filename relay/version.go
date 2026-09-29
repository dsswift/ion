package main

import (
	_ "embed"
	"strings"
)

// relayVersionFile is the release version (VERSION, beside this file). It is
// embedded so every build, the container image included, reports the version
// it was cut from.
//
//go:embed VERSION
var relayVersionFile string

// relayVersion is the relay's release version, reported as the OTLP
// service.version.
var relayVersion = strings.TrimSpace(relayVersionFile)
