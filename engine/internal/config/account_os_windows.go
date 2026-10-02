//go:build windows

package config

import (
	"os/user"
	"strings"

	"golang.org/x/sys/windows"

	"github.com/dsswift/ion/engine/internal/utils"
)

// readOSAccount reads the engine process's account from the operating
// system and its groups from the process token. The token carries every
// group the sign-in was granted, including directory groups that have no
// local group entry, so those match by SID even when no name resolves.
func readOSAccount() osAccount {
	var account osAccount
	if u, err := user.Current(); err != nil {
		utils.LogWithFields(utils.LevelWarn, "config.enterprise", "os account unresolved; no account policy can match by os dimension", map[string]any{"error": err.Error()})
	} else {
		bare := u.Username
		if i := strings.LastIndex(bare, `\`); i >= 0 {
			bare = bare[i+1:]
		}
		account.Users = nonEmpty(u.Username, bare, u.Uid)
	}

	groups, err := windows.GetCurrentProcessToken().GetTokenGroups()
	if err != nil {
		utils.LogWithFields(utils.LevelWarn, "config.enterprise", "os account groups unresolved", map[string]any{"error": err.Error()})
		return account
	}
	for _, group := range groups.AllGroups() {
		if group.Attributes&windows.SE_GROUP_ENABLED == 0 {
			continue
		}
		account.Groups = append(account.Groups, group.Sid.String())
		name, domain, _, err := group.Sid.LookupAccount("")
		if err != nil || name == "" {
			continue
		}
		account.Groups = append(account.Groups, name)
		if domain != "" {
			account.Groups = append(account.Groups, domain+`\`+name)
		}
	}
	return account
}
