# Changelog

All notable changes to the desktop app will be documented here. This file is
maintained by the release pipeline; do not edit by hand.

## 1.0.0 - 2026-04-28

Initial 1.0.0 baseline. Reference Electron desktop client for Ion Engine.
Demonstrates the engine's daemon architecture and multi-client broadcast.

Subsequent versions will be auto-generated from conventional commit messages.

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
* **ios:** add move to group context menu ([a5b3626](https://github.com/dsswift/ion/commit/a5b362685757df379cb150bd686c41ff425e77ec))
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

### Features

* **engine:** add tool stall detection and events ([205e32d](https://github.com/dsswift/ion/commit/205e32d83dfb59c05a701d8446403db18b3daaca))

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

### Bug Fixes

* **engine:** populate extensiondir in hook context ([1d36c16](https://github.com/dsswift/ion/commit/1d36c16a5384eda3fb0e3e95d10e9195dfd2279d))

