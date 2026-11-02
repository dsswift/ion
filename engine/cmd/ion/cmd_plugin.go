package main

import (
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"text/tabwriter"

	"github.com/dsswift/ion/engine/internal/plugins"
)

func cmdPlugin(args []string) {
	if len(args) == 0 {
		fmt.Fprintln(os.Stderr, "Usage: ion plugin <install|update|list|remove> [args]")
		os.Exit(1)
	}
	say := func(msg string) { fmt.Println(msg) }
	switch args[0] {
	case "install":
		if len(args) < 2 {
			fmt.Fprintln(os.Stderr, "Usage: ion plugin install <owner/repo | git URL> [plugin]")
			os.Exit(1)
		}
		plugin := ""
		if len(args) > 2 {
			plugin = args[2]
		}
		p, err := plugins.Install(args[1], plugin, say)
		if err != nil {
			fmt.Fprintf(os.Stderr, "Error: %v\n", err)
			os.Exit(1)
		}
		fmt.Printf("Installed %s from %s (%s)\n", p.Name, p.Source, p.Version)
		describeInstalled(p)

	case "update":
		names := args[1:]
		if len(names) == 0 {
			installed, err := plugins.ListInstalled()
			if err != nil {
				fmt.Fprintf(os.Stderr, "Error: %v\n", err)
				os.Exit(1)
			}
			for _, p := range installed {
				names = append(names, p.Name)
			}
		}
		failed := false
		for _, name := range names {
			p, changed, err := plugins.Update(name, say)
			switch {
			case err != nil:
				fmt.Fprintf(os.Stderr, "Error updating %s: %v\n", name, err)
				failed = true
			case changed:
				fmt.Printf("Updated %s to %s\n", p.Name, p.Version)
			default:
				fmt.Printf("%s is up to date (%s)\n", p.Name, p.Version)
			}
		}
		if failed {
			os.Exit(1)
		}

	case "list":
		installed, err := plugins.ListInstalled()
		if err != nil {
			fmt.Fprintf(os.Stderr, "Error: %v\n", err)
			os.Exit(1)
		}
		if len(installed) == 0 {
			fmt.Println("No plugins installed.")
			return
		}
		w := tabwriter.NewWriter(os.Stdout, 0, 0, 2, ' ', 0)
		fmt.Fprintln(w, "NAME\tSOURCE\tVERSION\tINSTALLED\tPATH") //nolint:errcheck // best-effort CLI stdout write
		for _, p := range installed {
			fmt.Fprintf(w, "%s\t%s\t%s\t%s\t%s\n", //nolint:errcheck // best-effort CLI stdout write
				p.Name, p.Source, p.Version, p.InstalledAt.Format("2006-01-02"), p.InstallPath)
		}
		w.Flush() //nolint:errcheck // best-effort CLI stdout write

	case "remove":
		if len(args) < 2 {
			fmt.Fprintln(os.Stderr, "Usage: ion plugin remove <name>")
			os.Exit(1)
		}
		name := args[1]
		if err := plugins.Remove(name); err != nil {
			fmt.Fprintf(os.Stderr, "Error: %v\n", err)
			os.Exit(1)
		}
		fmt.Printf("Removed plugin %q\n", name)

	default:
		fmt.Fprintf(os.Stderr, "Unknown plugin subcommand: %s\n", args[0])
		os.Exit(1)
	}
}

// describeInstalled says what a new session gets from the plugin.
func describeInstalled(p plugins.InstalledPlugin) {
	fmt.Printf("  Path: %s\n", p.InstallPath)
	if skills, err := os.ReadDir(filepath.Join(p.InstallPath, "skills")); err == nil {
		var names []string
		for _, e := range skills {
			if e.IsDir() {
				names = append(names, e.Name())
			}
		}
		if len(names) > 0 {
			fmt.Printf("  Skills: %s\n", strings.Join(names, ", "))
		}
	}
	servers, err := p.McpServers()
	if err != nil {
		fmt.Printf("  MCP servers: cannot read them: %v\n", err)
	} else if len(servers) > 0 {
		names := make([]string, 0, len(servers))
		for name := range servers {
			names = append(names, name)
		}
		sort.Strings(names)
		fmt.Printf("  MCP servers: %s\n", strings.Join(names, ", "))
	}
	fmt.Println("New conversations load it; no restart needed.")
}
