package fleet

import (
	"fmt"
	"os"
	"strings"
)

// InstallArgsUsage describes the flags ParseInstallArgs reads.
const InstallArgsUsage = `  --quit-ion             Quit a running desktop first (no quit dialog; its conversations stop).
                         Without it, a running desktop stops the install before anything is copied
  --ask-sudo             A Mac's sudo asks for a password: run its installer on this terminal
  --backup               Copy the host's ~/.ion aside first, and check the copy
  --open                 Make sure the desktop runs afterwards
  --no-open-at-login     Leave a desktop host's "Open Ion at login" setting alone. Without it a
                         deploy turns the setting on where nobody on the host has chosen
  --pair [label]         Mint a pairing link once the host's server is up (label: this machine's name)
  --relay URL            Put the host on this relay. --relay-oidc when the relay signs its operator in;
                         otherwise the relay's key comes from ION_RELAY_KEY or --relay-key-file PATH,
                         and reaches the host on ssh's stdin only
  --label NAME           A first Studio Server install's Environment label
  --advertise URL        A first Studio Server install's pairing address
  --tenancy MODE         A first Studio Server install's tenancy: shared or isolated
  --system               A Studio Server on macOS: system LaunchDaemons (headless host)
`

// ParseInstallArgs reads install flags into o and returns the arguments it
// does not know. A fleet profile's "args" and `ion fleet deploy --to` share
// it.
func ParseInstallArgs(args []string, o InstallOptions) (InstallOptions, []string, error) {
	var rest []string
	value := func(i int, flag string) (string, error) {
		if i+1 >= len(args) || strings.HasPrefix(args[i+1], "--") {
			return "", fmt.Errorf("%s needs a value", flag)
		}
		return args[i+1], nil
	}
	for i := 0; i < len(args); i++ {
		var err error
		switch a := args[i]; a {
		case "--quit-ion":
			o.QuitIon = true
		case "--ask-sudo":
			o.AskSudo = true
		case "--backup":
			o.Backup = true
		case "--open":
			o.Open = true
		case "--no-open-at-login":
			o.NoOpenAtLogin = true
		case "--system":
			o.System = true
		case "--relay-oidc":
			o.RelayOIDC = true
		case "--pair":
			o.Pair = shortHostname()
			if i+1 < len(args) && !strings.HasPrefix(args[i+1], "--") {
				o.Pair = args[i+1]
				i++
			}
		case "--relay", "--relay-key-file", "--label", "--advertise", "--tenancy":
			var v string
			if v, err = value(i, a); err != nil {
				return o, nil, err
			}
			i++
			switch a {
			case "--relay":
				o.Relay = v
			case "--relay-key-file":
				if o.RelayKey, err = readKeyFile(v); err != nil {
					return o, nil, err
				}
			case "--label":
				o.Label = v
			case "--advertise":
				o.Advertise = v
			case "--tenancy":
				o.Tenancy = v
			}
		default:
			rest = append(rest, a)
		}
	}
	return o, rest, nil
}

// readKeyFile reads a relay key file's first line.
func readKeyFile(path string) (string, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return "", fmt.Errorf("--relay-key-file: %w", err)
	}
	key := strings.TrimSpace(strings.SplitN(string(data), "\n", 2)[0])
	if key == "" {
		return "", fmt.Errorf("--relay-key-file %s is empty", path)
	}
	return key, nil
}
