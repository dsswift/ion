//go:build darwin

package auth

import (
	"fmt"
	"os/exec"
	"strings"
)

// GetKeychainPassword retrieves a password from the macOS Keychain
// using the `security` CLI.
func GetKeychainPassword(service, account string) (string, error) {
	cmd := exec.Command("security", "find-generic-password",
		"-s", service,
		"-a", account,
		"-w", // output password only
	)

	out, err := cmd.Output()
	if err != nil {
		return "", fmt.Errorf("keychain lookup failed: %w", err)
	}

	return strings.TrimSpace(string(out)), nil
}

// SetKeychainPassword stores a password in the macOS Keychain
// using the `security` CLI.
func SetKeychainPassword(service, account, password string) error {
	// Delete existing entry (ignore errors if not found)
	del := exec.Command("security", "delete-generic-password",
		"-s", service,
		"-a", account,
	)
	del.Run()

	cmd := exec.Command("security", "add-generic-password",
		"-s", service,
		"-a", account,
		"-w", password,
	)

	if err := cmd.Run(); err != nil {
		return fmt.Errorf("keychain store failed: %w", err)
	}

	return nil
}
