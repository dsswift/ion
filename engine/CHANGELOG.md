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

## [1.23.3](https://github.com/dsswift/ion/compare/engine-v1.23.2...engine-v1.23.3) (2026-05-22)

### Bug Fixes

* **engine:** tighten ext/send_prompt fallback path ([62be161](https://github.com/dsswift/ion/commit/62be161303b3017684e1541a5959f85f892cd39c))

## [1.23.2](https://github.com/dsswift/ion/compare/engine-v1.23.1...engine-v1.23.2) (2026-05-22)

### Bug Fixes

* **extension:** allow ext/send_prompt from non-hook contexts ([fe4e74b](https://github.com/dsswift/ion/commit/fe4e74b64c12ea1902153b896a9418179439d9a1))

## [1.23.1](https://github.com/dsswift/ion/compare/engine-v1.23.0...engine-v1.23.1) (2026-05-22)

### Bug Fixes

* **engine:** handle previously-ignored errors ([02f94ca](https://github.com/dsswift/ion/commit/02f94ca09de7658eba2d2fe943de0671b4aeb206))
* **engine:** widen flaky host_race_test bound to 15s ([b62b474](https://github.com/dsswift/ion/commit/b62b47435dab7841ffb22fdb396904a2c64b1bf6))

## [1.23.0](https://github.com/dsswift/ion/compare/engine-v1.22.2...engine-v1.23.0) (2026-05-22)

### Features

* **engine:** add ask user question tool ([ee3caa8](https://github.com/dsswift/ion/commit/ee3caa89d5a105ed8dbd2c8521d1c211eb3638e0))
* **engine:** enhance plan mode with amend and edit guidance ([ffab66b](https://github.com/dsswift/ion/commit/ffab66be5c0ec1dac930be359ecf9ebb93a0b332))
* **engine:** add plan mode abort capability ([b700e54](https://github.com/dsswift/ion/commit/b700e54582f4832f0d3dbb0058db3616262eb6f1))
* **engine:** make ask user question available in all modes ([f8688fd](https://github.com/dsswift/ion/commit/f8688fd5f51555bce2331bcefd0b481585562df5))
* **engine:** guarantee terminal snapshot on every agent termination path ([2ec0466](https://github.com/dsswift/ion/commit/2ec046605c400ddb4f54bdabff6efea1eb92982a))

### Bug Fixes

* **engine:** allow AskUserQuestion in plan mode tests ([659aa63](https://github.com/dsswift/ion/commit/659aa636a13cbd27308957f7b57b8932a32f46f1))

## [1.22.2](https://github.com/dsswift/ion/compare/engine-v1.22.1...engine-v1.22.2) (2026-05-20)

## [1.22.1](https://github.com/dsswift/ion/compare/engine-v1.22.0...engine-v1.22.1) (2026-05-19)

### Bug Fixes

* **engine:** unify context window and persist token cache ([5024b80](https://github.com/dsswift/ion/commit/5024b805f4b25dff5ea9dc9f6b5cb470d4a3a61c))

## [1.22.0](https://github.com/dsswift/ion/compare/engine-v1.21.0...engine-v1.22.0) (2026-05-19)

### Features

* **engine:** add provider model system with discovery ([e62f6e4](https://github.com/dsswift/ion/commit/e62f6e41c0a7da59d58a5f7478a5369bf3681608))

### Bug Fixes

* **engine:** add tool_call accumulation regression tests ([adae830](https://github.com/dsswift/ion/commit/adae83027881816cad3b875ea7a57806da66158f))

## [1.21.0](https://github.com/dsswift/ion/compare/engine-v1.20.1...engine-v1.21.0) (2026-05-18)

### Features

* **engine:** add plan mode support to CLI backend ([ec645fa](https://github.com/dsswift/ion/commit/ec645fa9e82470e2f21c9f8856b7e2ba8bfd6b92))

## [1.20.1](https://github.com/dsswift/ion/compare/engine-v1.20.0...engine-v1.20.1) (2026-05-18)

### Bug Fixes

* **engine:** fix agent tool_call accumulation for CLI backend ([6a130a2](https://github.com/dsswift/ion/commit/6a130a2d9a8aa35c107dcca66b1b1149229cd466))

## [1.20.0](https://github.com/dsswift/ion/compare/engine-v1.19.2...engine-v1.20.0) (2026-05-16)

### Features

* **engine:** add conversation migration command ([5f81aa3](https://github.com/dsswift/ion/commit/5f81aa376993f7bc79622ed49ba7b8aed49d11b3))

## [1.19.2](https://github.com/dsswift/ion/compare/engine-v1.19.1...engine-v1.19.2) (2026-05-16)

### Bug Fixes

* **engine:** add ca certificates to docker image ([2e2e792](https://github.com/dsswift/ion/commit/2e2e7925ec89864bc5fd44f31ab9558fe71cf312))

## [1.19.1](https://github.com/dsswift/ion/compare/engine-v1.19.0...engine-v1.19.1) (2026-05-16)

### Bug Fixes

* **engine:** prevent auto-compaction cascade loop ([1069e49](https://github.com/dsswift/ion/commit/1069e4981bea6f46d2f858bc7999e7b23079d41e))

## [1.19.0](https://github.com/dsswift/ion/compare/engine-v1.18.0...engine-v1.19.0) (2026-05-15)

### Features

* **engine:** add image attachments to protocol ([9d89acc](https://github.com/dsswift/ion/commit/9d89accf30cdd562df06679bb2787a0bd82abf01))

## [1.18.0](https://github.com/dsswift/ion/compare/engine-v1.17.0...engine-v1.18.0) (2026-05-15)

### Features

* **engine:** add http2 ping timeouts for stream stability ([ac15ba1](https://github.com/dsswift/ion/commit/ac15ba1a88769bf06298a17557512d30f0c78a6b))
* **engine:** add provider resilience with fallback chains ([1a4a68a](https://github.com/dsswift/ion/commit/1a4a68add7b83a69a284297006d3e3fff5613e96))

## [1.17.0](https://github.com/dsswift/ion/compare/engine-v1.16.2...engine-v1.17.0) (2026-05-14)

### Features

* **engine:** add broadcast state reconciliation ([dd094e9](https://github.com/dsswift/ion/commit/dd094e93e0e0d334e0c2d93192756b5e49a99809))
* **engine:** add SearchHistory tool for compacted context recovery ([156a8b8](https://github.com/dsswift/ion/commit/156a8b865b70b95f571936736c07fb70476bcd40))
* **engine:** preserve vision data in micro-compact ([52cbf94](https://github.com/dsswift/ion/commit/52cbf94aa0840adbf631d09963d200c85632fbcf))
* **engine:** add vision support to tool results ([c4d1175](https://github.com/dsswift/ion/commit/c4d11752b9a1eab29faa62a180ac9c474f66eebc))
* **engine:** enrich compacting event with summary metadata ([88b3fe2](https://github.com/dsswift/ion/commit/88b3fe2bbfc60f872fa7f565f4f8e9a341c10a0c))
* **engine:** forward compaction summary to engine tabs ([fdf7dde](https://github.com/dsswift/ion/commit/fdf7dde316408b9de7aaddec4c8205db2251bcaa))

## [1.16.2](https://github.com/dsswift/ion/compare/engine-v1.16.1...engine-v1.16.2) (2026-05-11)

### Bug Fixes

* **engine:** prevent tool goroutines from wedging indefinitely ([7b5c208](https://github.com/dsswift/ion/commit/7b5c20883eadc6ba404548c4309cee478ee90219))

## [1.16.1](https://github.com/dsswift/ion/compare/engine-v1.16.0...engine-v1.16.1) (2026-05-11)

### Bug Fixes

* **engine:** fix mcp stdio env inheritance and process reap ([2a24560](https://github.com/dsswift/ion/commit/2a245600f9178f8a2813842984984bac3fa32145))
* **engine:** fix mcp notification id violation ([ad4d5b4](https://github.com/dsswift/ion/commit/ad4d5b4f2adb3b2d47e25835f6078352e4f3117d))
* **engine:** mark mcp connection dead on timeout ([c6b26bc](https://github.com/dsswift/ion/commit/c6b26bc783188e81d6f7322b3b5dd2752353b6c0))
* **engine:** add close safety to mcp ws and http transports ([62ad8e6](https://github.com/dsswift/ion/commit/62ad8e63658afdaf207ef686b40303879a58b91f))
* **engine:** fix mcp calltool error masking ([6ea28ad](https://github.com/dsswift/ion/commit/6ea28ada4117d1e417ef7b84f0576e4aa9baf000))
* **engine:** singleton oauth store for mcp ([56b1b4c](https://github.com/dsswift/ion/commit/56b1b4cdab85bac699382ac52b4f563958fe4a2f))
* **engine:** implement mcp sse event stream reader ([7b17d93](https://github.com/dsswift/ion/commit/7b17d9397abac6d84b1a6248ed2874e40395cf54))

## [1.16.0](https://github.com/dsswift/ion/compare/engine-v1.15.0...engine-v1.16.0) (2026-05-11)

### Features

* **engine:** add web search mode configuration ([05b25f5](https://github.com/dsswift/ion/commit/05b25f524d7019af038ef146fe41ce72a1e498f5))

### Bug Fixes

* **engine:** cap cache_control blocks to anthropic limit of 4 ([bfabbd2](https://github.com/dsswift/ion/commit/bfabbd21c421ebf3627e62463c17124139bd91d9))

## [1.15.0](https://github.com/dsswift/ion/compare/engine-v1.14.0...engine-v1.15.0) (2026-05-11)

### Features

* **engine:** emit engine_events_dropped on queue recovery ([0ad1b11](https://github.com/dsswift/ion/commit/0ad1b11f549e62229f53c7c5b193d8bace43953a))
* **engine:** add TimeoutsConfig for configurable timeouts ([227decc](https://github.com/dsswift/ion/commit/227deccaa3a19a4077ca509c0479bd8cf7015b34))
* **engine:** read tool timeouts from config ([a0b7855](https://github.com/dsswift/ion/commit/a0b78559f547072b4b6f6ac9c68563844e2abc8d))
* **engine:** make mcp and extension timeouts configurable ([1bad1ea](https://github.com/dsswift/ion/commit/1bad1ea8a586773e72cfe83cccfe7a4cba69e6b3))
* **engine:** add timeout option to ext/call_tool rpc ([825150f](https://github.com/dsswift/ion/commit/825150f4d4476421e913bca3b2813b0e3da215af))
* **engine:** add --timeout flag to ion prompt ([a5984f1](https://github.com/dsswift/ion/commit/a5984f1024ce4ae20384dd2b8424e6a1da278db6))

### Bug Fixes

* **engine:** add configurable timeout to mcp calls ([4fda025](https://github.com/dsswift/ion/commit/4fda025c1b6181e6b94701f0fa1077099cd3bb9b))
* **engine:** add read limit and write timeouts for websocket ([d52aace](https://github.com/dsswift/ion/commit/d52aace6ffb1df42a965e7776be6047efbc286b8))
* **engine:** add panic recovery to server handlers ([bac2f90](https://github.com/dsswift/ion/commit/bac2f90d327b309475bb7c7e46895790bddddeda))
* **engine:** add retry caps and context timeouts ([c7f9e92](https://github.com/dsswift/ion/commit/c7f9e922b53e96fcc2dfa67f903b75b510cf7b29))
* **engine:** wire extensionRpcMs config to host rpc timeout ([52d017a](https://github.com/dsswift/ion/commit/52d017a2787be1274ccf3f389a44b4a74d618f5e))
* **engine:** honor --timeout for stream-json output mode ([f71aaf2](https://github.com/dsswift/ion/commit/f71aaf2fbb937b52f8d95efe271403df675e1c4f))

## [1.14.0](https://github.com/dsswift/ion/compare/engine-v1.13.0...engine-v1.14.0) (2026-05-10)

### Features

* **engine:** add system hint to engine config ([79fa965](https://github.com/dsswift/ion/commit/79fa965e4a32ce4528ace67b32d60502ab4f2082))

## [1.13.0](https://github.com/dsswift/ion/compare/engine-v1.12.0...engine-v1.13.0) (2026-05-10)

### Features

* **engine:** add server tool pairing to sanitizer ([6a797f1](https://github.com/dsswift/ion/commit/6a797f1778f14c85d6f2cb66723081504379b2da))

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

## [1.9.0](https://github.com/dsswift/ion/compare/engine-v1.8.3...engine-v1.9.0) (2026-05-06)

### Features

* **engine:** extract agent registry into separate module ([1c9fa91](https://github.com/dsswift/ion/commit/1c9fa91a302e7d81cc9b223acf46bcd72914a0d5))
* **engine:** add compaction tests for tool results ([7fdf70c](https://github.com/dsswift/ion/commit/7fdf70c7575ed3f1eaed22f227004e5080ba7dd8))
* **engine:** wire plan mode sparse reminder ([e2aa77d](https://github.com/dsswift/ion/commit/e2aa77d4d39edad73e0326f11665bcc090f19436))

### Bug Fixes

* **engine:** correct event translation return value ([b91d0bf](https://github.com/dsswift/ion/commit/b91d0bf78849c06075cea9f1ca3c69417ee75f7f))

## [1.8.3](https://github.com/dsswift/ion/compare/engine-v1.8.2...engine-v1.8.3) (2026-05-03)

Dependency updates only.

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

Internal refactoring and documentation only.

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

