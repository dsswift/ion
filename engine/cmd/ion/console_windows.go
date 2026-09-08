//go:build windows

package main

import "golang.org/x/sys/windows"

var (
	modKernel32          = windows.NewLazySystemDLL("kernel32.dll")
	modUser32            = windows.NewLazySystemDLL("user32.dll")
	procGetConsoleWindow = modKernel32.NewProc("GetConsoleWindow")
	procShowWindow       = modUser32.NewProc("ShowWindow")
	procIsWindowVisible  = modUser32.NewProc("IsWindowVisible")
)

// swHide is the SW_HIDE constant for ShowWindow: hide the window and
// activate another window.
const swHide = 0

// Console outcomes, reported by hideOwnConsole so the log says what actually
// happened on screen rather than that a call was made.
const (
	consoleNone         = "no console attached"
	consoleHidden       = "console window hidden"
	consoleNotOwnWindow = "console window was already invisible; the visible terminal belongs to another process and cannot be hidden from here"
)

// hideOwnConsole hides the process's own console window when there is one to
// hide, and reports which of the three outcomes occurred.
//
// The distinction matters because hiding only works under the legacy console
// host. Where the default terminal is Windows Terminal, the process is
// attached to a ConPTY: GetConsoleWindow() returns a window owned by the
// OpenConsole.exe pseudoconsole host, which is already invisible, while the
// window the user sees is a tab owned by WindowsTerminal.exe. Hiding the
// pseudoconsole window succeeds and changes nothing on screen — which is why
// the supervised daemon is launched by ion-engine-host.exe instead, so that
// no console is ever created. This call remains the belt for anyone running
// `ion serve --supervised` by hand under the legacy console host.
func hideOwnConsole() (string, error) {
	hwnd, _, _ := procGetConsoleWindow.Call()
	if hwnd == 0 {
		return consoleNone, nil
	}
	visible, _, _ := procIsWindowVisible.Call(hwnd)
	_, _, _ = procShowWindow.Call(hwnd, swHide)
	if visible == 0 {
		return consoleNotOwnWindow, nil
	}
	return consoleHidden, nil
}
