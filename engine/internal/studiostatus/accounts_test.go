package studiostatus

import (
	"os"
	"path/filepath"
	"testing"
)

func account(email string, signedIn bool, lastSeen int64, limits ...AccountLimit) Account {
	return Account{Provider: "anthropic", Backend: "claude-code", Email: email, OrgID: "org-" + email, SignedIn: signedIn, LastSeen: lastSeen, Limits: limits}
}

func TestMergeAccounts(t *testing.T) {
	byHost := map[string][]Account{
		"oscar": {
			account("a@example.com", false, 100, AccountLimit{Kind: "session", Percent: 10, FetchedAt: 100}, AccountLimit{Kind: "weekly", Percent: 60, FetchedAt: 300}),
			account("gone@example.com", false, 50),
		},
		"laptop": {
			account("a@example.com", true, 200, AccountLimit{Kind: "session", Percent: 40, FetchedAt: 200}, AccountLimit{Kind: "weekly", Percent: 50, FetchedAt: 150}),
			account("b@example.com", true, 150),
		},
	}
	rows := MergeAccounts(byHost, []string{"oscar", "laptop"})
	if len(rows) != 3 || rows[0].Email != "a@example.com" || rows[1].Email != "b@example.com" || rows[2].Email != "gone@example.com" {
		t.Fatalf("rows = %+v", rows)
	}
	a := rows[0]
	if !a.SignedIn || a.LastSeen != 200 || len(a.Machines) != 2 {
		t.Errorf("a = %+v", a)
	}
	if a.Machines[0] != (AccountMachine{Host: "oscar", SignedIn: false, LastSeen: 100}) || a.Machines[1] != (AccountMachine{Host: "laptop", SignedIn: true, LastSeen: 200}) {
		t.Errorf("machines = %+v", a.Machines)
	}
	// Each limit is the one read most recently, whichever host read it.
	if session, _ := a.Limit("session", ""); session.Percent != 40 {
		t.Errorf("session = %+v", session)
	}
	if weekly, _ := a.Limit("weekly", ""); weekly.Percent != 60 {
		t.Errorf("weekly = %+v", weekly)
	}
	if rows[2].SignedIn || rows[2].Name() != "gone@example.com" {
		t.Errorf("an account signed in nowhere = %+v", rows[2])
	}
}

func TestAccountKey(t *testing.T) {
	a := Account{Provider: "anthropic", Email: "A@Example.com", OrgID: "o1"}
	b := Account{Provider: "anthropic", Email: "a@example.com", OrgID: "o1", AuthMethod: "claude.ai"}
	if a.Key() != b.Key() {
		t.Error("the same account under two spellings of its email has two keys")
	}
	key := Account{Provider: "openai", AuthMethod: "apiKey", Label: "OpenAI API Key"}
	chat := Account{Provider: "openai", AuthMethod: "chatgpt"}
	if key.Key() == chat.Key() || key.Name() != "OpenAI API Key" {
		t.Errorf("two logins with no email: %q %q", key.Key(), chat.Key())
	}
}

func TestReadLedger(t *testing.T) {
	dir := t.TempDir()
	if accounts, err := ReadLedger(dir); err != nil || len(accounts) != 0 || accounts == nil {
		t.Fatalf("a server with no ledger yet: %v %v", accounts, err)
	}
	ledger := `{"accounts":[{"provider":"anthropic","backend":"claude-code","email":"a@example.com","orgId":"o","planType":"max","label":"Claude Max","firstSeen":1,"lastSeen":2,"signedIn":true,
	  "limits":[{"kind":"weekly_model","label":"Example Model","percent":76,"resetsAt":"2026-10-05T21:00:00Z","fetchedAt":2}]}]}`
	if err := os.WriteFile(filepath.Join(dir, LedgerFile), []byte(ledger), 0o600); err != nil {
		t.Fatal(err)
	}
	accounts, err := ReadLedger(dir)
	if err != nil || len(accounts) != 1 {
		t.Fatalf("accounts = %+v %v", accounts, err)
	}
	l, ok := accounts[0].Limit("weekly_model", "Example Model")
	if !ok || l.Percent != 76 || l.FetchedAt != 2 || !accounts[0].SignedIn || accounts[0].Label != "Claude Max" {
		t.Errorf("account = %+v", accounts[0])
	}
}
