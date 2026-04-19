//go:build !windows && !darwin && !linux

package config

func loadPlatformMDM() map[string]interface{} {
	return nil
}
