//go:build windows

package auth

import (
	"fmt"
	"runtime"
	"unsafe"

	"github.com/dsswift/ion/engine/internal/utils"
	"golang.org/x/sys/windows"
)

// The Windows Credential Manager is reached through advapi32 directly rather
// than by shelling out.
//
// This used to run a PowerShell script per call, against the WinRT
// PasswordVault API. Measured on Windows 11: ~510 ms to start PowerShell at
// all and ~800-980 ms for the full lookup. HasKey runs the credential probe
// on every check and the hybrid backend checks per streamed event, so a
// single short turn spent about twelve seconds starting PowerShell thirteen
// times. A direct API call is a function call.
var (
	modAdvapi32    = windows.NewLazySystemDLL("advapi32.dll")
	procCredReadW  = modAdvapi32.NewProc("CredReadW")
	procCredWriteW = modAdvapi32.NewProc("CredWriteW")
	procCredFree   = modAdvapi32.NewProc("CredFree")
)

const (
	credTypeGeneric = 1

	// CRED_PERSIST_LOCAL_MACHINE. The credential survives sign-out and
	// reboot and is visible to this user's other logon sessions on this
	// machine, which is what a stored provider API key needs.
	//
	// Deliberately not CRED_PERSIST_ENTERPRISE (3), which additionally roams
	// the credential to the user's other machines through their profile. An
	// API key is machine-local by intent. Not CRED_PERSIST_SESSION (1)
	// either, which would silently discard the key at sign-out.
	credPersistLocalMachine = 2
)

// winCredential mirrors the Win32 CREDENTIALW structure. Field order and
// widths are the ABI; do not reorder.
type winCredential struct {
	Flags              uint32
	Type               uint32
	TargetName         *uint16
	Comment            *uint16
	LastWritten        windows.Filetime
	CredentialBlobSize uint32
	CredentialBlob     *byte
	Persist            uint32
	AttributeCount     uint32
	Attributes         uintptr
	TargetAlias        *uint16
	UserName           *uint16
}

// GetKeychainPassword retrieves a credential from the Windows Credential
// Manager. A credential that is not present returns an error, which is how
// the resolver's fallback chain reads a miss.
func GetKeychainPassword(service, account string) (string, error) {
	target, err := windows.UTF16PtrFromString(credentialTargetName(service, account))
	if err != nil {
		return "", fmt.Errorf("wincred target name for %s/%s: %w", service, account, err)
	}

	var cred *winCredential
	ret, _, callErr := procCredReadW.Call(
		uintptr(unsafe.Pointer(target)),
		uintptr(credTypeGeneric),
		0,
		uintptr(unsafe.Pointer(&cred)),
	)
	if ret == 0 {
		// ERROR_NOT_FOUND is the ordinary "no credential stored" answer and
		// is logged at debug; anything else is a real failure of the store.
		if callErr == windows.ERROR_NOT_FOUND {
			utils.LogWithFields(utils.LevelDebug, "auth", "wincred: no credential stored", map[string]any{"service": service, "account": account})
		} else {
			utils.LogWithFields(utils.LevelWarn, "auth", "wincred: credential read failed", map[string]any{"service": service, "account": account, "error": utils.ErrStr(callErr)})
		}
		return "", fmt.Errorf("wincred lookup failed for %s/%s: %w", service, account, callErr)
	}
	defer procCredFree.Call(uintptr(unsafe.Pointer(cred))) //nolint:errcheck // CredFree returns no status

	if cred.CredentialBlobSize == 0 || cred.CredentialBlob == nil {
		utils.LogWithFields(utils.LevelWarn, "auth", "wincred: credential present but empty", map[string]any{"service": service, "account": account})
		return "", fmt.Errorf("wincred credential for %s/%s has no value", service, account)
	}
	blob := unsafe.Slice(cred.CredentialBlob, cred.CredentialBlobSize)
	secret, err := decodeCredentialBlob(blob)
	if err != nil {
		utils.LogWithFields(utils.LevelWarn, "auth", "wincred: credential blob is not decodable", map[string]any{"service": service, "account": account, "error": utils.ErrStr(err)})
		return "", fmt.Errorf("wincred credential for %s/%s: %w", service, account, err)
	}
	utils.LogWithFields(utils.LevelDebug, "auth", "wincred: credential read", map[string]any{"service": service, "account": account, "value_length": len(secret)})
	return secret, nil
}

// SetKeychainPassword stores a credential in the Windows Credential Manager,
// replacing any existing entry for the same target.
func SetKeychainPassword(service, account, password string) error {
	target, err := windows.UTF16PtrFromString(credentialTargetName(service, account))
	if err != nil {
		return fmt.Errorf("wincred target name for %s/%s: %w", service, account, err)
	}
	user, err := windows.UTF16PtrFromString(account)
	if err != nil {
		return fmt.Errorf("wincred user name for %s/%s: %w", service, account, err)
	}

	blob := encodeCredentialBlob(password)
	cred := winCredential{
		Type:               credTypeGeneric,
		TargetName:         target,
		CredentialBlobSize: uint32(len(blob)),
		Persist:            credPersistLocalMachine,
		UserName:           user,
	}
	if len(blob) > 0 {
		cred.CredentialBlob = &blob[0]
	}

	ret, _, callErr := procCredWriteW.Call(uintptr(unsafe.Pointer(&cred)), 0)
	// blob is referenced by cred for the duration of the call; keeping it
	// alive here stops the collector from moving out from under advapi32.
	runtime.KeepAlive(blob)
	if ret == 0 {
		utils.LogWithFields(utils.LevelError, "auth", "wincred: credential write failed", map[string]any{"service": service, "account": account, "error": utils.ErrStr(callErr)})
		return fmt.Errorf("wincred write failed for %s/%s: %w", service, account, callErr)
	}
	utils.LogWithFields(utils.LevelInfo, "auth", "wincred: credential written", map[string]any{"service": service, "account": account})
	return nil
}
