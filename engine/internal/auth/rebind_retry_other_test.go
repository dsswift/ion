//go:build !windows

package auth

import "time"

// windowsRebindRetryBudget is 0 off Windows: POSIX releases a closed
// listening socket's port synchronously, so the "no retry, no sleep"
// contract in TestStartPKCEFlow_CancelReleasesPortImmediately stays exact.
const windowsRebindRetryBudget = 0 * time.Millisecond
