# Security Policy

## Reporting a vulnerability

Report suspected vulnerabilities privately through
[GitHub Security Advisories](https://github.com/dsswift/ion/security/advisories/new).
Do not open a public issue for a security report.

Include what you can: the affected component (engine, desktop, iOS, relay, or an SDK surface), a
reproduction path, and the impact you believe it has. Reports are triaged as they arrive, and you
will get a response in the advisory thread. If a report is accepted, the fix ships in a regular
release and the advisory is published once the fix is available.

## Supported versions

The latest release of each component is supported. Fixes are not backported to older releases;
update to the current release to receive security fixes.

## Scope

Ion runs on your machines. There is no hosted service behind it: no account system, no vendor API,
no collection endpoint. Reports about Ion-operated infrastructure are therefore out of scope,
because there is none. In scope is everything in this repository: the engine and its wire protocol,
the credential resolver and identity broker, the permission engine, the sandbox integration, secret
redaction, the desktop and iOS clients, the relay, and the extension SDK.

## Security model

The engine ships opt-in security primitives rather than a fixed policy: a permission engine,
dangerous-command detection, OS-level sandboxing (Seatbelt on macOS, bwrap on Linux), secret
redaction, audit logging, and an enterprise configuration layer that seals security floors so they
cannot be loosened from below. The full model, including defaults and configuration, is documented
in [docs/security/](docs/security/index.md) and [docs/enterprise/](docs/enterprise/index.md).

Two properties worth knowing before you report:

- **Extensions never hold operator credentials.** The engine owns the OIDC identity, mints
  per-scope tokens, and sets the `Authorization` header itself; any header an extension supplies is
  overwritten. A report showing extension code obtaining a raw operator token is always in scope
  and always high severity.
- **Telemetry is off by default** and exports only to operator-configured targets (file, HTTP
  endpoint, or OpenTelemetry collector). There is no default destination.
