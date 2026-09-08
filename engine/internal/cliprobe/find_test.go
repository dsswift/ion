package cliprobe

import (
	"strings"
	"testing"
)

// TestFind_ErrorTextNamesPlatformSearch asserts the not-found error names
// this platform's actual search order (searchDescription), rather than a
// hardcoded unix-flavored string that would be false on windows.
func TestFind_ErrorTextNamesPlatformSearch(t *testing.T) {
	_, err := Find("ion-cliprobe-definitely-does-not-exist-xyz", nil)
	if err == nil {
		t.Fatal("expected an error for a nonexistent binary")
	}
	if !strings.Contains(err.Error(), searchDescription()) {
		t.Errorf("error %q does not contain search description %q", err.Error(), searchDescription())
	}
}
