# Changelog

All notable changes to the desktop app will be documented here. This file is
maintained by the release pipeline; do not edit by hand.

## 1.0.0 - 2026-04-28

Initial 1.0.0 baseline. Reference Electron desktop client for Ion Engine.
Demonstrates the engine's daemon architecture and multi-client broadcast.

Subsequent versions will be auto-generated from conventional commit messages.

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

