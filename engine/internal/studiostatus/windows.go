package studiostatus

// WindowsDesktopGUID is the desktop installer's NSIS GUID (desktop/package.json,
// build.nsis.guid). The installer names the desktop's uninstall key after it.
const WindowsDesktopGUID = "7b1e4b3a-5d2c-4c7e-9f0a-2e6d8c1b4a53"

// WindowsUninstallKey is the desktop's uninstall key, under HKLM for a
// per-machine install or HKCU for a per-user one.
const WindowsUninstallKey = `SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\` + WindowsDesktopGUID
