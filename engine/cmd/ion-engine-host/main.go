// Command ion-engine-host launches the Ion engine daemon on Windows without
// ever putting a console window on the user's screen.
//
// Why this binary exists
// ----------------------
// Task Scheduler always allocates a console for a console-subsystem image,
// and offers no way to suppress it: <Hidden>true</Hidden> hides the task's
// row in the Task Scheduler UI, not the window its action opens. On a
// Windows 11 machine whose default terminal is Windows Terminal, that
// console is a ConPTY whose visible window belongs to WindowsTerminal.exe,
// while the window handle the daemon itself can reach through
// GetConsoleWindow() belongs to the OpenConsole.exe pseudoconsole host. A
// process therefore cannot hide the window the user is actually looking at:
// hiding its own console window succeeds and changes nothing on screen.
//
// The only way to not show a window is to never create one. This host is
// linked for the GUI subsystem (-H windowsgui), so Windows allocates no
// console for it at all, and it starts the engine with CREATE_NO_WINDOW so
// the engine gets a console with no window either. Nothing is ever shown and
// nothing the user can close is attached to the daemon.
//
// It stays alive for as long as the engine does and exits with the engine's
// exit code, so the task's RestartOnFailure still supervises the daemon and
// `schtasks /End` still stops it.
package main

import "os"

func main() {
	// argv is the engine command line: the path to ion.exe followed by the
	// arguments it should run with (`serve --supervised`). Passing it
	// explicitly rather than resolving a sibling keeps what runs visible in
	// the registered task definition, where an operator can read it.
	if len(os.Args) < 2 {
		os.Exit(usage())
	}
	os.Exit(runHost(os.Args[1], os.Args[2:]))
}
