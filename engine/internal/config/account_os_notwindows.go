//go:build !windows

package config

import (
	"os/user"

	"github.com/dsswift/ion/engine/internal/utils"
)

// readOSAccount reads the engine process's account and its groups from the
// operating system. A group whose name cannot be looked up is still matched
// by its id.
func readOSAccount() osAccount {
	u, err := user.Current()
	if err != nil {
		utils.LogWithFields(utils.LevelWarn, "config.enterprise", "os account unresolved; no account policy can match by os dimension", map[string]any{"error": err.Error()})
		return osAccount{}
	}
	account := osAccount{Users: nonEmpty(u.Username, u.Uid)}
	gids, err := u.GroupIds()
	if err != nil {
		utils.LogWithFields(utils.LevelWarn, "config.enterprise", "os account groups unresolved", map[string]any{"error": err.Error()})
		return account
	}
	for _, gid := range gids {
		account.Groups = append(account.Groups, gid)
		if g, err := user.LookupGroupId(gid); err == nil && g.Name != "" {
			account.Groups = append(account.Groups, g.Name)
		}
	}
	return account
}
