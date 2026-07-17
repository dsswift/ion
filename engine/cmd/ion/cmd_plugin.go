package main

import (
	"fmt"
	"os"
	"text/tabwriter"

	"github.com/dsswift/ion/engine/internal/plugins"
)

func cmdPlugin(args []string) {
	if len(args) == 0 {
		fmt.Fprintln(os.Stderr, "Usage: ion plugin <install|list|remove> [args]")
		os.Exit(1)
	}
	switch args[0] {
	case "install":
		if len(args) < 2 {
			fmt.Fprintln(os.Stderr, "Usage: ion plugin install <owner/repo>")
			os.Exit(1)
		}
		source := args[1]
		p, err := plugins.Install(source, func(msg string) {
			fmt.Println(msg)
		})
		if err != nil {
			fmt.Fprintf(os.Stderr, "Error: %v\n", err)
			os.Exit(1)
		}
		fmt.Printf("Installed %s@%s (%s)\n", p.Name, p.Source, p.Version)

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
		_, _ = fmt.Fprintln(w, "NAME\tSOURCE\tVERSION\tINSTALLED")
		for _, p := range installed {
			_, _ = fmt.Fprintf(w, "%s\t%s\t%s\t%s\n",
				p.Name, p.Source, p.Version, p.InstalledAt.Format("2006-01-02"))
		}
		_ = w.Flush()

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
