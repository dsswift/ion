//go:build windows

package auth

import (
	"fmt"
	"os/exec"
	"strings"
	"testing"
	"time"
)

// requireCredentialVault skips when the process has no interactive logon
// session, because the Credential Manager vault does not exist in one.
//
// This is a real environmental limit, not a masked failure: a network logon
// (an SSH shell) and a service logon (a GitHub Actions runner) both run in
// session 0, and CredWriteW there returns ERROR_NO_SUCH_LOGON_SESSION
// regardless of what is written or which persistence is asked for --
// measured against all three CRED_PERSIST values. The engine itself always
// runs in the user's interactive session, so the skipped path is one the
// product never takes.
func requireCredentialVault(t *testing.T) {
	t.Helper()
	const errNoSuchLogonSession = "A specified logon session does not exist"
	probe := fmt.Sprintf("vault-probe-%d", time.Now().UnixNano())
	if err := SetKeychainPassword("ion-engine-test", probe, "probe"); err != nil {
		if strings.Contains(err.Error(), errNoSuchLogonSession) {
			t.Skip("no interactive logon session; the Credential Manager vault is unavailable here")
		}
		t.Fatalf("credential vault probe failed: %v", err)
	}
	deleteTestCredential(t, "ion-engine-test", probe)
}

// A real round trip against the Windows Credential Manager.
//
// wincred_target_test.go covers target-name construction, which is string
// formatting and needs no vault. Nothing exercised an actual write, so the
// write path shipped unproven -- which is how an incorrect diagnosis of the
// persistence flag went unchallenged for as long as it did.
func TestKeychainRoundTrip(t *testing.T) {
	requireCredentialVault(t)
	service := "ion-engine-test"
	account := fmt.Sprintf("roundtrip-%d", time.Now().UnixNano())
	secret := "sk-test-value-not-a-real-key"

	if err := SetKeychainPassword(service, account, secret); err != nil {
		t.Fatalf("SetKeychainPassword: %v", err)
	}
	t.Cleanup(func() { deleteTestCredential(t, service, account) })

	got, err := GetKeychainPassword(service, account)
	if err != nil {
		t.Fatalf("GetKeychainPassword: %v", err)
	}
	if got != secret {
		t.Errorf("round-tripped secret = %q, want %q", got, secret)
	}
}

// The credential must outlive the logon session. CRED_PERSIST_SESSION would
// pass the round-trip test above and still lose the operator's API key at
// sign-out, so the persistence is asserted directly rather than inferred
// from a successful read.
func TestKeychainPersistsAcrossLogon(t *testing.T) {
	requireCredentialVault(t)
	service := "ion-engine-test"
	account := fmt.Sprintf("persist-%d", time.Now().UnixNano())

	if err := SetKeychainPassword(service, account, "value"); err != nil {
		t.Fatalf("SetKeychainPassword: %v", err)
	}
	t.Cleanup(func() { deleteTestCredential(t, service, account) })

	out, err := exec.Command("cmdkey.exe", "/list:"+credentialTargetName(service, account)).CombinedOutput()
	if err != nil {
		t.Fatalf("cmdkey /list: %v: %s", err, out)
	}
	// cmdkey reports CRED_PERSIST_LOCAL_MACHINE as "Local machine persistence"
	// and CRED_PERSIST_SESSION as "Session persistence". Only the latter loses
	// the key at sign-out.
	if strings.Contains(string(out), "Session persistence") {
		t.Errorf("credential is only session-persistent; it will be lost at sign-out:\n%s", out)
	}
}

// deleteTestCredential removes a credential this test wrote. The package
// exposes no delete on any platform, so the test drives cmdkey directly
// rather than leaving entries in the operator's vault.
func deleteTestCredential(t *testing.T, service, account string) {
	t.Helper()
	if out, err := exec.Command("cmdkey.exe", "/delete:"+credentialTargetName(service, account)).CombinedOutput(); err != nil {
		t.Errorf("cleanup: cmdkey /delete: %v: %s", err, out)
	}
}

// A read for a credential that was never written must report a miss rather
// than succeeding, or a caller cannot tell a cleared key from a broken store.
func TestGetKeychainPasswordMissing(t *testing.T) {
	_, err := GetKeychainPassword("ion-engine-test", fmt.Sprintf("absent-%d", time.Now().UnixNano()))
	if err == nil {
		t.Error("GetKeychainPassword for an absent credential returned nil error")
	}
}
