//go:build windows

package utils

import (
	"fmt"

	"golang.org/x/sys/windows"
)

// processQueryLimitedInformation is PROCESS_QUERY_LIMITED_INFORMATION.
const processQueryLimitedInformation = 0x1000

// ShareIdentityWithOwnUser lets processes of this process's own user read
// who it runs as, when this process is elevated. It returns whether it
// changed anything.
//
// The engine accepts a loopback client only after it opens the client's
// process and token and finds its own user there. An elevated process's
// process and token DACLs grant SYSTEM and Administrators only, and a
// non-elevated engine holds neither, so the engine could not name an
// elevated ion of the same user (an administrator's SSH session, an elevated
// terminal) and refused it. This adds one entry to each DACL: the token user
// may query the process and its token. It grants no write, no handle
// duplication, and nothing to any other account.
func ShareIdentityWithOwnUser() (bool, error) {
	self := windows.GetCurrentProcessToken()
	if !self.IsElevated() {
		return false, nil
	}
	user, err := self.GetTokenUser()
	if err != nil {
		return false, fmt.Errorf("read process token user: %w", err)
	}
	sid := user.User.Sid
	if err := grantToSID(windows.CurrentProcess(), sid, processQueryLimitedInformation); err != nil {
		return false, fmt.Errorf("grant query on the process: %w", err)
	}
	var token windows.Token
	if err := windows.OpenProcessToken(windows.CurrentProcess(), windows.TOKEN_QUERY|windows.READ_CONTROL|windows.WRITE_DAC, &token); err != nil {
		return false, fmt.Errorf("open the process token: %w", err)
	}
	defer token.Close() //nolint:errcheck // closing a query handle on our own token; nothing to do on failure
	if err := grantToSID(windows.Handle(token), sid, windows.TOKEN_QUERY); err != nil {
		return false, fmt.Errorf("grant query on the token: %w", err)
	}
	return true, nil
}

// grantToSID adds an allow entry for sid to the kernel object's DACL,
// keeping every entry already there.
func grantToSID(h windows.Handle, sid *windows.SID, mask windows.ACCESS_MASK) error {
	sd, err := windows.GetSecurityInfo(h, windows.SE_KERNEL_OBJECT, windows.DACL_SECURITY_INFORMATION)
	if err != nil {
		return fmt.Errorf("read DACL: %w", err)
	}
	current, _, err := sd.DACL()
	if err != nil {
		return fmt.Errorf("decode DACL: %w", err)
	}
	acl, err := windows.ACLFromEntries([]windows.EXPLICIT_ACCESS{{
		AccessPermissions: mask,
		AccessMode:        windows.GRANT_ACCESS,
		Inheritance:       windows.NO_INHERITANCE,
		Trustee: windows.TRUSTEE{
			TrusteeForm:  windows.TRUSTEE_IS_SID,
			TrusteeType:  windows.TRUSTEE_IS_USER,
			TrusteeValue: windows.TrusteeValueFromSID(sid),
		},
	}}, current)
	if err != nil {
		return fmt.Errorf("build DACL: %w", err)
	}
	if err := windows.SetSecurityInfo(h, windows.SE_KERNEL_OBJECT, windows.DACL_SECURITY_INFORMATION, nil, nil, acl, nil); err != nil {
		return fmt.Errorf("write DACL: %w", err)
	}
	return nil
}
