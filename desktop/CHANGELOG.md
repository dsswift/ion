# Changelog

All notable changes to the desktop app will be documented here. This file is
maintained by the release pipeline; do not edit by hand.

## 1.0.0 - 2026-04-28

Initial 1.0.0 baseline. Reference Electron desktop client for Ion Engine.
Demonstrates the engine's daemon architecture and multi-client broadcast.

Subsequent versions will be auto-generated from conventional commit messages.

## [1.16.0](https://github.com/dsswift/ion/compare/desktop-v1.15.3...desktop-v1.16.0) (2026-05-10)

### Features

* **desktop:** add copy commit message to context menu ([68e98df](https://github.com/dsswift/ion/commit/68e98dfadefb899e2456af7ff659ffcd804c39b1))

### Bug Fixes

* **desktop:** fix file explorer initial load ([d416079](https://github.com/dsswift/ion/commit/d4160799f32eb3bf561eb695312a215493645f20))

## [1.15.3](https://github.com/dsswift/ion/compare/desktop-v1.15.2...desktop-v1.15.3) (2026-05-09)

### Bug Fixes

* **desktop:** fix _getLanConnectionForDevice to return rekeyed device.id ([ff30cc8](https://github.com/dsswift/ion/commit/ff30cc81220c42541d81389b6fe636be074469de))

## [1.15.2](https://github.com/dsswift/ion/compare/desktop-v1.15.1...desktop-v1.15.2) (2026-05-09)

Dependency updates only.

## [1.15.1](https://github.com/dsswift/ion/compare/desktop-v1.15.0...desktop-v1.15.1) (2026-05-08)

Dependency updates only.

## [1.15.0](https://github.com/dsswift/ion/compare/desktop-v1.14.0...desktop-v1.15.0) (2026-05-08)

### Features

* **desktop:** add error boundary to conversation views ([2f5a217](https://github.com/dsswift/ion/commit/2f5a217bc270b426566a821259f5dc79f5fb52e1))
* **desktop:** filter internal messages from history ([4943f57](https://github.com/dsswift/ion/commit/4943f57490f848c689bbed5efad0465ccc41a36e))

### Bug Fixes

* **desktop:** handle null content in message components ([3bba731](https://github.com/dsswift/ion/commit/3bba7315fbefe7a4871c3dac91a2a6c15918cce9))

## [1.14.0](https://github.com/dsswift/ion/compare/desktop-v1.13.0...desktop-v1.14.0) (2026-05-07)

### Features

* **desktop:** remote engine connect and auto-reconnect ([cef1bc6](https://github.com/dsswift/ion/commit/cef1bc618e1d04f3806419c473fe7a2e07c2a809))

### Bug Fixes

* **desktop:** patch dev deps via npm audit fix ([8714235](https://github.com/dsswift/ion/commit/8714235c49a9a0d859e7c3034c320b3c91399a14))

## [1.13.0](https://github.com/dsswift/ion/compare/desktop-v1.12.0...desktop-v1.13.0) (2026-05-07)

### Features

* **desktop:** add auto-update functionality ([7868f03](https://github.com/dsswift/ion/commit/7868f03cd451d0583677d5a9d2a5ed7016a10d6d))
* **desktop:** add code signing and notarization ([d43fcd1](https://github.com/dsswift/ion/commit/d43fcd1f273cac715b78227e0c17f05a29f3afb9))
* **desktop:** add crash reporting ([ab14b4d](https://github.com/dsswift/ion/commit/ab14b4def7dc861b1c9b06a34c1c696ec7753311))

## [1.12.0](https://github.com/dsswift/ion/compare/desktop-v1.11.0...desktop-v1.12.0) (2026-05-06)

### Features

* **desktop:** auto-move tabs on remote mode change ([9e9b964](https://github.com/dsswift/ion/commit/9e9b964de5308eb18230f6c812362245dc5f572b))
* **desktop:** add discover_commands remote protocol ([7508c90](https://github.com/dsswift/ion/commit/7508c903ab2b9c968fd39660f719cd15e51a1ad8))
* **desktop:** add cmd+click links in terminal output ([7542aaa](https://github.com/dsswift/ion/commit/7542aaa5e629970b456f9c41fc129cbe813e499a))

## [1.11.0](https://github.com/dsswift/ion/compare/desktop-v1.10.0...desktop-v1.11.0) (2026-05-05)

### Features

* **desktop:** auto-switch plan to auto for slash commands ([a84b2b5](https://github.com/dsswift/ion/commit/a84b2b5869b681bfd8df167e7e167dfb7264537c))

### Bug Fixes

* **desktop:** kill orphaned dns-sd and disable safeStorage ([d506eae](https://github.com/dsswift/ion/commit/d506eaef5bb1f69826215ce5a327fdf0eb84108c))

## [1.10.0](https://github.com/dsswift/ion/compare/desktop-v1.9.3...desktop-v1.10.0) (2026-05-05)

### Features

* **desktop:** add slash command expansion support ([37b7f4c](https://github.com/dsswift/ion/commit/37b7f4c912dbbd2f9bc553f8e089880df69a3cc4))
* **desktop:** add file system operation handlers ([abcd40a](https://github.com/dsswift/ion/commit/abcd40a57bccd0e983a7b41e46e3a41fec11add3))

### Bug Fixes

* **desktop:** stop terminal flushing when remote disabled ([96f882a](https://github.com/dsswift/ion/commit/96f882aa8aa9e167bf210f0f95b6b24da409f585))
* **desktop:** clear failed auth on lan server stop ([393ec5d](https://github.com/dsswift/ion/commit/393ec5de1788fa5b8a86ba8f58a64cd6761ad9b6))
* **desktop:** clean up duplicate device map entries ([eb4ba73](https://github.com/dsswift/ion/commit/eb4ba7338f798d3851c7f323fc0ee694484dc85c))
* **desktop:** move relay event listener setup earlier ([fa01612](https://github.com/dsswift/ion/commit/fa01612ec7058235a38795ed4b09ce3a9be24c4d))

## [1.9.3](https://github.com/dsswift/ion/compare/desktop-v1.9.2...desktop-v1.9.3) (2026-05-04)

### Bug Fixes

* **desktop:** add vite/client types for css imports ([4a7e444](https://github.com/dsswift/ion/commit/4a7e444d89c0a46ea18e183eeb8a7620ba5985a6))

## [1.9.2](https://github.com/dsswift/ion/compare/desktop-v1.9.1...desktop-v1.9.2) (2026-05-04)

Dependency updates only.

## [1.9.1](https://github.com/dsswift/ion/compare/desktop-v1.9.0...desktop-v1.9.1) (2026-05-03)

Dependency updates only.

## [1.9.0](https://github.com/dsswift/ion/compare/desktop-v1.8.1...desktop-v1.9.0) (2026-05-03)

### Features

* **desktop:** add git operations command handlers ([91eb0eb](https://github.com/dsswift/ion/commit/91eb0eb0a84cb472bf55644aed94a45f721b3bb7))

## [1.8.1](https://github.com/dsswift/ion/compare/desktop-v1.8.0...desktop-v1.8.1) (2026-05-02)

### Bug Fixes

* **desktop:** exclude engine tabs from blank check ([ef95b45](https://github.com/dsswift/ion/commit/ef95b45dd92c126f7f8ba7a67cf519b32534eaa6))

## [1.8.0](https://github.com/dsswift/ion/compare/desktop-v1.7.0...desktop-v1.8.0) (2026-05-02)

### Features

* **desktop:** add context tooltip to engine footer ([3e64508](https://github.com/dsswift/ion/commit/3e64508e535fb271516aef86c64743d1d2c61f3a))
* **desktop:** add context window to status events ([d9b7504](https://github.com/dsswift/ion/commit/d9b7504ef640e0ae36410c84109c290d1ad54518))
* **desktop:** add tab recovery settings ui ([d8b4ac0](https://github.com/dsswift/ion/commit/d8b4ac06eff53811b11e440395b63f5af1ca3318))
* **desktop:** add tool stalled event handling ([5eb6b85](https://github.com/dsswift/ion/commit/5eb6b85c4aabbff7651ff01b24b8e600d95c7986))
* **desktop:** add model selection to engine prompt ([f2488e2](https://github.com/dsswift/ion/commit/f2488e23525b9a8ac67d80ae7bacedfaed29db5f))
* **desktop:** add model selector ui to engine footer ([48f2b7a](https://github.com/dsswift/ion/commit/48f2b7a0b11b45c52286f47f132183ec81901164))
* **desktop:** add engine model override remote command ([e3446b2](https://github.com/dsswift/ion/commit/e3446b29ea5d10e377f944f9996e0edcda9942bd))
* **desktop:** add mode-driven auto tab group movement ([26bdf2e](https://github.com/dsswift/ion/commit/26bdf2e04e02efbf96debf61635f818abee24aa9))
* **desktop:** add draggable settings dialog ([6d2df24](https://github.com/dsswift/ion/commit/6d2df24b6c477fab695618733794f60be0f259a2))

### Bug Fixes

* **desktop:** preserve active tab when creating new tabs ([1048a73](https://github.com/dsswift/ion/commit/1048a733cd2d4f7399e3519a191549ab57762e78))

## [1.7.0](https://github.com/dsswift/ion/compare/desktop-v1.6.0...desktop-v1.7.0) (2026-05-02)

### Features

* **desktop:** add tab group mode configuration ([babf2f6](https://github.com/dsswift/ion/commit/babf2f64189aecb5ea8586c4d8e9da745bccea0e))
* **desktop:** add tool streaming event handlers ([ba39ef5](https://github.com/dsswift/ion/commit/ba39ef550a9e1325ee6ea11de87313dac2feac63))

## [1.6.0](https://github.com/dsswift/ion/compare/desktop-v1.5.0...desktop-v1.6.0) (2026-05-02)

### Features

* **desktop:** expand engine bridge for ios ([4569575](https://github.com/dsswift/ion/commit/4569575b3237353613d3fe55312304ec668bbcea))

## [1.5.0](https://github.com/dsswift/ion/compare/desktop-v1.4.0...desktop-v1.5.0) (2026-05-01)

### Features

* **desktop:** expand engine remote bridge for ios ([65ac2d9](https://github.com/dsswift/ion/commit/65ac2d9dcd83ac13fcc0a3a6d7aed6dd29d5118a))

## [1.4.0](https://github.com/dsswift/ion/compare/desktop-v1.3.0...desktop-v1.4.0) (2026-04-30)

Version bump only (cross-component release).

## [1.3.0](https://github.com/dsswift/ion/compare/desktop-v1.2.0...desktop-v1.3.0) (2026-04-30)

### Features

* **desktop:** add auth backoff for lan server clients ([11116e8](https://github.com/dsswift/ion/commit/11116e802afb464cf0f49e6acd09296dc8fced59))
* **desktop:** add atomic writes and secret encryption ([f3364ab](https://github.com/dsswift/ion/commit/f3364abea56703acde23876736e6b30b2a931735))

## [1.2.0](https://github.com/dsswift/ion/compare/desktop-v1.1.0...desktop-v1.2.0) (2026-04-30)

### Features

* **desktop:** add subtree abort for engine agent ([3f744fc](https://github.com/dsswift/ion/commit/3f744fc206d789b8b881eb6c2c7a6867deca505c))
* **desktop:** add drag-to-reorder for engine tabs ([473aae8](https://github.com/dsswift/ion/commit/473aae82c9db89b3a9dc38dd56f96c35ed793ebc))

### Bug Fixes

* **desktop:** add watchdog to recover stuck tabs on abort ([1b0204c](https://github.com/dsswift/ion/commit/1b0204c8522daf854571683934bce6618df80ddf))

## [1.1.0](https://github.com/dsswift/ion/compare/desktop-v1.0.2...desktop-v1.1.0) (2026-04-29)

### Features

* **desktop:** bundle engine binary into desktop app ([dd1b467](https://github.com/dsswift/ion/commit/dd1b4676b7c835ca4f4ba667a3208c53c4285335))

## [1.0.2](https://github.com/dsswift/ion/compare/desktop-v1.0.1...desktop-v1.0.2) (2026-04-29)

### Bug Fixes

* **desktop:** add a couple missing store params and defaults ([5e8974a](https://github.com/dsswift/ion/commit/5e8974a0db108d2b00e59538096e0f24c3c5307a))

## [1.0.1](https://github.com/dsswift/ion/compare/desktop-v1.0.0...desktop-v1.0.1) (2026-04-29)

Version bump only (cross-component release).

