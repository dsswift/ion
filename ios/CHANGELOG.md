# Changelog

All notable changes to the iOS app will be documented here. This file is
maintained by the release pipeline; do not edit by hand.

## 1.0.0 - 2026-04-28

Initial 1.0.0 baseline. Reference iOS client for Ion Engine, connecting
through the relay to access remote engine instances.

Subsequent versions will be auto-generated from conventional commit messages.

## [1.15.1](https://github.com/dsswift/ion/compare/ios-v1.15.0...ios-v1.15.1) (2026-05-12)

### Bug Fixes

* **ios:** raise WebSocket maximumMessageSize to 16 MiB ([066ec8a](https://github.com/dsswift/ion/commit/066ec8aa6d423ab251a1d1dad1a9795de4070782))
* **ios:** remove redundant permission badge from tab rows ([8468566](https://github.com/dsswift/ion/commit/8468566326a4d77ab68030642f7f6d86cc97c138))

## [1.15.0](https://github.com/dsswift/ion/compare/ios-v1.14.2...ios-v1.15.0) (2026-05-12)

### Features

* **ios:** multi-desktop pairing, layout cache, graceful reconnect ([d725bc6](https://github.com/dsswift/ion/commit/d725bc6c251964fb5fe4fd306cb1d433e8bb709e))
* **ios:** add on-device diagnostic log for wireless debugging ([7412a4a](https://github.com/dsswift/ion/commit/7412a4aa41aff10171134b2ca44e20eb79c530cb))
* **ios:** add design system and app-wide visual polish ([e049d37](https://github.com/dsswift/ion/commit/e049d37c37df03e49fbd4e7e34327cbc8b158f8e))

### Bug Fixes

* **ios:** prevent relay_config from corrupting lan-direct devices ([28b82c8](https://github.com/dsswift/ion/commit/28b82c8f52f800eb9245809e825310d10359dfc5))
* **ios:** flatten auth to single iterator, add LAN diagnostic logging ([0548d3f](https://github.com/dsswift/ion/commit/0548d3fa161b43e2f3aeffba13a4694b76154624))

## [1.14.2](https://github.com/dsswift/ion/compare/ios-v1.14.1...ios-v1.14.2) (2026-05-11)

### Bug Fixes

* **ios:** keep transport alive on peer disconnect ([637088a](https://github.com/dsswift/ion/commit/637088a8d2440efd7e1c68205839ba3cb445c39f))
* **ios:** resolve legacy udid before ios-deploy install ([ef05a29](https://github.com/dsswift/ion/commit/ef05a29bb34def19ca92c94485e39cf63b30d764))

## [1.14.1](https://github.com/dsswift/ion/compare/ios-v1.14.0...ios-v1.14.1) (2026-05-11)

## [1.14.0](https://github.com/dsswift/ion/compare/ios-v1.13.2...ios-v1.14.0) (2026-05-10)

### Features

* **engine:** add system hint to engine config ([79fa965](https://github.com/dsswift/ion/commit/79fa965e4a32ce4528ace67b32d60502ab4f2082))

## [1.13.2](https://github.com/dsswift/ion/compare/ios-v1.13.1...ios-v1.13.2) (2026-05-10)

### Bug Fixes

* **ios:** remove stale isConnected guard in startLANWithAuth ([20874d5](https://github.com/dsswift/ion/commit/20874d58572be0b5ab67647c0661c9471447154d))

## [1.13.1](https://github.com/dsswift/ion/compare/ios-v1.13.0...ios-v1.13.1) (2026-05-09)

### Bug Fixes

* **ios:** dispatch BonjourBrowser calls to main actor to fix crash ([7544ece](https://github.com/dsswift/ion/commit/7544ecefd636d083f699429909389d313d5e42ab))
* **ios:** skip Bonjour restart on first path monitor callback and when LAN connected ([bc49a39](https://github.com/dsswift/ion/commit/bc49a39e039f086e0da47215fa8cfb1f8c0ba94a))
* **ios:** send sync after Bonjour LAN auth; add auth timeout; fix install script ([7c46580](https://github.com/dsswift/ion/commit/7c465806431f3e21e7badcfd50f1df2b29191d2f))
* **ios:** guard against lan.disconnect() firing after auth timeout is cancelled ([28d7192](https://github.com/dsswift/ion/commit/28d7192b3fb5da59c009abf8e6f18c91ae582b15))
* **ios:** skip cleanup on cancelled tasks to prevent connect/disconnect loop ([c82bdca](https://github.com/dsswift/ion/commit/c82bdca3a02aea1b8ad11e0487dff4bf61cb140d))
* **ios:** set isConnected on first message; replace seqLock with OSAllocatedUnfairLock ([12dd811](https://github.com/dsswift/ion/commit/12dd811efdff9e81c7dce5e0dc009dc8ab8773cc))
* **ios:** fix reconnect after screen lock and stuck connecting state ([309e30e](https://github.com/dsswift/ion/commit/309e30ef75ef2776a87fadfe28e05ebbaf4c5996))

## [1.13.0](https://github.com/dsswift/ion/compare/ios-v1.12.1...ios-v1.13.0) (2026-05-08)

### Features

* **ios:** add assistant message grouping for copy ([fb5239c](https://github.com/dsswift/ion/commit/fb5239cb4c89c04c3b7d96ff7fe3dff72d725710))
* **ios:** filter internal messages from session ([9f704ad](https://github.com/dsswift/ion/commit/9f704ada72102ad7e6916a051295c2705b6e1830))
* **ios:** add scroll-to-bottom button in conversation ([d3d6aba](https://github.com/dsswift/ion/commit/d3d6aba928e4d044768851b4bd0dfb68ecb38bed))

### Bug Fixes

* **ios:** use compact preview for assistant context menu ([dd663b8](https://github.com/dsswift/ion/commit/dd663b83145bb3470f7fd608984cf4ae89b19d59))

## [1.12.1](https://github.com/dsswift/ion/compare/ios-v1.12.0...ios-v1.12.1) (2026-05-07)

### Bug Fixes

* **ios:** track spm package.resolved for xcode cloud ([9b8eb8e](https://github.com/dsswift/ion/commit/9b8eb8ea2d76953a1e0a5cb16b1f3e4fa543a535))

## [1.12.0](https://github.com/dsswift/ion/compare/ios-v1.11.0...ios-v1.12.0) (2026-05-07)

### Features

* **ios:** add crash reporting and app delegate ([27ba7b7](https://github.com/dsswift/ion/commit/27ba7b705080d127c796b63fa22192bf4760cc25))

## [1.11.0](https://github.com/dsswift/ion/compare/ios-v1.10.0...ios-v1.11.0) (2026-05-06)

### Features

* **ios:** add activity indicator to conversation view ([1794e80](https://github.com/dsswift/ion/commit/1794e80150c46d95c7a4cc0d2796a7c69bcf9aa8))

### Bug Fixes

* **ios:** preserve tab running state after message end ([73e2e88](https://github.com/dsswift/ion/commit/73e2e88fe19deaf6c7065f780f41b13dbd06cc40))

## [1.10.0](https://github.com/dsswift/ion/compare/ios-v1.9.0...ios-v1.10.0) (2026-05-06)

### Features

* **ios:** add copy path context menu to file explorer ([5ae1ded](https://github.com/dsswift/ion/commit/5ae1dedff645793df351759598e108ec1b4bab95))
* **ios:** add table support to markdown rendering ([450267b](https://github.com/dsswift/ion/commit/450267b4676d58e988d2ff458bd41ba0c364a489))
* **ios:** extract message bubble into reusable component ([68d7e1b](https://github.com/dsswift/ion/commit/68d7e1b965dbe6a34507df4ba40f4cd5fe0b66d3))
* **ios:** add tool grouping for conversation display ([d019979](https://github.com/dsswift/ion/commit/d0199793fac86ad0b3b6654c9ef05e939efaa75a))

## [1.9.0](https://github.com/dsswift/ion/compare/ios-v1.8.0...ios-v1.9.0) (2026-05-06)

### Features

* **ios:** use block-based markdown rendering ([0911664](https://github.com/dsswift/ion/commit/0911664e45c451cf24404a5a9ba24ff2239dea3e))
* **ios:** add slash command autocomplete ([454c1c9](https://github.com/dsswift/ion/commit/454c1c989a53d84828156f6b676cfe151029d7f4))
* **ios:** add tab renaming via context menu ([df4b65f](https://github.com/dsswift/ion/commit/df4b65f92c38aebee76272b7523caf5b8e429ebd))
* **ios:** add pink border to messages starting with '! ' ([2e9c83f](https://github.com/dsswift/ion/commit/2e9c83f313a7cc8466cb97931ac49f6c1bc522f2))
* **ios:** add markdown rendering to user message bubbles ([c540117](https://github.com/dsswift/ion/commit/c54011775ee1ddcaf1cdb98b2356e282351f6432))

## [1.8.0](https://github.com/dsswift/ion/compare/ios-v1.7.0...ios-v1.8.0) (2026-05-05)

### Features

* **ios:** add show hidden files toggle to file explorer ([07bcae5](https://github.com/dsswift/ion/commit/07bcae52ae633e061a5d76303bb0e58e6f856042))

## [1.7.0](https://github.com/dsswift/ion/compare/ios-v1.6.0...ios-v1.7.0) (2026-05-05)

### Features

* **ios:** add file explorer ui and file editing ([877844c](https://github.com/dsswift/ion/commit/877844ce779add00c755a1ea91e42f67220a5439))
* **ios:** add connection quality monitoring ([e958259](https://github.com/dsswift/ion/commit/e9582593213cf11982ebbd6d91dcf2b7f24b2da5))
* **ios:** enhance file editor with improved ui ([9ccdaef](https://github.com/dsswift/ion/commit/9ccdaef2aad664db4b612bec81590f5e07cf0577))
* **ios:** update tab list view ([28bd571](https://github.com/dsswift/ion/commit/28bd57128db6403a7200c04b7c7f1b2bfcd245bf))
* **ios:** improve app lifecycle handling ([7f19091](https://github.com/dsswift/ion/commit/7f190911dd6a9d3712065a793c99d5e4ba697183))

### Bug Fixes

* **ios:** clean accidental transcription from comment ([264c249](https://github.com/dsswift/ion/commit/264c24987ee375fb2cbc31a1501334b1b1c95633))
* **ios:** use devicectl for device detection and availability ([6d7bcf3](https://github.com/dsswift/ion/commit/6d7bcf312561c9e321a5a480300d5708977e3a6d))
* **ios:** fallback to ios-deploy when tunnel unavailable ([4a04c5e](https://github.com/dsswift/ion/commit/4a04c5ef3fa057926e8e58548a4df55927603782))
* **ios:** clear stale plan card when new task starts ([c80f1a4](https://github.com/dsswift/ion/commit/c80f1a486e082e2ec1120d1d33a044727ac6f947))

## [1.6.0](https://github.com/dsswift/ion/compare/ios-v1.5.0...ios-v1.6.0) (2026-05-03)

### Features

* **ios:** add git integration ui and models ([66d6bce](https://github.com/dsswift/ion/commit/66d6bcea892d03a1558651c7a0b38f78453a70c6))

## [1.5.0](https://github.com/dsswift/ion/compare/ios-v1.4.0...ios-v1.5.0) (2026-05-02)

### Features

* **ios:** add model selection to engine ui ([a0af220](https://github.com/dsswift/ion/commit/a0af2205da713960ebe061fc119fb940cb50937e))
* **ios:** add full-screen plan viewer with markdown ([20181a8](https://github.com/dsswift/ion/commit/20181a829e1e95ec8a10a87c744d51c9acd72550))
* **ios:** add move to group context menu ([a5b3626](https://github.com/dsswift/ion/commit/a5b362685757df379cb150bd686c41ff425e77ec))

### Bug Fixes

* **ios:** auto-navigate only for locally created tabs ([96e941b](https://github.com/dsswift/ion/commit/96e941bb0dd5ba4ae76f28592108ee30350c0a40))

## [1.4.0](https://github.com/dsswift/ion/compare/ios-v1.3.0...ios-v1.4.0) (2026-05-02)

### Features

* **ios:** add tab group mode configuration ([e9b63ee](https://github.com/dsswift/ion/commit/e9b63ee5eadc80cb03846bafdb56eb011d58477c))
* **ios:** add tool streaming event handlers ([58a5b05](https://github.com/dsswift/ion/commit/58a5b05fa34d3457608b2613db8b0f97a36cdeeb))

## [1.3.0](https://github.com/dsswift/ion/compare/ios-v1.2.0...ios-v1.3.0) (2026-05-02)

### Features

* **ios:** improve engine viewer and reconnect ([6841e26](https://github.com/dsswift/ion/commit/6841e269de9b539724835437bbb5621070116efd))

## [1.2.0](https://github.com/dsswift/ion/compare/ios-v1.1.0...ios-v1.2.0) (2026-05-01)

### Features

* **ios:** build engine viewer in remote app ([2ac41cd](https://github.com/dsswift/ion/commit/2ac41cdfeed87927e94cd27025d3969faa7fcd00))

## [1.1.0](https://github.com/dsswift/ion/compare/ios-v1.0.0...ios-v1.1.0) (2026-04-30)

Version bump only (cross-component release).

