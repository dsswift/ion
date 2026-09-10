//go:build windows

package utils

import (
	"fmt"

	"golang.org/x/sys/windows"
)

// RestrictToOwner replaces path's DACL with a single entry granting full
// control to the user this process is running as, removes inheritance, and
// makes that user the file's owner.
//
// Go's os.Chmod cannot express a POSIX mode on Windows: it toggles the
// read-only attribute and nothing else. A file created with 0o600 therefore
// inherits the parent directory's ACL, and a user profile directory grants
// BUILTIN\Administrators full control. For a credential keyfile that means
// the key sits beside the ciphertext it decrypts, readable by any local
// administrator -- while the code comment says 0600.
//
// The trustee is the process token's user, NOT the file's current owner.
// Those differ in the common case: when a member of the Administrators group
// creates a file, Windows sets the owner to BUILTIN\Administrators rather
// than to that member, so granting "the owner" would grant the entire
// administrators group -- reproducing the exact exposure this function
// exists to remove. Ownership is reassigned to the same user for the same
// reason, so a later ACL edit by the owner cannot silently re-widen access.
//
// SYSTEM and Administrators are deliberately excluded. An administrator can
// still take ownership and rewrite the DACL, so this is not a barrier against
// a determined local admin; it does stop the file being readable by default,
// which is the difference between a secret and a file that merely looks like
// one.
func RestrictToOwner(path string) error {
	user, err := windows.GetCurrentProcessToken().GetTokenUser()
	if err != nil {
		return fmt.Errorf("read process token user: %w", err)
	}
	sid := user.User.Sid

	acl, err := windows.ACLFromEntries([]windows.EXPLICIT_ACCESS{
		{
			AccessPermissions: windows.GENERIC_ALL,
			AccessMode:        windows.GRANT_ACCESS,
			Inheritance:       windows.NO_INHERITANCE,
			Trustee: windows.TRUSTEE{
				TrusteeForm:  windows.TRUSTEE_IS_SID,
				TrusteeType:  windows.TRUSTEE_IS_USER,
				TrusteeValue: windows.TrusteeValueFromSID(sid),
			},
		},
	}, nil)
	if err != nil {
		return fmt.Errorf("build dacl for %s: %w", path, err)
	}

	// PROTECTED_DACL_SECURITY_INFORMATION is what detaches the file from the
	// parent directory's inherited entries; without it the Administrators
	// grant comes straight back.
	if err := windows.SetNamedSecurityInfo(
		path,
		windows.SE_FILE_OBJECT,
		windows.OWNER_SECURITY_INFORMATION|windows.DACL_SECURITY_INFORMATION|windows.PROTECTED_DACL_SECURITY_INFORMATION,
		sid, nil, acl, nil,
	); err != nil {
		return fmt.Errorf("set owner and dacl on %s: %w", path, err)
	}
	return nil
}
