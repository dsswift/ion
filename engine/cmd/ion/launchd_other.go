//go:build !darwin

package main

// startManagedEngine reports that no service manager starts the engine on
// this platform, so the caller spawns one itself.
func startManagedEngine() bool { return false }
