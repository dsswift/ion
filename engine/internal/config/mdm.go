package config

// LoadMDMConfig loads managed device configuration from the platform-appropriate
// source. Returns nil if no MDM configuration is present.
//
// Platform sources:
//   - macOS:   /Library/Managed Preferences/com.ion.engine.plist
//   - Linux:   /etc/ion-engine/managed-settings.json + /etc/ion-engine/managed-settings.d/*.json
//   - Windows: HKLM\SOFTWARE\Policies\IonEngine registry key
func LoadMDMConfig() map[string]interface{} {
	return loadPlatformMDM()
}
