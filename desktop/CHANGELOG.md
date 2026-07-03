# Changelog

All notable changes to the desktop app will be documented here. This file is
maintained by the release pipeline; do not edit by hand.

## 1.0.0 - 2026-04-28

Initial 1.0.0 baseline. Reference Electron desktop client for Ion Engine.
Demonstrates the engine's daemon architecture and multi-client broadcast.

Subsequent versions will be auto-generated from conventional commit messages.

## [1.57.0](https://github.com/dsswift/ion/compare/desktop-v1.56.0...desktop-v1.57.0) (2026-07-03)

### Features

* **desktop:** sync nested-context contract types ([8adcc76](https://github.com/dsswift/ion/commit/8adcc768d5bb74df1ed20a1bc09d31a5040ef21d))
* **desktop:** connect to launchd engine daemon ([3adab1b](https://github.com/dsswift/ion/commit/3adab1bffaacc35d5b424b7e0345af93a03ff3e2))
* **desktop:** unify plain and extension-hosted conversations (#256) ([6e27d2b](https://github.com/dsswift/ion/commit/6e27d2b11a260e44a32f61834a16cbca62f77439))
* **desktop:** carry dispatch depth/parentId in telemetry ([ea92afc](https://github.com/dsswift/ion/commit/ea92afc0131bef0237ab9990ab9f735217140331))
* **desktop:** dispatch telemetry snapshot and protocol ([9fed085](https://github.com/dsswift/ion/commit/9fed08517b6b5d93a6aa90e6a7f74a6c8479d942))
* **desktop:** move tool-call cluster below assistant messages ([63a122d](https://github.com/dsswift/ion/commit/63a122dbe3d5e2a2fe36fba1abfc2294eb22b281))
* **desktop:** 8-direction edge/corner resize for floating panels ([5435bf9](https://github.com/dsswift/ion/commit/5435bf9587f83dbb8f1d02a65565380688a3fed9))
* **desktop:** ion-meta hook integration test ([9fd88e7](https://github.com/dsswift/ion/commit/9fd88e7bca7da05dc536376acef14ab1915653a7))
* **desktop:** request breakdown command handler and protocol ([72c89a5](https://github.com/dsswift/ion/commit/72c89a549920c81155bf33ba3e47070d9bf07d5b))
* **ios:** desktop_request_context_breakdown + session ID fix ([9eb4b06](https://github.com/dsswift/ion/commit/9eb4b06a2cb0ba5e5fdb3271ca39c3789cf8ca12))

### Bug Fixes

* **desktop:** drive plan marker from plan_file_written not entry ([0508b36](https://github.com/dsswift/ion/commit/0508b3653d97e72a6ba8b3aa9b2b037327c15283))
* **desktop:** restore plan divider link across restart ([eb5fde5](https://github.com/dsswift/ion/commit/eb5fde55bff4ea40ba1d8aeb2ac08f794cb95c18))
* **ios:** restore plan divider Message decode across restart ([f785bca](https://github.com/dsswift/ion/commit/f785bcaa0dfb7d92ddf0b67468cf86c46cb1c3cb))
* **desktop:** update agent-state dispatch ID tests ([d972b03](https://github.com/dsswift/ion/commit/d972b03a0e89096c84b2eaab7f2580570213e592))
* **desktop:** sync dispatchId contract ([004f836](https://github.com/dsswift/ion/commit/004f836385a59c09d1bc8092e409c5351574d63c))
* **ios:** sync dispatchId contract ([76e4d1c](https://github.com/dsswift/ion/commit/76e4d1cd616fba9ebc7cece9837503926a591ebf))
* **desktop:** render micro-only compaction marker correctly ([baaeaaa](https://github.com/dsswift/ion/commit/baaeaaa751429773bae8cd4a5465cbdce533c5d3))
* **desktop:** clear instance planFilePath on implement ([86cb499](https://github.com/dsswift/ion/commit/86cb499b8aa62a188e2558d4b5685e3e12541120))
* **desktop:** use effectiveRunningChildrenCount for background agents ([ee95a8e](https://github.com/dsswift/ion/commit/ee95a8ecbd3dfe989385752689424aabc17d2b51))
* **desktop:** lower overlay window level below system dialogs ([f98fbdb](https://github.com/dsswift/ion/commit/f98fbdb36f29a60d8a38fd5a12f1c6eb652b9d51))
* **desktop:** snapshot parity + engine_context_breakdown wire ([eb7affd](https://github.com/dsswift/ion/commit/eb7affd13b5c151afd25d34f6f4a7e4769d9b15c))
* **desktop:** downgrade plan-mode Layer-2 recovery to observability assertion ([7a63ad2](https://github.com/dsswift/ion/commit/7a63ad28a4b9ad1f6bd60b52fbe4aa99b72ddc55))
* **desktop:** mock electron for headless main-process tests ([2d9e800](https://github.com/dsswift/ion/commit/2d9e8007d239351831d1fe6ceb2f6755cc8e78b1))
* **desktop:** pin darwin platform in engine-bootstrap tests ([badaf88](https://github.com/dsswift/ion/commit/badaf8857a020c1ad62f7403b92139e6e677812d))
* **desktop:** sync turn-grouping-guidance test to current wording ([188461b](https://github.com/dsswift/ion/commit/188461ba15d5ede75560fc88b45addbd55149be0))
* **desktop:** polyfill scrollIntoView in jsdom test setup ([58ee76d](https://github.com/dsswift/ion/commit/58ee76d31962080fe46e4b62dda3022fe2eba91f))

## [1.56.0](https://github.com/dsswift/ion/compare/desktop-v1.55.0...desktop-v1.56.0) (2026-06-19)

### Features

* **desktop:** add clear-all to global notifications panel ([b7c69c6](https://github.com/dsswift/ion/commit/b7c69c6df0182c7f407940035ff1ec5f0f1a3bfe))
* **desktop:** delegate slash resolution to engine and render pill ([9f7e14d](https://github.com/dsswift/ion/commit/9f7e14ddc28475cbf968766876ab5479d4d02da3))

## [1.55.0](https://github.com/dsswift/ion/compare/desktop-v1.54.0...desktop-v1.55.0) (2026-06-18)

### Features

* **desktop:** desktop_ wire prefix + plan-content (#240) ([6e6dac4](https://github.com/dsswift/ion/commit/6e6dac49a5276a06023b6cff4c2b653e32279344))
* **desktop:** extended-thinking UI + projection toggle (#158) ([e43979f](https://github.com/dsswift/ion/commit/e43979fb24e444cd588a914ca0c99a8a283d8125))
* **desktop:** global thinking toggle + per-conversation effort picker ([4b653c6](https://github.com/dsswift/ion/commit/4b653c6fa41f2f01477a15b5f8f0e1fe05ee82a4))

### Bug Fixes

* **desktop:** self-heal missing electron dist in postinstall ([267d32f](https://github.com/dsswift/ion/commit/267d32f335785dec1328ece99b29dc7a05e7ea48))
* **desktop:** spawn engine with login-shell PATH env ([04c912d](https://github.com/dsswift/ion/commit/04c912dd02b1824ec094b8f734ccc82221edcb6e))
* **desktop:** persist streamThinkingToRemote round-trip (#158) ([867c577](https://github.com/dsswift/ion/commit/867c5773d2b9088227190825a06a86019fb3aaf7))
* **desktop:** update sendPrompt arg count in control-plane test ([61923ef](https://github.com/dsswift/ion/commit/61923ef8ca5dcd30b1fe6831cbd1deb71e6ff828))

## [1.54.0](https://github.com/dsswift/ion/compare/desktop-v1.53.2...desktop-v1.54.0) (2026-06-16)

### Features

* **desktop:** add git-watcher ignored-directories config (#235) ([0bda88d](https://github.com/dsswift/ion/commit/0bda88df73da6093123634bfc9b17a44f66ba42c))
* **desktop:** kind-agnostic resource delivery and tray filter (#179) ([297ff64](https://github.com/dsswift/ion/commit/297ff6469ea16394416a012617724ad48f6251a3))

### Bug Fixes

* **desktop:** mock settings-store in git-watcher-bridge test (#239) ([a57856a](https://github.com/dsswift/ion/commit/a57856afb03bfc679d6b14b74891aa893d049bfd))

## [1.53.2](https://github.com/dsswift/ion/compare/desktop-v1.53.1...desktop-v1.53.2) (2026-06-15)

## [1.53.1](https://github.com/dsswift/ion/compare/desktop-v1.53.0...desktop-v1.53.1) (2026-06-15)

## [1.53.0](https://github.com/dsswift/ion/compare/desktop-v1.52.0...desktop-v1.53.0) (2026-06-15)

### Features

* **desktop:** add rewind support for engine tab conversations ([bfb82c5](https://github.com/dsswift/ion/commit/bfb82c5cd1ff2f6396b99ef4ff11705b8453e171))
* **desktop:** carry instanceId on engine_rewind input_prefill reply ([eaa823d](https://github.com/dsswift/ion/commit/eaa823d406e0e56cc6c52d1732b88925915b1232))
* **desktop:** add ensureSession as single eager durable start site ([ee8f2d6](https://github.com/dsswift/ion/commit/ee8f2d64d297c5f9203de6c34e543fa965eb56c7))
* **desktop:** restart resilience for reused tab keys (#231) ([a851126](https://github.com/dsswift/ion/commit/a851126e868ed9db56daf122600abf129f69f91d))
* **desktop:** configurable editor and conversation font sizes ([430cd36](https://github.com/dsswift/ion/commit/430cd36989252719e6f8e44bf858d35f31adaf15))
* **desktop:** keep literal tab title for slash-command prompts ([e528367](https://github.com/dsswift/ion/commit/e5283671d0b5a39e6b3b52a38444dba9a12c483e))

### Bug Fixes

* **desktop:** stack engine toasts vertically with close buttons ([9b5e250](https://github.com/dsswift/ion/commit/9b5e250b8f294bba8b9ec0468cbae647ccea60af))
* **desktop:** filter extension picker to supported entry points ([cde55da](https://github.com/dsswift/ion/commit/cde55da50c77a9c90449e3682d61e9e9f19d885e))
* **desktop:** use engine context window in status bar indicator ([3062a90](https://github.com/dsswift/ion/commit/3062a90bac740f5bc7a1d0838beaa0a9c71571d3))
* **desktop:** dismiss question/plan card on /clear ([7865879](https://github.com/dsswift/ion/commit/7865879dcdfee203cede4cd7d4639cf17f37cd1b))
* **desktop:** guard idle pre-mint from clobbering conversationId ([7ba1b70](https://github.com/dsswift/ion/commit/7ba1b700d404e54e037e3b9c68b67848e8e33b60))
* **desktop:** mock electron in engine-rewind test for ci ([d158dd2](https://github.com/dsswift/ion/commit/d158dd2b32fffc73aaf2f115147f88beab5a77a0))

## [1.52.0](https://github.com/dsswift/ion/compare/desktop-v1.51.0...desktop-v1.52.0) (2026-06-12)

### Features

* **desktop:** add resource subscription lifecycle and store wiring (#180) ([94e7a80](https://github.com/dsswift/ion/commit/94e7a8033106df4a4e280dbbd33a1559536568fd))
* **desktop:** handle engine_plan_mode_auto_exit event (#187) ([4f4ea27](https://github.com/dsswift/ion/commit/4f4ea27de6871a1528b3708b499c511353e2577a))
* **desktop:** render model fallback indicator on engine instance (#174) ([3795dec](https://github.com/dsswift/ion/commit/3795dec81098d1c65d3e83baf9c8494621346b81))
* **desktop:** add notifications panel with cross-device sync (#188) ([edf6c6f](https://github.com/dsswift/ion/commit/edf6c6f39771f2c4e1f3b3a284298f5cc8e15874))
* **desktop:** add slash command and frontmatter support ([a337f7d](https://github.com/dsswift/ion/commit/a337f7d137043b9745ff57f99a50c8de354601c9))
* **desktop:** add intercept banner and cross-device routing UI ([7ff5779](https://github.com/dsswift/ion/commit/7ff57791db08146abb524c6988bb9a523087dd1b))
* **desktop:** add sub-tab close confirmation and awaiting-children state ([f6a080f](https://github.com/dsswift/ion/commit/f6a080f2dbcad49d61b6ea9c3dd5c8a7c0fc7d4c))
* **desktop:** unify engine state into ConversationInstance (#203) ([ad82f6a](https://github.com/dsswift/ion/commit/ad82f6a4cce36c772101fe4edf0972bf040d8128))
* **desktop:** add conversation cleanup job, export, and restore (#208) ([8a30322](https://github.com/dsswift/ion/commit/8a3032236133fefeb7188abb5e98272a4138dea1))
* **desktop:** add RunStalledEvent to contract sync surface ([b719177](https://github.com/dsswift/ion/commit/b719177d97f62669cec4ee6fb233f0ca7f1f84fe))
* **desktop:** add session status event handling and tab count display ([a4961df](https://github.com/dsswift/ion/commit/a4961df16c5f1ff7caa7b18ab8c53fb73bf0f192))
* **desktop:** surface conversationId in snapshot and settings (#213) ([bea6e6f](https://github.com/dsswift/ion/commit/bea6e6f5f029594a4e5a3fdacbe8126a09195b38))
* **desktop:** add resource manifest sync, persistence, and attachments UI (#212) ([da9ab1a](https://github.com/dsswift/ion/commit/da9ab1ae9146053bf996276e615f86ba92211f12))

### Bug Fixes

* **desktop:** isolate plan mode per engine instance ([76698b1](https://github.com/dsswift/ion/commit/76698b1709c95e6f2808d30dc793eeca8d21a1b6))
* **desktop:** memoize groupMessages and remove debug logging (#205) ([037e691](https://github.com/dsswift/ion/commit/037e691a7b3d7ce6402caa4516c71baf4952ca7c))
* **desktop:** align snapshot polling with iOS engine state changes ([fcc5be0](https://github.com/dsswift/ion/commit/fcc5be06a5389bd0ac80adfffb0643df613b7450))
* **desktop:** improve performance, stability, and error handling ([74a230e](https://github.com/dsswift/ion/commit/74a230e0c34fc09f207a786fa80e7b98f0d4af09))
* **desktop:** align snapshot types with iOS streaming auto-tail fixes ([4e214f1](https://github.com/dsswift/ion/commit/4e214f185e10e5c4d2c36cfac1de1c87f1a50e8d))
* **desktop:** align attachment handler with iOS loading fixes ([de0e431](https://github.com/dsswift/ion/commit/de0e431a4760f2cac4bd965e718e1471e9a94882))
* **desktop:** add missing electron mocks to three test files ([1141b75](https://github.com/dsswift/ion/commit/1141b75ece4a6fb598724b5ca9fad050f6414d0b))

## [1.51.0](https://github.com/dsswift/ion/compare/desktop-v1.50.0...desktop-v1.51.0) (2026-06-05)

### Features

* **engine:** fall back to default model on unresolved tier alias (#174) ([4a9d7af](https://github.com/dsswift/ion/commit/4a9d7af0d9cc017df65de66fff33d3b49accda6d))
* **desktop:** forward slash frontmatter model hint to runoptions ([0466f43](https://github.com/dsswift/ion/commit/0466f43d9faff56c85fa9e7ddfc8387fc02dfe63))
* **desktop:** show yaml frontmatter in markdown preview ([6e3ebb9](https://github.com/dsswift/ion/commit/6e3ebb972fb0a16926118c8caf874d8fe0e9985e))

### Bug Fixes

* **desktop:** show ion-native slash commands when claude-compat off ([1481e56](https://github.com/dsswift/ion/commit/1481e560f3c6e39d89fbba410f07cfc2c3e262e2))

## [1.50.0](https://github.com/dsswift/ion/compare/desktop-v1.49.0...desktop-v1.50.0) (2026-06-05)

### Features

* **ios:** mirror desktop categories + full settings projection ([b248eaf](https://github.com/dsswift/ion/commit/b248eafde082a4611d9f8b786e25804e2c609be6))
* **engine:** configurable bash commands in plan mode ([d7e6c5f](https://github.com/dsswift/ion/commit/d7e6c5f7fa0dd2695e54a7f96809db586c0217b2))
* **engine:** per-prompt bash allowlist additions (no session-state mutation) ([184a16f](https://github.com/dsswift/ion/commit/184a16f5b33f4add261be0f02f9a870efa2ed132))

### Bug Fixes

* **desktop:** use static import for engineBridge in engine-bridge-fs ([b92f8e7](https://github.com/dsswift/ion/commit/b92f8e76e474605f279c4158b46d7fc30adbb0a2))
* **desktop:** forward all renderer console logs to desktop.log ([07225fa](https://github.com/dsswift/ion/commit/07225faae6c8ec43feb2b19a31505d28229ed0b4))
* **desktop:** show parent dir in engine profile extension paths ([f46e203](https://github.com/dsswift/ion/commit/f46e203b08e708c6d84904ba9b3c2dd8d440d376))
* **desktop:** replace hand-rolled YAML frontmatter parser with js-yaml ([7e08ab6](https://github.com/dsswift/ion/commit/7e08ab63486c46a88a2ebfcca19a56d1ecaabf76))

## [1.49.0](https://github.com/dsswift/ion/compare/desktop-v1.48.0...desktop-v1.49.0) (2026-06-04)

### Features

* **engine:** inject steer messages before end_turn exit ([3c5e534](https://github.com/dsswift/ion/commit/3c5e53418393f5cdacbb90ccc1e63d6b6fcd7e22))
* **desktop:** badge slash commands in user message bubbles ([40211f2](https://github.com/dsswift/ion/commit/40211f213c6cec77e281c0a9c28d9f0db3d17442))
* **desktop:** add pill icon presets and project iOS pill state ([d580162](https://github.com/dsswift/ion/commit/d580162478286e4199d81d6e7891332193fc46f6))
* **desktop:** add implement divider, plan viewer, clear-context option ([b697541](https://github.com/dsswift/ion/commit/b697541d62b82c1181ee25e5c2fdcfb9ae5e487c))
* **desktop:** add unified turn grouping, pagination, prompt guidance ([e874e60](https://github.com/dsswift/ion/commit/e874e6044b106590414fa61047f86afd98c62fb2))
* **desktop:** add /clear command to reset conversation ([55d3214](https://github.com/dsswift/ion/commit/55d321445d3409b3972f8777956e772c3aa4a7b0))
* **desktop:** add reset_engine_session for engine-tab clear context ([d1907bc](https://github.com/dsswift/ion/commit/d1907bcf564a3fe38065163d521755ae35db0aac))
* **desktop:** render Steer applied divider on engine_steer_injected ([9b5c9b1](https://github.com/dsswift/ion/commit/9b5c9b13b005c4de2269853094617da5bc7b7c5f))

### Bug Fixes

* **desktop:** restrict slash plan→auto switch to first prompt only ([bfa0787](https://github.com/dsswift/ion/commit/bfa0787d2ee7d976aef67fbfd6f88c40ea9634d0))
* **desktop:** no-op cmd-click on non-existent file paths ([b3ebf33](https://github.com/dsswift/ion/commit/b3ebf332df494a2bc2ca85492abe16c3e60b4163))

## [1.48.0](https://github.com/dsswift/ion/compare/desktop-v1.47.0...desktop-v1.48.0) (2026-06-03)

### Features

* **desktop:** add fuzzy matching for slash commands ([0fd88d0](https://github.com/dsswift/ion/commit/0fd88d06968ef427103464e2f5647c16fc04c2c2))
* **desktop:** mirror LlmContentBlock with compact_boundary fields ([629613c](https://github.com/dsswift/ion/commit/629613c6cd65f7eabab9f077ae755a28d782493f))

### Bug Fixes

* **desktop:** remove silent 10 KB truncation of non-tool messages ([dd21c68](https://github.com/dsswift/ion/commit/dd21c689cb0945bdb90ad25128240076cf6081ab))

## [1.47.0](https://github.com/dsswift/ion/compare/desktop-v1.46.0...desktop-v1.47.0) (2026-06-02)

### Features

* **desktop:** add theme registry with HUD palette ([8527d67](https://github.com/dsswift/ion/commit/8527d67a6941e3bd59eafbfb5795077f247fa4a9))
* **engine:** aggregate dispatches into pager with array model ([5d9cf05](https://github.com/dsswift/ion/commit/5d9cf057a46f69302699867adcca7241f94ebd17))
* **ios:** dispatch conversation lookup with caching ([4512473](https://github.com/dsswift/ion/commit/45124737149e105d7819d53ef5031d2d8c82ab52))
* **desktop:** dispatch pager conversation lookup and display ([992390d](https://github.com/dsswift/ion/commit/992390d4a191c294c34920bba17a3d8de74ef4b3))
* **ios:** add copy session id to tab context menus ([cd58d11](https://github.com/dsswift/ion/commit/cd58d1110b78d7bc410bbf1296aeb31d174c0e82))
* **desktop:** add agent panel default open setting ([990f676](https://github.com/dsswift/ion/commit/990f676125b5070c5d6cb6c0fe2e6ce7ed27d907))
* **desktop:** agent panel with compact mode and geometry persistence ([85e5dbf](https://github.com/dsswift/ion/commit/85e5dbf6a6a0ee72d3425feeb537c501c2a82a0d))

### Bug Fixes

* **engine:** preserve background dispatch agent visibility on run exit ([884d853](https://github.com/dsswift/ion/commit/884d8530f66423256399500f396afdca06105623))
* **engine:** cap tool result size, persist model override, improve memory quality ([387190d](https://github.com/dsswift/ion/commit/387190d6dd79780fb3c04ea8a9fd3c6b854581e0))
* **engine:** seed lastModel from conversation on session resume ([74e324b](https://github.com/dsswift/ion/commit/74e324b6d1c2cda96c5e2c188a053509e7e36f32))
* **desktop:** seal engine assistant messages at turn boundary ([fcd8834](https://github.com/dsswift/ion/commit/fcd88341ef6dfd5ffd9855f05fd59dc44644da94))

## [1.46.0](https://github.com/dsswift/ion/compare/desktop-v1.45.0...desktop-v1.46.0) (2026-06-01)

### Features

* **desktop:** wire implementationPhase for engine tab implement action ([5fdbb49](https://github.com/dsswift/ion/commit/5fdbb495a07b6ba101a788e4c600ee5a9b1b0cd8))

### Bug Fixes

* **desktop:** sync plan mode unconditionally on engine prompt ([0f90cdf](https://github.com/dsswift/ion/commit/0f90cdf6831201089116f260326494bca60f869e))

## [1.45.0](https://github.com/dsswift/ion/compare/desktop-v1.44.0...desktop-v1.45.0) (2026-05-31)

### Features

* **desktop:** add running state to engine instances ([e7a34a6](https://github.com/dsswift/ion/commit/e7a34a69f34bd904a6ebf4e22e8412ecb271b26d))

### Bug Fixes

* **desktop:** prevent mousedown handler from dismissing confirm dialog ([3f83d36](https://github.com/dsswift/ion/commit/3f83d36a57f62382e5bf4f36f808dc8551f7cf71))
* **desktop:** flush tab state before app exit ([60d39a3](https://github.com/dsswift/ion/commit/60d39a3ab766daf6ed04f7c41b3b9a024f45fd96))

## [1.44.0](https://github.com/dsswift/ion/compare/desktop-v1.43.0...desktop-v1.44.0) (2026-05-31)

### Features

* **desktop:** add plan approval flow to engine tabs ([8f06f74](https://github.com/dsswift/ion/commit/8f06f74e58694e2e687614bbaf0d8fa72f051eec))

## [1.43.0](https://github.com/dsswift/ion/compare/desktop-v1.42.0...desktop-v1.43.0) (2026-05-31)

### Features

* **desktop:** deduplicate harness messages across tabs ([3050e58](https://github.com/dsswift/ion/commit/3050e589f8fa7ea6ccb1a5ec64fb00666e77bcae))
* **desktop:** add file rename support for remote clients ([951bf7b](https://github.com/dsswift/ion/commit/951bf7be881f5f0755c5ecf5d3e3b0de8b9fc751))
* **desktop:** add agent conversation loading with panel refactor ([fc3ee8b](https://github.com/dsswift/ion/commit/fc3ee8b806239b38a3666ee36f5ff6745ab19aa9))
* **engine:** add agent dispatch lifecycle with redispatch ([f9fff27](https://github.com/dsswift/ion/commit/f9fff27fccee90c2193214071c6a96aac47d493a))
* **desktop:** add plan/auto toggle to engine tab footer ([a49d6fe](https://github.com/dsswift/ion/commit/a49d6fefd2ea9234968c356da9ba65173a4194eb))
* **desktop:** show running indicator on engine pills ([41768a6](https://github.com/dsswift/ion/commit/41768a66bb9d1f0a4e3c85487b4f101ff62a9032))
* **desktop:** add raw file attachment encoding to engine ([865a393](https://github.com/dsswift/ion/commit/865a393623c40762a359e2d7b2f16453adea2e7f))
* **desktop:** add ion scope slash command support ([c5b7967](https://github.com/dsswift/ion/commit/c5b79670126249a6108c70c0207bb430f508ef50))

### Bug Fixes

* **desktop:** handle and render permission denied cards in engine view ([94e2178](https://github.com/dsswift/ion/commit/94e2178c15cfdaa0c4c6eb003047b7c9592afb49))
* **desktop:** preserve sessionId when merging status fields ([a40d74c](https://github.com/dsswift/ion/commit/a40d74ce819107c4a54b27490bc3be8e6816308f))
* **desktop:** reject stale idle events during implement flow ([b16d553](https://github.com/dsswift/ion/commit/b16d55384545db3f04b386bb2a835c98e56178ff))
* **desktop:** prevent table overflow in message bubbles ([392d5ba](https://github.com/dsswift/ion/commit/392d5baa25d567daadee9578d7b1747fa054ee08))
* **desktop:** keep tab right-click menus on-screen ([60de848](https://github.com/dsswift/ion/commit/60de8484ef04f0cee274e2cc87e51d22d1234b1e))
* **desktop:** auto-move tabs to done group on task completion ([fe8b449](https://github.com/dsswift/ion/commit/fe8b44931d3dd12c07f2cf17be10211804ea5fba))
* **engine:** fix CI failures in integration tests and desktop test ([cbbf4a6](https://github.com/dsswift/ion/commit/cbbf4a63975f2c741fa88af0aa8d231323ac66c9))

## [1.42.0](https://github.com/dsswift/ion/compare/desktop-v1.41.0...desktop-v1.42.0) (2026-05-28)

### Features

* **desktop:** render askuserquestion card in engine view tabs ([a7a25ed](https://github.com/dsswift/ion/commit/a7a25ed4973623de71af305a2b083c71d12fa118))
* **desktop:** add per-instance waiting state to engine ui ([b8be7b2](https://github.com/dsswift/ion/commit/b8be7b226a03e1c19ce5581031c14d013df6dff0))

### Bug Fixes

* **desktop:** reconcile engine state after start_session attach ([3345cba](https://github.com/dsswift/ion/commit/3345cba427154998c72893a46d2be710c4670912))
* **desktop:** restore engine askuserquestion cards across restarts ([9d35938](https://github.com/dsswift/ion/commit/9d3593859e8b8d568c75cd80e62ffcf9c523a365))
* **desktop:** persist engine session ids immediately on capture ([f8c043b](https://github.com/dsswift/ion/commit/f8c043bf9109bae12d31634d0ee4ddebe801ba30))

## [1.41.0](https://github.com/dsswift/ion/compare/desktop-v1.40.1...desktop-v1.41.0) (2026-05-27)

### Features

* **desktop:** hide UI during initialization with progress text ([84ba374](https://github.com/dsswift/ion/commit/84ba37442f07b4ec44ad91d851c2d88c00d0c958))
* **engine:** clarify plan mode exit timing in prompts ([f1906b5](https://github.com/dsswift/ion/commit/f1906b5279d079a790466ee8fe1e37fa46e9fbba))

## [1.40.1](https://github.com/dsswift/ion/compare/desktop-v1.40.0...desktop-v1.40.1) (2026-05-26)

### Bug Fixes

* **desktop:** add logging to engine-bridge-fs and control plane remote check ([a62d755](https://github.com/dsswift/ion/commit/a62d755adca1db40bf5e6fecc094d2d18726f003))
* **desktop:** wire lastMessagePreview persistence and add remote-probe tests ([986fa64](https://github.com/dsswift/ion/commit/986fa644646b5c31d785b300b865531dab404dc8))

## [1.40.0](https://github.com/dsswift/ion/compare/desktop-v1.39.0...desktop-v1.40.0) (2026-05-26)

### Features

* **desktop:** persist last-message preview on tabs for richer tab pills ([29777cb](https://github.com/dsswift/ion/commit/29777cbd05d153f4b18144c9c466f83026c843dc))
* **desktop:** show last-message preview and relative time on tab pills ([c8ef91e](https://github.com/dsswift/ion/commit/c8ef91ea6cc8d648c8d302bd57bc623d2c82ba54))

## [1.39.0](https://github.com/dsswift/ion/compare/desktop-v1.38.1...desktop-v1.39.0) (2026-05-26)

### Features

* **desktop:** browse engine filesystem when picking working directory ([27af131](https://github.com/dsswift/ion/commit/27af1313b892af27b2422f1e11f234b96f4f2f34))

## [1.38.1](https://github.com/dsswift/ion/compare/desktop-v1.38.0...desktop-v1.38.1) (2026-05-26)

### Bug Fixes

* **engine:** mark anthropic provider authed when CLI backend is in use ([6e17630](https://github.com/dsswift/ion/commit/6e17630481bffd107cf6e136344c878e53a83b43))

## [1.38.0](https://github.com/dsswift/ion/compare/desktop-v1.37.1...desktop-v1.38.0) (2026-05-26)

### Features

* **engine:** add ctx.LLMCall lightweight inference primitive ([73ee012](https://github.com/dsswift/ion/commit/73ee012c4248dc52ce320c359aedae80403591f7))

## [1.37.1](https://github.com/dsswift/ion/compare/desktop-v1.37.0...desktop-v1.37.1) (2026-05-26)

### Bug Fixes

* **engine:** persist and restore planFilePath across restarts ([e0a9f69](https://github.com/dsswift/ion/commit/e0a9f69a323df5afc3316da04b45c34ef5b8762c))

## [1.37.0](https://github.com/dsswift/ion/compare/desktop-v1.36.0...desktop-v1.37.0) (2026-05-25)

### Features

* **desktop:** typed webhook and schedule events ([7c151df](https://github.com/dsswift/ion/commit/7c151df37ad97203f71f237be733d2c9735ff6f5))

## [1.36.0](https://github.com/dsswift/ion/compare/desktop-v1.35.1...desktop-v1.36.0) (2026-05-25)

### Features

* **desktop:** unify slash pipeline + /clear checkpoint ([1a3894d](https://github.com/dsswift/ion/commit/1a3894dd2073077b90b98efb9cfec511bce284a9))
* **engine:** early-stop continuation with opt-in wire protocol ([5f79236](https://github.com/dsswift/ion/commit/5f7923647e084ccd2be1ef1f3daf4d00bba7f3d8))
* **desktop:** add opus 4.7 model with 1m context window ([3bceb82](https://github.com/dsswift/ion/commit/3bceb8240941cce0501125a1c15311872f65296e))
* **engine:** plan-mode lifecycle with implementation phase ([10e63c4](https://github.com/dsswift/ion/commit/10e63c4dc8f4ca85991b323c24744882bca54037))
* **engine:** add workspace_file_changed hook + watcher (#130) ([e8377e9](https://github.com/dsswift/ion/commit/e8377e96a91704524d430c13ec538031c3826608))
* **desktop:** hide cd prefix and count collapsed tool groups ([8ff62da](https://github.com/dsswift/ion/commit/8ff62da2a901965c889195bf72a44c35acd66b0a))
* **desktop:** add move to group and pin menu option ([49bebd8](https://github.com/dsswift/ion/commit/49bebd8bb31c8c2110e6b4eb4fa8e3dd37c908b9))
* **desktop:** consume engine_plan_proposal in event pipeline ([ea13ca8](https://github.com/dsswift/ion/commit/ea13ca8795766de416d039b9b3d501e5d00d3dc7))
* **desktop:** project user settings to iOS via wire protocol ([5d8e596](https://github.com/dsswift/ion/commit/5d8e5962f54c29c29dffd6b313af73a47b7c421c))

### Bug Fixes

* **desktop:** refresh git on tab switch, panel open, focus ([74c72ea](https://github.com/dsswift/ion/commit/74c72eac66eb0f67135e6ff0a00b215a859fc269))
* **engine:** /clear leak + expand Skill tool with claude-skills manifest ([b7f1b2b](https://github.com/dsswift/ion/commit/b7f1b2bc423384aad95189b29c9c48ca8ac45c6f))
* **desktop:** stub electron in tests for ci compatibility ([8f16df5](https://github.com/dsswift/ion/commit/8f16df519e9b3e6160b798cac03010188a08be8e))

## [1.35.1](https://github.com/dsswift/ion/compare/desktop-v1.35.0...desktop-v1.35.1) (2026-05-23)

### Bug Fixes

* **desktop:** declare NSBonjourServices for Local Network prompt ([10869ee](https://github.com/dsswift/ion/commit/10869ee396ab31faa036f773d0b9adf91f4fffa0))

## [1.35.0](https://github.com/dsswift/ion/compare/desktop-v1.34.0...desktop-v1.35.0) (2026-05-22)

### Features

* **desktop:** add ask user question card ([75e1796](https://github.com/dsswift/ion/commit/75e179679c8e61f28330b1d21dc24addc52b3b44))
* **desktop:** add collapsed count badge to harness messages ([a4a8b50](https://github.com/dsswift/ion/commit/a4a8b5069368391e89a728bb78d059c40351ff28))
* **desktop:** add conversation search with keyboard shortcuts ([a0fdfec](https://github.com/dsswift/ion/commit/a0fdfec4ca159a2c0c07f72ed7ca5288f0dc2a98))
* **desktop:** persist and restore draft input in tabs ([9499063](https://github.com/dsswift/ion/commit/94990637582b07fc2a1e2c8535bce9b5d006b734))
* **desktop:** add remote display customization ([1bb6c35](https://github.com/dsswift/ion/commit/1bb6c359088e1d44fad21e50bda3e3162d8599d2))
* **desktop:** handle tab list commands in remote ([1e50e41](https://github.com/dsswift/ion/commit/1e50e41698439ca5cfae8bc58b4ce7abb2ad9759))
* **desktop:** add git watcher bridge with broadcast ([f51643d](https://github.com/dsswift/ion/commit/f51643d3ddbce40f4fb6314a14a9b687ccccf148))
* **desktop:** add copy session id to conversation menu ([87edcc5](https://github.com/dsswift/ion/commit/87edcc52c995d13d5373e3d01f7bdd3822721da6))
* **desktop:** add move all tabs confirmation dialog ([5e27f49](https://github.com/dsswift/ion/commit/5e27f492f76aa1c31d8e9658b3e2984ff57ddffa))
* **desktop:** add tab group pinning functionality ([b617c7b](https://github.com/dsswift/ion/commit/b617c7bac29f286544c26fa5559d60a907d0ff3a))

### Bug Fixes

* **desktop:** replace agent state with engine snapshot, never preserve historical ([5d8db30](https://github.com/dsswift/ion/commit/5d8db305a36f0bdc6b389827f17a68d4c7a82d80))
* **desktop:** always forward engine_agent_state on resync, including empty ([6868de5](https://github.com/dsswift/ion/commit/6868de5b4f48ad61d550781d5f29a8691b74a697))
* **desktop:** persist permission denials immediately ([aa9289d](https://github.com/dsswift/ion/commit/aa9289dd9e867178345668085eb72a75258d9cc6))

## [1.34.0](https://github.com/dsswift/ion/compare/desktop-v1.33.0...desktop-v1.34.0) (2026-05-21)

### Features

* **desktop:** add engine session key remapping ([3f168c9](https://github.com/dsswift/ion/commit/3f168c920de1402c0f690aedf7d61a5d3e6ecfcc))
* **desktop:** add remote engine instance move command ([49b8bc3](https://github.com/dsswift/ion/commit/49b8bc3c6c1f4e157d5838abe94ae3bd534f5821))
* **desktop:** add ui for moving engine instances ([82bbbdb](https://github.com/dsswift/ion/commit/82bbbdb2ae4f48d4ba37d18828e6f81812b95909))

### Bug Fixes

* **desktop:** repair git panel auto-refresh and refresh button ([e313491](https://github.com/dsswift/ion/commit/e31349120586b918c1eaece08b1d35b6998d5230))

## [1.33.0](https://github.com/dsswift/ion/compare/desktop-v1.32.3...desktop-v1.33.0) (2026-05-21)

### Features

* **desktop:** add plan/implement model splitting ([a659209](https://github.com/dsswift/ion/commit/a6592095ac937b58e794088ffcd60626d9090ab2))

## [1.32.3](https://github.com/dsswift/ion/compare/desktop-v1.32.2...desktop-v1.32.3) (2026-05-20)

## [1.32.2](https://github.com/dsswift/ion/compare/desktop-v1.32.1...desktop-v1.32.2) (2026-05-20)

## [1.32.1](https://github.com/dsswift/ion/compare/desktop-v1.32.0...desktop-v1.32.1) (2026-05-20)

## [1.32.0](https://github.com/dsswift/ion/compare/desktop-v1.31.2...desktop-v1.32.0) (2026-05-20)

### Features

* **desktop:** add tooltip component for git ui ([16ef2e6](https://github.com/dsswift/ion/commit/16ef2e6a106a2f4ff5ef0f52d40b4afe309a3cb2))
* **desktop:** refresh git on window focus return ([ffd5e8d](https://github.com/dsswift/ion/commit/ffd5e8d2129a70102af56517b56b66cfcc8192fd))
* **desktop:** add attachment loading support ([dd9bffa](https://github.com/dsswift/ion/commit/dd9bffa33c7a4a29cb05fb86a2db220e26ec632c))
* **desktop:** enhance commit form with ai and history ([1979862](https://github.com/dsswift/ion/commit/197986230184456e4c4b4f1b3b2a4e7802b08c83))
* **desktop:** add image viewer component ([b260026](https://github.com/dsswift/ion/commit/b260026845295fdd9e71e89e26611602904dbb61))
* **ios:** add attachment command and events ([76cc3da](https://github.com/dsswift/ion/commit/76cc3dab94a293724fc19cf500b7da7223dd3de2))
* **desktop:** add copy relative path to context menus ([c79e422](https://github.com/dsswift/ion/commit/c79e422c5c7c67e271fe80bc60752dc293910a87))

### Bug Fixes

* **desktop:** hide terminal panel on restored tabs ([f4beb9b](https://github.com/dsswift/ion/commit/f4beb9bb61134edcaa7c6e2f624478598ed88473))

## [1.31.2](https://github.com/dsswift/ion/compare/desktop-v1.31.1...desktop-v1.31.2) (2026-05-19)

### Bug Fixes

* **engine:** unify context window and persist token cache ([5024b80](https://github.com/dsswift/ion/commit/5024b805f4b25dff5ea9dc9f6b5cb470d4a3a61c))

## [1.31.1](https://github.com/dsswift/ion/compare/desktop-v1.31.0...desktop-v1.31.1) (2026-05-19)

## [1.31.0](https://github.com/dsswift/ion/compare/desktop-v1.30.0...desktop-v1.31.0) (2026-05-19)

### Features

* **desktop:** add fast-forward merge option for worktrees ([89b65d9](https://github.com/dsswift/ion/commit/89b65d9688db01ff88cbdbd607ac7141ce97640b))
* **desktop:** add editor chrome and codemirror extensions ([df0e8c0](https://github.com/dsswift/ion/commit/df0e8c0b8e607ffd79a576e670b78a50708973b6))
* **desktop:** add markdown preview and editor font settings ([841bfaf](https://github.com/dsswift/ion/commit/841bfafa8e719fac5300cdd4af5f80683af518ce))

## [1.30.0](https://github.com/dsswift/ion/compare/desktop-v1.29.0...desktop-v1.30.0) (2026-05-19)

### Features

* **desktop:** add tab group reordering support ([557e549](https://github.com/dsswift/ion/commit/557e5493810b287add9a15c39e815c8debdbf7d9))

## [1.29.0](https://github.com/dsswift/ion/compare/desktop-v1.28.0...desktop-v1.29.0) (2026-05-19)

### Features

* **desktop:** add model management with provider config ([8fb8cf4](https://github.com/dsswift/ion/commit/8fb8cf4b3a3f2ee008a81edfe457626ab35c984b))
* **desktop:** add oauth provider authentication ([3580b60](https://github.com/dsswift/ion/commit/3580b60af619c652d60f9704d40325172c3027ef))
* **desktop:** add model refresh and provider filtering ([b49b671](https://github.com/dsswift/ion/commit/b49b67159c2e5a223ae4e05434dfb856da57e06d))
* **desktop:** persist model override in tab state ([50f8790](https://github.com/dsswift/ion/commit/50f87904981ce80ab83cce8c3e845a7a91c49645))

### Bug Fixes

* **desktop:** move slash command output to user prompt ([dc07b70](https://github.com/dsswift/ion/commit/dc07b70fd3b659655bdaac63eea3a6b2d619da85))

## [1.28.0](https://github.com/dsswift/ion/compare/desktop-v1.27.0...desktop-v1.28.0) (2026-05-18)

### Features

* **engine:** add plan mode support to CLI backend ([ec645fa](https://github.com/dsswift/ion/commit/ec645fa9e82470e2f21c9f8856b7e2ba8bfd6b92))
* **desktop:** rework git system ([0337588](https://github.com/dsswift/ion/commit/033758896a23e7b63ae0e6576c80fdb9f73118bd))

### Bug Fixes

* **desktop:** suppress ghost plan cards in CLI auto mode ([0c150a2](https://github.com/dsswift/ion/commit/0c150a2fbf7e0235833bcc7775fc9f44fdd4370c))

## [1.27.0](https://github.com/dsswift/ion/compare/desktop-v1.26.0...desktop-v1.27.0) (2026-05-17)

### Features

* **desktop:** pass deviceId to command handlers ([8d574a5](https://github.com/dsswift/ion/commit/8d574a52e07ab5e0cfaa165370ad431276b931e8))
* **desktop:** add git operations with file system watcher ([4484df1](https://github.com/dsswift/ion/commit/4484df1e22451e285b71fd4200f4956c2b1cc8ff))
* **ios:** add git operations with graph visualization and commit details ([75c9fb7](https://github.com/dsswift/ion/commit/75c9fb7289c33b23ca688ed7e098e2fecaacefc0))
* **desktop:** persist ios diagnostic logs to disk ([809cbc0](https://github.com/dsswift/ion/commit/809cbc05f1ff3b143ec5f9a64c55650cf11bcc22))

### Bug Fixes

* **desktop:** add main-process scrollback for terminal snapshots ([69cdd4e](https://github.com/dsswift/ion/commit/69cdd4e141b6b012c249847244770ba5c3ba6b42))

## [1.26.0](https://github.com/dsswift/ion/compare/desktop-v1.25.2...desktop-v1.26.0) (2026-05-16)

### Features

* **desktop:** add settings search functionality ([26874d4](https://github.com/dsswift/ion/commit/26874d49afc62abb5dc1dfba3d766ff59daf48a1))

## [1.25.2](https://github.com/dsswift/ion/compare/desktop-v1.25.1...desktop-v1.25.2) (2026-05-16)

### Bug Fixes

* **desktop:** validate terminal CWD exists before pty.spawn, fall back to homedir ([179d4e3](https://github.com/dsswift/ion/commit/179d4e3734af9fa1ff04109c69aa08f438fa1bdf))

## [1.25.1](https://github.com/dsswift/ion/compare/desktop-v1.25.0...desktop-v1.25.1) (2026-05-16)

### Bug Fixes

* **desktop:** add NSLocalNetworkUsageDescription and log connect errors ([d982564](https://github.com/dsswift/ion/commit/d982564450b0d8ed4e943f94317d96c1907d81dd))

## [1.25.0](https://github.com/dsswift/ion/compare/desktop-v1.24.0...desktop-v1.25.0) (2026-05-16)

### Features

* **desktop:** add tab migration between backends ([8d53980](https://github.com/dsswift/ion/commit/8d539802f0debca0d3699155b5826cd11d10ea58))

## [1.24.0](https://github.com/dsswift/ion/compare/desktop-v1.23.0...desktop-v1.24.0) (2026-05-15)

### Features

* **desktop:** use client message id in prompt handler ([fa4a1a4](https://github.com/dsswift/ion/commit/fa4a1a4e2ff8f39b8b8c19c5719a3186f994dbe8))

## [1.23.0](https://github.com/dsswift/ion/compare/desktop-v1.22.0...desktop-v1.23.0) (2026-05-15)

### Features

* **desktop:** add image attachments to messages ([0f75fdc](https://github.com/dsswift/ion/commit/0f75fdc598feb0edccffaff9bfb7c4174822e18d))

## [1.22.0](https://github.com/dsswift/ion/compare/desktop-v1.21.0...desktop-v1.22.0) (2026-05-15)

### Features

* **desktop:** add per-instance draft input for engine tabs ([177b495](https://github.com/dsswift/ion/commit/177b495084b2c5be18cc9e79df64b9b5c188b41c))
* **desktop:** add correlation id to file upload protocol ([58e380a](https://github.com/dsswift/ion/commit/58e380a243b70c292972d2e6ebe4c72790f09416))
* **desktop:** add lastActivityAt field to tab protocol ([0aab4f5](https://github.com/dsswift/ion/commit/0aab4f5e83c3b7436158539b5adaf37bb35d4a3f))
* **desktop:** add quick tools settings category ([24ba95a](https://github.com/dsswift/ion/commit/24ba95a38a15650209c869f197e78c039a209f97))
* **desktop:** replace update banner with dialog UI ([6d7cda8](https://github.com/dsswift/ion/commit/6d7cda8a3235343853eb4cf8b43ef6cbea173def))
* **ios:** add voice mode with TTS playback and controls ([6f05ca2](https://github.com/dsswift/ion/commit/6f05ca289bed3daf037bc817b77a2970f64bb791))
* **desktop:** add developer settings category ([a0174e9](https://github.com/dsswift/ion/commit/a0174e91c194dd864251004ab51a7eb8fa5b2413))

## [1.21.0](https://github.com/dsswift/ion/compare/desktop-v1.20.0...desktop-v1.21.0) (2026-05-14)

### Features

* **desktop:** add auto-reconcile on event drops ([cefe8f0](https://github.com/dsswift/ion/commit/cefe8f070c7f72090a6683dcaaf4359daebc3cf6))
* **desktop:** enhance agent panel with status ui ([f56bb5e](https://github.com/dsswift/ion/commit/f56bb5eb3faf990234181029215258efea26f450))
* **desktop:** add hours to duration display format ([4f9a04c](https://github.com/dsswift/ion/commit/4f9a04ca55dc1d39c3ae301af5b5dc932b9ff9b2))
* **ios:** add attachment support for conversations and engine tabs ([182e1aa](https://github.com/dsswift/ion/commit/182e1aafb670f1b4d3e11b96ff82c825557124bc))
* **desktop:** add compaction visibility ui and remote forwarding ([b221eca](https://github.com/dsswift/ion/commit/b221eca3869458779f15082bcdab5782aa157a39))
* **desktop:** add alt/cmd+arrow navigation in terminal ([80d8ede](https://github.com/dsswift/ion/commit/80d8edebf8ebb7ec31302de9196ac80ef0247809))
* **desktop:** eagerly create terminal pty for remote clients ([4547401](https://github.com/dsswift/ion/commit/4547401e49c3d6347aa096bdd4d579c1f9d59a5f))
* **engine:** forward compaction summary to engine tabs ([fdf7dde](https://github.com/dsswift/ion/commit/fdf7dde316408b9de7aaddec4c8205db2251bcaa))
* **desktop:** add model selection commands and ui ([70b99f4](https://github.com/dsswift/ion/commit/70b99f46191e6436898d0943a264f0d4ee4fd66b))

## [1.20.0](https://github.com/dsswift/ion/compare/desktop-v1.19.0...desktop-v1.20.0) (2026-05-12)

### Features

* **desktop:** add two-tier secret encryption at rest ([ec22e54](https://github.com/dsswift/ion/commit/ec22e54f3b168d2fc8d68fa29160df10a27b281d))

## [1.19.0](https://github.com/dsswift/ion/compare/desktop-v1.18.1...desktop-v1.19.0) (2026-05-11)

### Features

* **desktop:** wire steer_agent for mid-run messages ([82b883b](https://github.com/dsswift/ion/commit/82b883b18be93420f16b0189d6df523f9b4ef32a))

### Bug Fixes

* **desktop:** emit session_init for queued prompt transitions ([371208b](https://github.com/dsswift/ion/commit/371208bd3b4173a0f78e0d6bc5f2d1e25b079cc9))
* **desktop:** detect staged flag in git polling diff ([1a49387](https://github.com/dsswift/ion/commit/1a4938792f58379bf59bbf38837148f8ebcc7d48))
* **desktop:** move commit input to dedicated row ([6d17a2c](https://github.com/dsswift/ion/commit/6d17a2c30b77cd297d7cd4b5cf63ce1ef07a2d74))

## [1.18.1](https://github.com/dsswift/ion/compare/desktop-v1.18.0...desktop-v1.18.1) (2026-05-11)

### Bug Fixes

* **desktop:** add x64ArchFiles for node-pty universal build ([f04f6e1](https://github.com/dsswift/ion/commit/f04f6e1b911b8bee9e86b795c1e1548fb100d5aa))

## [1.18.0](https://github.com/dsswift/ion/compare/desktop-v1.17.0...desktop-v1.18.0) (2026-05-11)

### Features

* **desktop:** handle engine_events_dropped event ([a4c46d4](https://github.com/dsswift/ion/commit/a4c46d4bdb5ea77a9314fa829e09e64e0f9d0246))

## [1.17.0](https://github.com/dsswift/ion/compare/desktop-v1.16.0...desktop-v1.17.0) (2026-05-10)

### Features

* **engine:** add system hint to engine config ([79fa965](https://github.com/dsswift/ion/commit/79fa965e4a32ce4528ace67b32d60502ab4f2082))
* **desktop:** add plan mode event to normalized events ([2acfea2](https://github.com/dsswift/ion/commit/2acfea23d8cffc91e35c3775e616e2e8e0dcb8c3))

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

