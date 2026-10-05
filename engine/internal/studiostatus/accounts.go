package studiostatus

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"sort"
)

// Account is one provider CLI account a server has seen signed in during
// the last 30 days: a row of its Provider Account Ledger
// (packages/shared FleetAccount). SignedIn says whether it is the account
// signed in on that server now.
type Account struct {
	Provider   string `json:"provider"`
	Backend    string `json:"backend"`
	Email      string `json:"email"`
	OrgID      string `json:"orgId,omitempty"`
	OrgName    string `json:"orgName,omitempty"`
	PlanType   string `json:"planType,omitempty"`
	AuthMethod string `json:"authMethod,omitempty"`
	Label      string `json:"label,omitempty"`
	// FirstSeen and LastSeen are Unix milliseconds.
	FirstSeen   int64          `json:"firstSeen"`
	LastSeen    int64          `json:"lastSeen"`
	SignedIn    bool           `json:"signedIn"`
	Limits      []AccountLimit `json:"limits"`
	LimitsError string         `json:"limitsError,omitempty"`
}

// AccountLimit is one usage limit of an account as last read.
type AccountLimit struct {
	// Kind is session, weekly, weekly_model, or spend.
	Kind string `json:"kind"`
	// Label names the model of a weekly_model limit.
	Label string `json:"label,omitempty"`
	// Percent used, 0..100.
	Percent float64 `json:"percent"`
	// ResetsAt is RFC3339; empty when unknown.
	ResetsAt string `json:"resetsAt,omitempty"`
	// FetchedAt is the Unix millisecond the limit was read.
	FetchedAt int64 `json:"fetchedAt"`
}

// Key is the identity of an account across servers: one account of one
// provider (packages/shared fleetAccountKey).
func (a Account) Key() string {
	method := ""
	if a.Email == "" {
		method = a.AuthMethod
	}
	return a.Provider + "|" + lower(a.Email) + "|" + a.OrgID + "|" + method
}

// Name is what to call the account: its email, else its label, else its provider.
func (a Account) Name() string {
	switch {
	case a.Email != "":
		return a.Email
	case a.Label != "":
		return a.Label
	default:
		return a.Provider
	}
}

// Limit is the account's limit of kind; label picks one model's among
// several weekly_model limits, and "" takes the first.
func (a Account) Limit(kind, label string) (AccountLimit, bool) {
	for _, l := range a.Limits {
		if l.Kind == kind && (label == "" || l.Label == label) {
			return l, true
		}
	}
	return AccountLimit{}, false
}

func lower(s string) string {
	b := []byte(s)
	for i, c := range b {
		if c >= 'A' && c <= 'Z' {
			b[i] = c + 32
		}
	}
	return string(b)
}

// LedgerFile is the server's Provider Account Ledger under its data
// directory.
const LedgerFile = "provider-accounts.json"

// ReadLedger reads the ledger a server keeps in dataDir. A server that has
// written none yet has no accounts.
func ReadLedger(dataDir string) ([]Account, error) {
	data, err := os.ReadFile(filepath.Join(dataDir, LedgerFile))
	if errors.Is(err, os.ErrNotExist) {
		return []Account{}, nil
	}
	if err != nil {
		return nil, err
	}
	var file struct {
		Accounts []Account `json:"accounts"`
	}
	if err := json.Unmarshal(data, &file); err != nil {
		return nil, err
	}
	if file.Accounts == nil {
		file.Accounts = []Account{}
	}
	return file.Accounts, nil
}

// AccountMachine is a host an account has been seen on.
type AccountMachine struct {
	Host     string `json:"host"`
	SignedIn bool   `json:"signedIn"`
	LastSeen int64  `json:"lastSeen"`
}

// FleetAccount is one account across every host that reported it.
type FleetAccount struct {
	Account
	Machines []AccountMachine `json:"machines"`
}

// MergeAccounts makes one row per account across hosts. An account is
// signed in when any host has it signed in now; each of its limits is the
// one read most recently on any host. Signed-in accounts lead, then the
// most recently seen.
func MergeAccounts(byHost map[string][]Account, hostOrder []string) []FleetAccount {
	rows := map[string]*FleetAccount{}
	var keys []string
	for _, host := range hostOrder {
		for _, a := range byHost[host] {
			key := a.Key()
			row, ok := rows[key]
			if !ok {
				row = &FleetAccount{Account: a}
				row.Limits = nil
				row.SignedIn = false
				rows[key] = row
				keys = append(keys, key)
			} else if a.LastSeen > row.LastSeen {
				signedIn, limits, machines := row.SignedIn, row.Limits, row.Machines
				row.Account = a
				row.SignedIn, row.Limits, row.Machines = signedIn, limits, machines
			}
			row.SignedIn = row.SignedIn || a.SignedIn
			row.Machines = append(row.Machines, AccountMachine{Host: host, SignedIn: a.SignedIn, LastSeen: a.LastSeen})
			for _, l := range a.Limits {
				at := -1
				for i, held := range row.Limits {
					if held.Kind == l.Kind && held.Label == l.Label {
						at = i
						break
					}
				}
				switch {
				case at < 0:
					row.Limits = append(row.Limits, l)
				case row.Limits[at].FetchedAt < l.FetchedAt:
					row.Limits[at] = l
				}
			}
		}
	}
	out := make([]FleetAccount, 0, len(keys))
	for _, key := range keys {
		out = append(out, *rows[key])
	}
	sort.SliceStable(out, func(i, j int) bool {
		if out[i].SignedIn != out[j].SignedIn {
			return out[i].SignedIn
		}
		return out[i].LastSeen > out[j].LastSeen
	})
	return out
}
