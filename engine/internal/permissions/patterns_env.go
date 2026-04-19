package permissions

import "os"

// envLookupReal is the production implementation of envLookup.
func envLookupReal(key string) string {
	return os.Getenv(key)
}
