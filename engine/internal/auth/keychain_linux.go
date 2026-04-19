//go:build linux

package auth

import "fmt"

// GetKeychainPassword is a stub on Linux. Use environment variables or the
// encrypted file store instead.
func GetKeychainPassword(service, account string) (string, error) {
	return "", fmt.Errorf("keychain not supported on linux; use env vars or credentials file")
}

// SetKeychainPassword is a stub on Linux.
func SetKeychainPassword(service, account, password string) error {
	return fmt.Errorf("keychain not supported on linux; use env vars or credentials file")
}
