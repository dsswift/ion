//go:build !darwin && !windows && !linux

package auth

import "fmt"

// GetKeychainPassword is unsupported on this platform.
func GetKeychainPassword(service, account string) (string, error) {
	return "", fmt.Errorf("credential store not supported on this platform")
}

// SetKeychainPassword is unsupported on this platform.
func SetKeychainPassword(service, account, password string) error {
	return fmt.Errorf("credential store not supported on this platform")
}
