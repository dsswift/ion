//go:build !windows

package main

import "errors"

func readUninstallEntry() (*uninstallEntry, error) { return nil, nil }

func engineTaskName() (string, error) {
	return "", errors.New("the engine Scheduled Task exists only on Windows")
}
