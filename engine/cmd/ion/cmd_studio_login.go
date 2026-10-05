package main

import (
	"fmt"
	"os"

	"github.com/dsswift/ion/engine/internal/fleet"
	"github.com/dsswift/ion/engine/internal/utils"
)

// studioOpenAtLogin turns the desktop's "Open Ion at login" device setting
// on or off in this host's desktop.json. The desktop app owns the system's
// login item: a running one applies the change at once, a closed one when it
// next starts. With --if-unset a value someone already chose stands, which
// is how a fleet deploy turns it on without overriding the host's person.
// The last line printed is "open at login: on" or "open at login: off".
func studioOpenAtLogin(layout studioLayout, rest []string, flags map[string]string) {
	if len(rest) != 1 || (rest[0] != "on" && rest[0] != "off") {
		fmt.Fprintln(os.Stderr, "Usage: ion studio open-at-login on|off [--if-unset]")
		os.Exit(1)
	}
	now, wrote, err := fleet.OpenCatalogAt(layout.dataDir).SetDeviceSetting(fleet.OpenAtLoginKey, rest[0] == "on", flags["if-unset"] == "true")
	if err != nil {
		utils.LogWithFields(utils.LevelError, studioTag, "open at login could not be set", map[string]any{"error": err.Error(), "data_dir": layout.dataDir})
		fmt.Fprintf(os.Stderr, "Error: %v\n", err)
		os.Exit(1)
	}
	utils.LogWithFields(utils.LevelInfo, studioTag, "open at login set", map[string]any{"value": now, "wrote": wrote, "data_dir": layout.dataDir})
	if !wrote {
		fmt.Println("left as it was already chosen on this computer")
	}
	state := "off"
	if now {
		state = "on"
	}
	fmt.Println("open at login: " + state)
}
