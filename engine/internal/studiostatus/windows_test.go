package studiostatus

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

// The uninstall key is named after the installer's GUID; a GUID changed in
// the desktop's build config alone would leave every Windows host unreadable.
func TestWindowsDesktopGUIDMatchesTheInstaller(t *testing.T) {
	data, err := os.ReadFile(filepath.Join("..", "..", "..", "desktop", "package.json"))
	if err != nil {
		t.Fatal(err)
	}
	var pkg struct {
		Build struct {
			NSIS struct {
				GUID string `json:"guid"`
			} `json:"nsis"`
		} `json:"build"`
	}
	if err := json.Unmarshal(data, &pkg); err != nil {
		t.Fatal(err)
	}
	if pkg.Build.NSIS.GUID != WindowsDesktopGUID {
		t.Fatalf("desktop/package.json build.nsis.guid = %q, WindowsDesktopGUID = %q", pkg.Build.NSIS.GUID, WindowsDesktopGUID)
	}
}
