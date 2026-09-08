//go:build !windows

package main

// hideOwnConsole is a no-op off windows: there is no console-window concept
// to hide, and cmdServe's supervised branch logs the flag as ignored on this
// platform rather than calling ShowWindow.
func hideOwnConsole() (string, error) { return "", nil }
