// Engine-scoped extension hosts: the `extensionHosts` block of engine.json.
//
// An extension whose manifest declares scope "engine" or "both" runs one host
// for the engine process instead of (or beside) its per-conversation hosts.
// That host's schedules and webhooks fire into headless sessions the engine
// mints per fire, each attributed to the configured run-as principal. See
// docs/configuration/extension-hosts.md.

package types

import (
	"errors"
	"fmt"
	"time"
)

// ExtensionHostsConfig lists the engine-scoped extensions and how their
// headless sessions are built.
type ExtensionHostsConfig struct {
	// Extensions are the extension paths to load as engine hosts. Each must
	// resolve like a session extension path; a manifest scope of "session"
	// (the default) is refused at boot because such an extension has no
	// engine half.
	Extensions []string `json:"extensions"`
	// RunAs is the principal every headless session acts as. Nil leaves the
	// sessions unattributed: no partition, no per-principal tool policy, and
	// any downstream call that needs an identity fails and logs.
	RunAs *RunAsPrincipalConfig `json:"runAs,omitempty"`
	// Session is the template every headless session starts from.
	Session HeadlessSessionConfig `json:"session"`
}

// RunAsPrincipalMode selects where the run-as principal comes from.
type RunAsPrincipalMode string

const (
	// RunAsModePrincipal uses the literal principal in RunAsPrincipalConfig.
	RunAsModePrincipal RunAsPrincipalMode = "principal"
	// RunAsModeWorkload uses the engine's own verified workload identity
	// (auth.identityProvider must name an oauth entry with machineIdentity).
	RunAsModeWorkload RunAsPrincipalMode = "workload"
)

// RunAsPrincipalConfig is who a headless session acts as.
type RunAsPrincipalConfig struct {
	Mode RunAsPrincipalMode `json:"mode"`
	// Principal is the literal identity for RunAsModePrincipal. Subject and
	// Provider are required; Kind defaults to "operator".
	Principal *SessionPrincipal `json:"principal,omitempty"`
}

// HeadlessSessionConfig is the template a headless session is minted from.
type HeadlessSessionConfig struct {
	// WorkingDirectory is required: every session has one.
	WorkingDirectory string `json:"workingDirectory"`
	// Model overrides the engine default model for headless runs.
	Model string `json:"model,omitempty"`
	// Extensions are the session-scoped extensions loaded into each headless
	// session. Empty means the same list as ExtensionHostsConfig.Extensions.
	Extensions []string `json:"extensions,omitempty"`
	// ProfileID names an engine profile the session reports as its own.
	ProfileID string `json:"profileId,omitempty"`
	// IdleReleaseMs is how long a headless session may stay quiescent after
	// its fire before the engine releases it. Zero means DefaultHeadlessIdleRelease.
	IdleReleaseMs int64 `json:"idleReleaseMs,omitempty"`
}

// DefaultHeadlessIdleRelease is the quiescence window of a headless session
// when the template sets none. Short on purpose: nothing will prompt it again.
const DefaultHeadlessIdleRelease = time.Minute

// IdleRelease returns the headless quiescence window.
func (c *HeadlessSessionConfig) IdleRelease() time.Duration {
	if c == nil || c.IdleReleaseMs <= 0 {
		return DefaultHeadlessIdleRelease
	}
	return time.Duration(c.IdleReleaseMs) * time.Millisecond
}

// SessionExtensions resolves the extension list a headless session loads.
func (c *ExtensionHostsConfig) SessionExtensions() []string {
	if c == nil {
		return nil
	}
	if len(c.Session.Extensions) > 0 {
		return append([]string(nil), c.Session.Extensions...)
	}
	return append([]string(nil), c.Extensions...)
}

// Validate checks the block for the mistakes a boot cannot recover from.
func (c *ExtensionHostsConfig) Validate() error {
	if c == nil {
		return nil
	}
	var errs []error
	if len(c.Extensions) == 0 {
		errs = append(errs, errors.New("extensionHosts.extensions is empty"))
	}
	for i, path := range c.Extensions {
		if path == "" {
			errs = append(errs, fmt.Errorf("extensionHosts.extensions[%d] is empty", i))
		}
	}
	if c.Session.WorkingDirectory == "" {
		errs = append(errs, errors.New("extensionHosts.session.workingDirectory is required"))
	}
	if c.Session.IdleReleaseMs < 0 {
		errs = append(errs, errors.New("extensionHosts.session.idleReleaseMs must not be negative"))
	}
	if err := c.RunAs.Validate(); err != nil {
		errs = append(errs, err)
	}
	return errors.Join(errs...)
}

// Validate checks the run-as block. Nil is allowed (unattributed sessions).
func (r *RunAsPrincipalConfig) Validate() error {
	if r == nil {
		return nil
	}
	switch r.Mode {
	case RunAsModePrincipal:
		if r.Principal == nil {
			return errors.New("extensionHosts.runAs.principal is required for mode principal")
		}
		if r.Principal.Subject == "" {
			return errors.New("extensionHosts.runAs.principal.subject is required")
		}
		if r.Principal.Provider == "" {
			return errors.New("extensionHosts.runAs.principal.provider is required")
		}
		return nil
	case RunAsModeWorkload:
		if r.Principal != nil {
			return errors.New("extensionHosts.runAs.principal is not used in mode workload")
		}
		return nil
	default:
		return fmt.Errorf("extensionHosts.runAs.mode must be principal or workload; got %q", r.Mode)
	}
}
