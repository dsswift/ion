# Changelog

All notable changes to the iOS app will be documented here. This file is
maintained by the release pipeline; do not edit by hand.

## 1.0.0 - 2026-04-28

Initial 1.0.0 baseline. Reference iOS client for Ion Engine, connecting
through the relay to access remote engine instances.

Subsequent versions will be auto-generated from conventional commit messages.

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

### Features

* **engine:** add tool stall detection and events ([205e32d](https://github.com/dsswift/ion/commit/205e32d83dfb59c05a701d8446403db18b3daaca))

