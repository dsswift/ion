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

## [1.12.0](https://github.com/dsswift/ion/compare/engine-v1.11.0...engine-v1.12.0) (2026-05-08)

### Features

* **engine:** add system message injection for llm steering ([90100b2](https://github.com/dsswift/ion/commit/90100b2f1dac8790045f7028edbbb1d54763f773))

## [1.11.0](https://github.com/dsswift/ion/compare/engine-v1.10.0...engine-v1.11.0) (2026-05-07)

### Features

* **engine:** wire message_update hook for cli backend ([8eda00f](https://github.com/dsswift/ion/commit/8eda00f5084d752866a2a7463a4973f2629801ff))
* **engine:** tcp listen/dial via ION_SOCKET_PATH ([c3e0f23](https://github.com/dsswift/ion/commit/c3e0f23d4aa7dbeebcf45341e8950634793929c7))

### Bug Fixes

* **engine:** serialize extension stdin writes ([638c21f](https://github.com/dsswift/ion/commit/638c21fa110ee36c52ae6be643438bfaf368f756))
* **engine:** close leaked mcp conns on dispose race ([c2f94e0](https://github.com/dsswift/ion/commit/c2f94e095574f926f8105b0ece06127d8890752f))
* **engine:** add timeout to health endpoint ([c3c7685](https://github.com/dsswift/ion/commit/c3c76856a352e7eeb179b7694d369e6474c12d76))
* **engine:** default cli permission to bypassPermissions ([b88f475](https://github.com/dsswift/ion/commit/b88f4752a63fcfcd805ce6542968c7b17922f733))

## [1.10.0](https://github.com/dsswift/ion/compare/engine-v1.9.0...engine-v1.10.0) (2026-05-07)

### Features

* **engine:** add upgrade command ([aba5ff2](https://github.com/dsswift/ion/commit/aba5ff29baa01269f98a4465bfedbc0b816918ae))

## [1.9.0](https://github.com/dsswift/ion/compare/engine-v1.8.2...engine-v1.9.0) (2026-05-06)

### Features

* **engine:** extract agent registry into separate module ([1c9fa91](https://github.com/dsswift/ion/commit/1c9fa91a302e7d81cc9b223acf46bcd72914a0d5))
* **engine:** add compaction tests for tool results ([7fdf70c](https://github.com/dsswift/ion/commit/7fdf70c7575ed3f1eaed22f227004e5080ba7dd8))
* **engine:** wire plan mode sparse reminder ([e2aa77d](https://github.com/dsswift/ion/commit/e2aa77d4d39edad73e0326f11665bcc090f19436))

### Bug Fixes

* **engine:** correct event translation return value ([b91d0bf](https://github.com/dsswift/ion/commit/b91d0bf78849c06075cea9f1ca3c69417ee75f7f))

## [1.8.2](https://github.com/dsswift/ion/compare/engine-v1.8.1...engine-v1.8.2) (2026-05-03)

### Bug Fixes

* **engine:** use parent backend type for child agent dispatch #37 ([ee18f6a](https://github.com/dsswift/ion/commit/ee18f6adb610d4384e3c6ace42cf60ede64fddf2))

## [1.8.1](https://github.com/dsswift/ion/compare/engine-v1.8.0...engine-v1.8.1) (2026-05-03)

### Bug Fixes

* **engine:** prevent duplicate child events to parent ([04a1a92](https://github.com/dsswift/ion/commit/04a1a92d3f6c148c6ff1fb20f42a2aaed0435011))

## [1.8.0](https://github.com/dsswift/ion/compare/engine-v1.7.0...engine-v1.8.0) (2026-05-02)

### Features

* **engine:** add context window to status events ([1acb1d4](https://github.com/dsswift/ion/commit/1acb1d44e3fea1b0e5b49e1a97898c4af09a1091))
* **engine:** add tool stall detection and events ([bff2795](https://github.com/dsswift/ion/commit/bff27950a13e2cfe5244c96696ffe7ed0019778d))

## [1.7.0](https://github.com/dsswift/ion/compare/engine-v1.6.0...engine-v1.7.0) (2026-05-02)

### Features

* **engine:** add tool update streaming events ([bac72c0](https://github.com/dsswift/ion/commit/bac72c051941333fe3831ade1c5b11f28cd9f755))
* **engine:** #30 add cli turn lifecycle hooks ([f0fc264](https://github.com/dsswift/ion/commit/f0fc2642dd7b874aa1ac73d045f09d3764a5d0c9))

## [1.6.0](https://github.com/dsswift/ion/compare/engine-v1.5.1...engine-v1.6.0) (2026-05-02)

### Features

* **engine:** add extensionName to engine status for friendly display ([0c1886f](https://github.com/dsswift/ion/commit/0c1886ff661e891578a1bb507895ea6e3e7e086a))

## [1.5.1](https://github.com/dsswift/ion/compare/engine-v1.5.0...engine-v1.5.1) (2026-05-01)

## [1.5.0](https://github.com/dsswift/ion/compare/engine-v1.4.0...engine-v1.5.0) (2026-04-30)

### Features

* **engine:** add tool stall detection and events ([205e32d](https://github.com/dsswift/ion/commit/205e32d83dfb59c05a701d8446403db18b3daaca))

### Bug Fixes

* **ci:** resolve all 4 PR check failures ([d20b5a3](https://github.com/dsswift/ion/commit/d20b5a3b9cc72dd827c1cb605eb26baac03818b3))

## [1.4.0](https://github.com/dsswift/ion/compare/engine-v1.3.0...engine-v1.4.0) (2026-04-30)

### Features

* **engine:** add health command + bump go to 1.25 ([721aea4](https://github.com/dsswift/ion/commit/721aea4dab49e71c167eff8f60230f1432581444))
* **engine:** add broadcast queuing with backpressure ([e9bd003](https://github.com/dsswift/ion/commit/e9bd003d892fef06c0c035e554796fe6c69ed9e7))

### Bug Fixes

* **engine:** prevent stuck runs from wedged tools ([4b46a5b](https://github.com/dsswift/ion/commit/4b46a5b7ebbf5b91a24213c40f9da3d62d186700))

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

