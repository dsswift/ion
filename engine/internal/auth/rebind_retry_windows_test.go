//go:build windows

package auth

import "time"

// windowsRebindRetryBudget: see TestStartPKCEFlow_CancelReleasesPortImmediately's
// doc comment for why Windows alone tolerates a short bounded wait here.
const windowsRebindRetryBudget = 500 * time.Millisecond
