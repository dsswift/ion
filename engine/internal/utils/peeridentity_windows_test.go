//go:build windows

package utils

import (
	"testing"
	"unsafe"

	"golang.org/x/sys/windows"
)

// An elevated ion must leave an entry letting its own user query the process
// and its token, or a non-elevated engine refuses its connection. A
// non-elevated process changes nothing.
func TestShareIdentityWithOwnUser(t *testing.T) {
	self := windows.GetCurrentProcessToken()
	changed, err := ShareIdentityWithOwnUser()
	if err != nil {
		t.Fatalf("ShareIdentityWithOwnUser: %v", err)
	}
	if !self.IsElevated() {
		if changed {
			t.Fatal("a non-elevated process reported a change")
		}
		return
	}
	if !changed {
		t.Fatal("an elevated process reported no change")
	}
	user, err := self.GetTokenUser()
	if err != nil {
		t.Fatal(err)
	}
	sid := user.User.Sid.String()
	sd, err := windows.GetSecurityInfo(windows.CurrentProcess(), windows.SE_KERNEL_OBJECT, windows.DACL_SECURITY_INFORMATION)
	if err != nil {
		t.Fatal(err)
	}
	if !grantsTo(t, sd, user.User.Sid, processQueryLimitedInformation) {
		t.Errorf("process DACL %s does not let %s query the process", sd.String(), sid)
	}
	var token windows.Token
	if err := windows.OpenProcessToken(windows.CurrentProcess(), windows.TOKEN_QUERY|windows.READ_CONTROL, &token); err != nil {
		t.Fatal(err)
	}
	defer token.Close() //nolint:errcheck // test cleanup
	tsd, err := windows.GetSecurityInfo(windows.Handle(token), windows.SE_KERNEL_OBJECT, windows.DACL_SECURITY_INFORMATION)
	if err != nil {
		t.Fatal(err)
	}
	if !grantsTo(t, tsd, user.User.Sid, windows.TOKEN_QUERY) {
		t.Errorf("token DACL %s does not let %s query the token", tsd.String(), sid)
	}
}

// grantsTo reports whether sd's DACL has an allow entry for sid covering mask.
func grantsTo(t *testing.T, sd *windows.SECURITY_DESCRIPTOR, sid *windows.SID, mask windows.ACCESS_MASK) bool {
	t.Helper()
	acl, _, err := sd.DACL()
	if err != nil {
		t.Fatal(err)
	}
	for i := uint32(0); i < uint32(acl.AceCount); i++ {
		var ace *windows.ACCESS_ALLOWED_ACE
		if err := windows.GetAce(acl, i, &ace); err != nil {
			t.Fatal(err)
		}
		if ace.Header.AceType != windows.ACCESS_ALLOWED_ACE_TYPE || ace.Mask&mask != mask {
			continue
		}
		if (*windows.SID)(unsafe.Pointer(&ace.SidStart)).Equals(sid) {
			return true
		}
	}
	return false
}
