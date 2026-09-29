//go:build windows

package main

import (
	"errors"

	"golang.org/x/sys/windows/registry"

	"github.com/dsswift/ion/engine/internal/studiostatus"
)

// readUninstallEntry reads the desktop's uninstall key, per-machine first.
// No key is (nil, nil): the desktop is not installed through its installer.
func readUninstallEntry() (*uninstallEntry, error) {
	path := studiostatus.WindowsUninstallKey
	for _, hive := range []registry.Key{registry.LOCAL_MACHINE, registry.CURRENT_USER} {
		k, err := registry.OpenKey(hive, path, registry.QUERY_VALUE)
		if errors.Is(err, registry.ErrNotExist) {
			continue
		}
		if err != nil {
			return nil, err
		}
		entry := &uninstallEntry{}
		entry.DisplayVersion, _, _ = k.GetStringValue("DisplayVersion")   //nolint:errcheck // a missing value reads as empty
		entry.InstallLocation, _, _ = k.GetStringValue("InstallLocation") //nolint:errcheck // a missing value reads as empty
		entry.DisplayIcon, _, _ = k.GetStringValue("DisplayIcon")         //nolint:errcheck // a missing value reads as empty
		k.Close()                                                         //nolint:errcheck // read-only key handle
		return entry, nil
	}
	return nil, nil
}

// engineTaskName is the desktop's per-user engine Scheduled Task.
func engineTaskName() (string, error) {
	sid, err := currentUserSID()
	if err != nil {
		return "", err
	}
	return "Ion Engine (" + sid + ")", nil
}
