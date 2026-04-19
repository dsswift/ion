//go:build windows

package auth

import (
	"fmt"
	"os/exec"
	"strings"
)

// GetKeychainPassword retrieves a credential from Windows Credential Manager
// using the PasswordVault API via PowerShell. The service and account map to
// the PasswordVault resource and userName fields respectively.
func GetKeychainPassword(service, account string) (string, error) {
	psCmd := fmt.Sprintf(`
		$vault = New-Object Windows.Security.Credentials.PasswordVault
		$cred = $vault.Retrieve('%s', '%s')
		$cred.RetrievePassword()
		$cred.Password
	`, escapePSString(service), escapePSString(account))

	cmd := exec.Command("powershell", "-NoProfile", "-Command", psCmd)
	out, err := cmd.Output()
	if err != nil {
		return "", fmt.Errorf("wincred lookup failed for %s/%s: %w", service, account, err)
	}
	return strings.TrimSpace(string(out)), nil
}

// SetKeychainPassword stores a credential in Windows Credential Manager
// using the PasswordVault API via PowerShell.
func SetKeychainPassword(service, account, password string) error {
	psCmd := fmt.Sprintf(`
		$vault = New-Object Windows.Security.Credentials.PasswordVault
		try { $old = $vault.Retrieve('%s', '%s'); $vault.Remove($old) } catch {}
		$cred = New-Object Windows.Security.Credentials.PasswordCredential('%s', '%s', '%s')
		$vault.Add($cred)
	`,
		escapePSString(service), escapePSString(account),
		escapePSString(service), escapePSString(account), escapePSString(password))

	cmd := exec.Command("powershell", "-NoProfile", "-Command", psCmd)
	return cmd.Run()
}

// escapePSString escapes single quotes for PowerShell string literals.
func escapePSString(s string) string {
	return strings.ReplaceAll(s, "'", "''")
}
