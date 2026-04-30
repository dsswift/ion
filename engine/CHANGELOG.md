# Changelog

All notable changes to the engine will be documented here. This file is
maintained by the release pipeline; do not edit by hand.

## 1.0.0 - 2026-04-28

Initial 1.0.0 baseline. Establishes the Ion Engine as a headless,
multi-provider LLM runtime: single static Go binary, Unix-socket protocol,
55 extension hooks, 14 core tools, 16 LLM providers, and built-in security
primitives (sandboxing, secret redaction, dangerous command blocking,
permission engine).

Subsequent versions will be auto-generated from conventional commit messages.

## [1.3.0](https://github.com/dsswift/ion/compare/engine-v1.2.0...engine-v1.3.0) (2026-04-30)

### Features

* **engine:** add abort_agent command with subtree support ([cccce72](https://github.com/dsswift/ion/commit/cccce72a4b47b3c25188d408bb63d2cbc15b14af))
* **engine:** add concurrent session isolation ([dd76371](https://github.com/dsswift/ion/commit/dd76371203e63422256ab050f7d012ffcb0a9115))

## [1.2.0](https://github.com/dsswift/ion/compare/engine-v1.1.0...engine-v1.2.0) (2026-04-29)

### Features

* **engine:** add pidfile support for desktop server ([3c94b16](https://github.com/dsswift/ion/commit/3c94b16e65b759720757ba8930849da9b8627b94))

## [1.1.0](https://github.com/dsswift/ion/compare/engine-v1.0.3...engine-v1.1.0) (2026-04-29)

### Features

* **engine:** make resource limits unlimited by default ([8c063d8](https://github.com/dsswift/ion/commit/8c063d88f235eec1c9b01a9f01fdab2568ff3c55))

## [1.0.3](https://github.com/dsswift/ion/compare/engine-v1.0.2...engine-v1.0.3) (2026-04-29)

### Bug Fixes

* **engine:** populate extensiondir in hook context ([1d36c16](https://github.com/dsswift/ion/commit/1d36c16a5384eda3fb0e3e95d10e9195dfd2279d))

## [1.0.2](https://github.com/dsswift/ion/compare/engine-v1.0.1...engine-v1.0.2) (2026-04-28)

### Bug Fixes

* **engine:** populate extensiondir in hook context ([4cdbc15](https://github.com/dsswift/ion/commit/4cdbc15bd6884ec2f90142a726ccd4c77bcdfdf8))

## [1.0.1](https://github.com/dsswift/ion/compare/engine-v1.0.0...engine-v1.0.1) (2026-04-28)

### Bug Fixes

* **engine:** stop infinite recursion in logHookErr ([01dbc67](https://github.com/dsswift/ion/commit/01dbc67284a8ef7a4886471e234c9f2c5ab3fa64))

