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

## [1.43.0](https://github.com/dsswift/ion/compare/engine-v1.42.0...engine-v1.43.0) (2026-07-03)

### Features

* **engine:** read-triggered nested context loading ([3848a9e](https://github.com/dsswift/ion/commit/3848a9e99e9606d1779161c63afdbd0f59fea225))
* **engine:** add launchd daemon with socket activation ([85314c1](https://github.com/dsswift/ion/commit/85314c1273b0ec12a242309d1319922a060df759))
* **engine:** unify plain and extension-hosted conversations (#256) ([88de466](https://github.com/dsswift/ion/commit/88de46675eaacf55ed502f522b92d35db77f5644))
* **engine:** emit plan_file_written marker on actual plan write ([8b4f4f9](https://github.com/dsswift/ion/commit/8b4f4f949b6faa56de9b4602a215dbebe0baa50c))
* **engine:** add steer_dispatch wiring and tests ([17aeb6e](https://github.com/dsswift/ion/commit/17aeb6ea4b4c0e7da5126355b5cb2b3ece572e89))
* **engine:** bound daemon memory with GOMEMLIMIT to survive OS pressure ([98ab4c8](https://github.com/dsswift/ion/commit/98ab4c85d042f253c361f06b6fad1fe9487505e6))
* **engine:** add tiktoken-go BPE tokenizer + Tokenizer field to model catalog ([6220724](https://github.com/dsswift/ion/commit/62207245f63d7bb02d878e03e1e21a128086dc47))
* **engine:** ion-meta message_end hook consumes context_breakdown ([3e3ebf3](https://github.com/dsswift/ion/commit/3e3ebf302b45965ba39abfbf1860b2a10ec6b05f))
* **desktop:** ion-meta hook integration test ([9fd88e7](https://github.com/dsswift/ion/commit/9fd88e7bca7da05dc536376acef14ab1915653a7))

### Bug Fixes

* **engine:** order tool_results before images for anthropic ([03d643e](https://github.com/dsswift/ion/commit/03d643e10d601a47bef47f763b4a62467a1769a5))
* **engine:** stop counting image base64 bytes as context tokens ([7b7ffe9](https://github.com/dsswift/ion/commit/7b7ffe95ee4dea17b9f914340fa7fe000619c57a))
* **engine:** redirect stray plan-mode writes to canonical plan file ([d080e5d](https://github.com/dsswift/ion/commit/d080e5dc991e8efed10968857251a45b05622d49))
* **engine:** append tool alias directive for CLI MCP bridge ([b1e2282](https://github.com/dsswift/ion/commit/b1e2282b92e9473faae8b6deb445edc6752b770a))
* **engine:** key agent-state store by dispatch ID not name ([2178427](https://github.com/dsswift/ion/commit/2178427ae3236417e9a52f6704a213ab81bc224a))
* **desktop:** update agent-state dispatch ID tests ([d972b03](https://github.com/dsswift/ion/commit/d972b03a0e89096c84b2eaab7f2580570213e592))
* **engine:** add micro-only signal and harden micro-compaction ([9a1cd5d](https://github.com/dsswift/ion/commit/9a1cd5d36da8bcb7af287f666efa4573b927dfdf))
* **engine:** scrub renderer-flavored language from engine code and logs ([f02c353](https://github.com/dsswift/ion/commit/f02c3538bb9c499f2525506eb2cafc0c871af356))
* **engine:** split memstat sysctl to darwin-only build tag ([5f36661](https://github.com/dsswift/ion/commit/5f3666101f6cc2a7bf9b333cf7e65fb549dcaa3d))
* **engine:** honor explicit SessionID unconditionally on session start ([1a3df69](https://github.com/dsswift/ion/commit/1a3df695230548b012bc061df3562000db96b305))
* **engine:** make heartbeat shutdown test deterministic ([4ad080c](https://github.com/dsswift/ion/commit/4ad080ccb33d86b40cddf00a4559d6325afcc84a))

## [1.42.0](https://github.com/dsswift/ion/compare/engine-v1.41.0...engine-v1.42.0) (2026-06-19)

### Features

* **engine:** add filesystem slash-command resolution and fork execution ([cb70d88](https://github.com/dsswift/ion/commit/cb70d882d9c5bd12988f400582a378f468fc612f))

### Bug Fixes

* **engine:** drop queued prompts on abort so post-stop prompt runs ([0ff14bc](https://github.com/dsswift/ion/commit/0ff14bc0192c2f8d4c7a17be388506681865da97))

## [1.41.0](https://github.com/dsswift/ion/compare/engine-v1.40.0...engine-v1.41.0) (2026-06-18)

### Features

* **engine:** add get_plan_content command + event (#240) ([502d1a2](https://github.com/dsswift/ion/commit/502d1a20032ba25866705ffb8685096c46329f89))
* **engine:** reap orphaned sessions; configurable limits ([b11fda5](https://github.com/dsswift/ion/commit/b11fda54459194d00a3b6d3cdb41898b9e5f884a))
* **engine:** login-shell Bash + sendPrompt config carry (#242) ([40600d3](https://github.com/dsswift/ion/commit/40600d38eeaffa99dcc7d3b982d6a1c03cabf958))
* **engine:** extended-thinking events + telemetry (#158) ([f057a60](https://github.com/dsswift/ion/commit/f057a600c1a2f0876485fa91f35b340d18885c9e))
* **engine:** effort-based thinking across anthropic, openai, google ([653c738](https://github.com/dsswift/ion/commit/653c73875fb8bd53b404cfd28959d38958292ba6))

### Bug Fixes

* **engine:** plan-content symlink guard + thinking-strip pin ([8cf11ff](https://github.com/dsswift/ion/commit/8cf11ffef3a3db4749b2d6414780f5e39a0fec15))

## [1.40.0](https://github.com/dsswift/ion/compare/engine-v1.39.1...engine-v1.40.0) (2026-06-16)

### Features

* **engine:** emit run.complete telemetry for all backends (#234) ([4de6dcc](https://github.com/dsswift/ion/commit/4de6dcc8633524ed0cedab0c1c264cadb2d6837b))
* **engine:** add wildcard resource subscription (#179) ([744a5b0](https://github.com/dsswift/ion/commit/744a5b036997ec0a63dbc6503451a9b0e7541ee5))

### Bug Fixes

* **engine:** isolate HOME in config load tests ([5d2f9c9](https://github.com/dsswift/ion/commit/5d2f9c9f36eb64865bf082f1c7e87e14814a4abd))
* **engine:** guarantee synthesized tool_use ID uniqueness ([0a30f43](https://github.com/dsswift/ion/commit/0a30f43a95fdd8c2cb175bc54289612250117466))
* **engine:** make heartbeat tests load-robust under linux -race (#239) ([f746969](https://github.com/dsswift/ion/commit/f746969d67d6b1941c222b40e0ac2063d686de73))
* **engine:** de-flake watchdog stall test under linux -race (#239) ([e517312](https://github.com/dsswift/ion/commit/e517312c21086f2eea91d4c6dffb04bcf58bbf6f))

## [1.39.1](https://github.com/dsswift/ion/compare/engine-v1.39.0...engine-v1.39.1) (2026-06-15)

## [1.39.0](https://github.com/dsswift/ion/compare/engine-v1.38.0...engine-v1.39.0) (2026-06-15)

### Features

* **engine:** add CompactNow capability and engine_export constant ([b52bf31](https://github.com/dsswift/ion/commit/b52bf31995e9321e3290331b103a085ebf130559))
* **engine:** rename dead Engine* instance vocab to Conversation* ([94ad974](https://github.com/dsswift/ion/commit/94ad9743e32499c520982e5606c05d1e1d87590b))
* **engine:** add ion-meta log and transcript introspection (#228) ([b05779d](https://github.com/dsswift/ion/commit/b05779d7081675eb9e427249a1d2b7f30c775962))
* **engine:** explicit fresh-conversation path for restart (#231) ([624f4da](https://github.com/dsswift/ion/commit/624f4dac13fc04980776967976661a9ea640691e))
* **engine:** session-rooted cancellation context tree (#232) ([d82d4bc](https://github.com/dsswift/ion/commit/d82d4bcbafc89cdca29828c75d2f7026848c3760))
* **engine:** evolve llmCall opts + async concurrency (#225,#226) ([fde8acc](https://github.com/dsswift/ion/commit/fde8acc46edd43f994b523be5963c7877a939b7e))
* **engine:** add IsRoot flag and agentName to before_agent_start (#227) ([157e388](https://github.com/dsswift/ion/commit/157e38895843ea3ba7fdee25e5590eda07208066))

### Bug Fixes

* **engine:** serialize file-mutating tools on same path ([ce59ae6](https://github.com/dsswift/ion/commit/ce59ae6e3d04848edb4a1a001702782415420068))
* **engine:** prevent cache_control on empty text blocks ([e779dfa](https://github.com/dsswift/ion/commit/e779dfa122cc24aa2f29e1727abf114af91d1632))
* **engine:** clear pending denials on /clear ([91b296f](https://github.com/dsswift/ion/commit/91b296ff97d588bd4f819a6eda8f3ffaf7ec8477))
* **engine:** use fmt.Fprintf in tools_files_test (lint) ([e97d13a](https://github.com/dsswift/ion/commit/e97d13abd329796b7134616741b27ec808b860b6))
* **engine:** add agentName to BeforeAgentStartResult SDK type ([7af4892](https://github.com/dsswift/ion/commit/7af489252b6667f6642c5323526ea60b8213fe35))
* **engine:** repair openai-compatible stream tool args + errors (#229) ([76789c0](https://github.com/dsswift/ion/commit/76789c04346fb3d4d08b86e559218f8516b007bf))
* **engine:** stop pinning stale command-type magic number ([998ed68](https://github.com/dsswift/ion/commit/998ed685adf810f440c4212d5ffb94fc98b1f6c9))

## [1.38.0](https://github.com/dsswift/ion/compare/engine-v1.37.0...engine-v1.38.0) (2026-06-12)

### Features

* **engine:** add resource subsystem with broker, SDK, and client wiring (#180) ([6d9241e](https://github.com/dsswift/ion/commit/6d9241ee17d27008fa83f14731048c146b0c9012))
* **engine:** add notification SDK with ctx.notify (#181) ([7fdb6ed](https://github.com/dsswift/ion/commit/7fdb6edaa0765818f5fbe565d90ea8a527e5356c))
* **engine:** add plan-mode auto-exit safety net (#187) ([7ce9eb0](https://github.com/dsswift/ion/commit/7ce9eb0847433f0430f281ebff04f1e252d90007))
* **engine:** add scheduler concurrency dedup (#186) ([1ba9472](https://github.com/dsswift/ion/commit/1ba9472f3533cccddb52bcdbe6938ec07f5f9181))
* **engine:** add model fallback on unresolved tier alias (#174) ([5ed274a](https://github.com/dsswift/ion/commit/5ed274a1916fbeedd1feb0868b71f3c59f23c077))
* **engine:** add ctx.intercept subsystem with event routing ([4391031](https://github.com/dsswift/ion/commit/4391031006b1564068b9b7047b53230bbeaab8db))
* **engine:** add agent colors and expand skill-author docs ([6face66](https://github.com/dsswift/ion/commit/6face6699e67b6004c02291ec1279bd31a06bc3e))
* **engine:** add conversation cleanup with mtime-based expiry (#208) ([eeb2179](https://github.com/dsswift/ion/commit/eeb21795cb68e1a75b1e08e655d7e0c05d0ccdfe))
* **engine:** add run-progress watchdog and dispatch panic recovery ([e5a1b26](https://github.com/dsswift/ion/commit/e5a1b26129564d8749fc3aebf7481332dd512d08))
* **engine:** add typed session status events and lock down status writers ([ccc5d51](https://github.com/dsswift/ion/commit/ccc5d517884f4a25d787a4a95252728663aa1459))
* **engine:** add ctx.runOnce cross-instance dedup primitive ([d58ef9d](https://github.com/dsswift/ion/commit/d58ef9d2f969ecb4d020e0221bb66f402f3e98c5))
* **engine:** expose conversationId on extension context (#213) ([490acf9](https://github.com/dsswift/ion/commit/490acf9babc18c9956faa46493c7dac48105b81c))

### Bug Fixes

* **engine:** add watcher diagnostic logging and process-start marker (#210) ([0de2471](https://github.com/dsswift/ion/commit/0de2471544ab73be5402b8edd96e59ffc1aabbec))
* **engine:** raise scanner buffer to 4MB and improve heartbeat handling ([4b8c064](https://github.com/dsswift/ion/commit/4b8c0649866582f5390d9819ec5ef42396706885))
* **engine:** update session resume test for pre-minted conversation ID ([b6b59c9](https://github.com/dsswift/ion/commit/b6b59c9117b44f29bced4687752568bae823f535))

## [1.37.0](https://github.com/dsswift/ion/compare/engine-v1.36.0...engine-v1.37.0) (2026-06-05)

### Features

* **engine:** fall back to default model on unresolved tier alias (#174) ([4a9d7af](https://github.com/dsswift/ion/commit/4a9d7af0d9cc017df65de66fff33d3b49accda6d))

## [1.36.0](https://github.com/dsswift/ion/compare/engine-v1.35.0...engine-v1.36.0) (2026-06-05)

### Features

* **engine:** wire task_created/completed for Cli and Api backends (#175) ([4d4bd26](https://github.com/dsswift/ion/commit/4d4bd2683849b2d8b271b7787c1a0266b4c001fb))
* **engine:** configurable bash commands in plan mode ([d7e6c5f](https://github.com/dsswift/ion/commit/d7e6c5f7fa0dd2695e54a7f96809db586c0217b2))
* **engine:** per-prompt bash allowlist additions (no session-state mutation) ([184a16f](https://github.com/dsswift/ion/commit/184a16f5b33f4add261be0f02f9a870efa2ed132))

### Bug Fixes

* **engine:** resolve tier aliases in agent spawner (#174) ([0d1425f](https://github.com/dsswift/ion/commit/0d1425f86353033a2fae8e1ad74422d6af7f0cb7))
* **engine:** implement MCP compliance for CliBackend (#182) ([2cf94ea](https://github.com/dsswift/ion/commit/2cf94ea26c531e1bbfdfb6be789710af5744c5f4))
* **engine:** replace single-slot currentCtx with ctxStack (#183) ([e5c4dbe](https://github.com/dsswift/ion/commit/e5c4dbe4e1e760fc195c915de279571ea26cc582))

## [1.35.0](https://github.com/dsswift/ion/compare/engine-v1.34.1...engine-v1.35.0) (2026-06-04)

### Features

* **engine:** inject steer messages before end_turn exit ([3c5e534](https://github.com/dsswift/ion/commit/3c5e53418393f5cdacbb90ccc1e63d6b6fcd7e22))

## [1.34.1](https://github.com/dsswift/ion/compare/engine-v1.34.0...engine-v1.34.1) (2026-06-03)

### Bug Fixes

* **engine:** preserve corrected agent display names ([af89801](https://github.com/dsswift/ion/commit/af89801870f9ee3be19e87aacd116d7ca3b5923b))
* **engine:** structurally dedupe compaction summaries ([806f298](https://github.com/dsswift/ion/commit/806f2985cccca8a8614b4f759f7a8924f6f12dfb))
* **engine:** pin compact_boundary wire and persistence contracts ([100c9fb](https://github.com/dsswift/ion/commit/100c9fb155bd0c931dd602b22c55dff60a28cf37))
* **engine:** thread compact strategy through OnRequestCompactSummary ([781dc72](https://github.com/dsswift/ion/commit/781dc72cf1ec031a069d84e1bdeae63c368c3736))
* **engine:** add proactive-path compact_boundary injection test ([2466d54](https://github.com/dsswift/ion/commit/2466d5443a0670918da9206dec244607810edc5f))
* **engine:** cover FireCompactSummaryRequest fan-out return shapes ([7703d40](https://github.com/dsswift/ion/commit/7703d40647be26f34b8d7e347ccdc3d66cac448d))
* **engine:** unwrap _payload in SDK runtime for string hook payloads (#170) ([88231df](https://github.com/dsswift/ion/commit/88231df66d2f624c0a5d680410c90e3d88360b66))
* **engine:** deduplicate tool names in dispatched agent sessions (#171) ([9432f13](https://github.com/dsswift/ion/commit/9432f13fba62be4a6676196ce83135ea34707b94))

## [1.34.0](https://github.com/dsswift/ion/compare/engine-v1.33.0...engine-v1.34.0) (2026-06-02)

### Features

* **engine:** aggregate dispatches into pager with array model ([5d9cf05](https://github.com/dsswift/ion/commit/5d9cf057a46f69302699867adcca7241f94ebd17))
* **engine:** add dispatch conversation e2e test ([7465729](https://github.com/dsswift/ion/commit/74657294b60263f0a34ee072af997bef3ba4ffaf))
* **engine:** support dynamic openai-compatible providers ([9274c88](https://github.com/dsswift/ion/commit/9274c88fb539f739ec57ee6e51cb158a48825276))
* **engine:** add ext display name lookup for agents ([079e353](https://github.com/dsswift/ion/commit/079e353ae7d3fa55d036cd12bb09bbea8c862780))

### Bug Fixes

* **engine:** atomic AppendOrUpdate to prevent duplicate agent rows ([dd1eeef](https://github.com/dsswift/ion/commit/dd1eeef139540d45f1839bbf7909070cdb25457b))
* **engine:** add compaction diagnostic logging and fix reactive TokensBefore bug ([f7b1783](https://github.com/dsswift/ion/commit/f7b17837d59245ded011230cf4276af512067cc9))
* **engine:** bump conversation JSONL scanner limit from 1 MB to 32 MB ([f45f309](https://github.com/dsswift/ion/commit/f45f309e21bdd35844372e6adc2f27bd33b66473))
* **engine:** fix stale session memory in compaction system ([8258794](https://github.com/dsswift/ion/commit/8258794518a9e2c7f5acf1eb6e0a342047aa85f7))
* **engine:** preserve background dispatch agent visibility on run exit ([884d853](https://github.com/dsswift/ion/commit/884d8530f66423256399500f396afdca06105623))
* **engine:** cap tool result size, persist model override, improve memory quality ([387190d](https://github.com/dsswift/ion/commit/387190d6dd79780fb3c04ea8a9fd3c6b854581e0))
* **engine:** respect compaction boundaries in BuildContextPath ([2b8afc4](https://github.com/dsswift/ion/commit/2b8afc49f248d6e01d942ab2f484c2e003c160e3))
* **engine:** seed lastModel from conversation on session resume ([74e324b](https://github.com/dsswift/ion/commit/74e324b6d1c2cda96c5e2c188a053509e7e36f32))
* **engine:** prevent aggressive compaction on resumed conversations ([b5a58d7](https://github.com/dsswift/ion/commit/b5a58d7d6801780e63c85712f570e7c460032f6f))
* **engine:** resolve planFilePath from session when ExitPlanMode runs outside plan mode ([79890a3](https://github.com/dsswift/ion/commit/79890a31cbb47f0867abd8b4e0cf280f2f4ddcab))
* **engine:** restore provider registry after tests ([2e4b443](https://github.com/dsswift/ion/commit/2e4b44312a00869263953bb2ad0d624ece1e670a))

## [1.33.0](https://github.com/dsswift/ion/compare/engine-v1.32.0...engine-v1.33.0) (2026-06-01)

### Features

* **engine:** add session memory and compaction system ([993a5f2](https://github.com/dsswift/ion/commit/993a5f241985dcb8cad819b31c82c76780088107))

## [1.32.0](https://github.com/dsswift/ion/compare/engine-v1.31.2...engine-v1.32.0) (2026-06-01)

### Features

* **engine:** add plan mode fields to dispatch agent opts and result ([5249421](https://github.com/dsswift/ion/commit/5249421d9b155829c62a51993837f9afc14067e4))

### Bug Fixes

* **engine:** populate AgentID, simplify OnPlanProposal, add logging ([15c96a8](https://github.com/dsswift/ion/commit/15c96a8f949f3795b0f4658a26b316199d047765))

## [1.31.2](https://github.com/dsswift/ion/compare/engine-v1.31.1...engine-v1.31.2) (2026-05-31)

### Bug Fixes

* **engine:** intercept exit plan mode in all modes ([30b094d](https://github.com/dsswift/ion/commit/30b094d034a74977351dceabdaecffa189045759))

## [1.31.1](https://github.com/dsswift/ion/compare/engine-v1.31.0...engine-v1.31.1) (2026-05-31)

### Bug Fixes

* **engine:** extract rlimit init to platform-specific files for windows cross-compilation ([d2003cd](https://github.com/dsswift/ion/commit/d2003cd6a5508a2acb73ebc161f1b71df1893117))

## [1.31.0](https://github.com/dsswift/ion/compare/engine-v1.30.1...engine-v1.31.0) (2026-05-31)

### Features

* **engine:** add ion-meta v2 with tool catalog, greeting, and three-mode dispatch ([61688af](https://github.com/dsswift/ion/commit/61688af40fb28d7b8695e5de9cf0b950e54757a4))
* **engine:** add session context to sdk event types ([749d2c4](https://github.com/dsswift/ion/commit/749d2c4654d98c379b099f107cf2b39d08078b04))
* **engine:** add agent dispatch lifecycle with redispatch ([f9fff27](https://github.com/dsswift/ion/commit/f9fff27fccee90c2193214071c6a96aac47d493a))
* **engine:** persist and restore dispatch agent state ([9351d98](https://github.com/dsswift/ion/commit/9351d98f00b201bb82dd717975b62064c8037f20))
* **engine:** add ion scope slash command support ([0d8a94b](https://github.com/dsswift/ion/commit/0d8a94b342870bc9e72f16490e8e9ad65d5d334d))
* **engine:** add agent dispatch lifecycle hook tests ([3fb279e](https://github.com/dsswift/ion/commit/3fb279ead813f191ceb00c0b001becd64c119121))

### Bug Fixes

* **engine:** skip workspace watcher when cwd is ion home ([632f170](https://github.com/dsswift/ion/commit/632f170fdbc0bc5cc7be21513cfd94be9ee9dd6b))
* **engine:** fix CI failures in integration tests and desktop test ([cbbf4a6](https://github.com/dsswift/ion/commit/cbbf4a63975f2c741fa88af0aa8d231323ac66c9))

## [1.30.1](https://github.com/dsswift/ion/compare/engine-v1.30.0...engine-v1.30.1) (2026-05-28)

### Bug Fixes

* **engine:** retain pending permission denials for reconcile ([2adba4f](https://github.com/dsswift/ion/commit/2adba4ff507e1aa9ce4b92f282ddcae2219f9f92))

## [1.30.0](https://github.com/dsswift/ion/compare/engine-v1.29.3...engine-v1.30.0) (2026-05-27)

### Features

* **engine:** improve ask user question tool instructions ([f15a7f9](https://github.com/dsswift/ion/commit/f15a7f9cb660b03be199797196a5881b721819eb))
* **engine:** clarify plan mode exit timing in prompts ([f1906b5](https://github.com/dsswift/ion/commit/f1906b5279d079a790466ee8fe1e37fa46e9fbba))

## [1.29.3](https://github.com/dsswift/ion/compare/engine-v1.29.2...engine-v1.29.3) (2026-05-27)

### Bug Fixes

* **engine:** surface cache token fields on DispatchAgentResult (#146) ([ecb020b](https://github.com/dsswift/ion/commit/ecb020bca7067c59a242a8bd2ea232e7ff90fe8d))

## [1.29.2](https://github.com/dsswift/ion/compare/engine-v1.29.1...engine-v1.29.2) (2026-05-26)

### Bug Fixes

* **engine:** add logging to fs_browse and list_models ([2aafbb1](https://github.com/dsswift/ion/commit/2aafbb15c7e315c19fa1cbe71aa610ebba578447))
* **engine:** extract buildProviderEntries and add CLI-auth tests ([669c124](https://github.com/dsswift/ion/commit/669c124f89277128b661eb9f3c20b9aed33013e6))

## [1.29.1](https://github.com/dsswift/ion/compare/engine-v1.29.0...engine-v1.29.1) (2026-05-26)

### Bug Fixes

* **engine:** mark anthropic provider authed when CLI backend is in use ([6e17630](https://github.com/dsswift/ion/commit/6e17630481bffd107cf6e136344c878e53a83b43))

## [1.29.0](https://github.com/dsswift/ion/compare/engine-v1.28.0...engine-v1.29.0) (2026-05-26)

### Features

* **engine:** add get_host_info and list_directory RPCs ([a1d4bca](https://github.com/dsswift/ion/commit/a1d4bcaa87f758af13219674dc6b18f472314fba))

## [1.28.0](https://github.com/dsswift/ion/compare/engine-v1.27.0...engine-v1.28.0) (2026-05-26)

### Features

* **engine:** deduplicate filesystem watchers across sessions ([9f53926](https://github.com/dsswift/ion/commit/9f5392647e1d0db3cc5f1cc7e135ed7f003742c0))

## [1.27.0](https://github.com/dsswift/ion/compare/engine-v1.26.1...engine-v1.27.0) (2026-05-26)

### Features

* **engine:** add ctx.LLMCall lightweight inference primitive ([73ee012](https://github.com/dsswift/ion/commit/73ee012c4248dc52ce320c359aedae80403591f7))

## [1.26.1](https://github.com/dsswift/ion/compare/engine-v1.26.0...engine-v1.26.1) (2026-05-26)

### Bug Fixes

* **engine:** normalize paths in plan mode write gate ([554722b](https://github.com/dsswift/ion/commit/554722b9f23bd58472cf1ca591af5226c3ea49d2))
* **engine:** persist and restore planFilePath across restarts ([e0a9f69](https://github.com/dsswift/ion/commit/e0a9f69a323df5afc3316da04b45c34ef5b8762c))
* **engine:** replace [plan-file] in entries, not just messages ([71ee236](https://github.com/dsswift/ion/commit/71ee23621a44a9f6b40ee08eeac5da5d1d95a602))

## [1.26.0](https://github.com/dsswift/ion/compare/engine-v1.25.0...engine-v1.26.0) (2026-05-25)

### Features

* **engine:** add asyncreg registry and async-trigger SDK types ([517d79b](https://github.com/dsswift/ion/commit/517d79b31e53db2fc63a7fa7bba9497c6b506fd3))
* **engine:** wire host async-trigger registry and dynamic RPCs ([6ec61cc](https://github.com/dsswift/ion/commit/6ec61cc465ed59a2318793e10190da924d478319))
* **engine:** webhook HTTP server with auth and route dispatch ([90c4100](https://github.com/dsswift/ion/commit/90c41001ad620a65c1f89f73e930aeb1ae7c8d58))
* **engine:** scheduler with daily/weekly/interval kinds ([027086a](https://github.com/dsswift/ion/commit/027086a28b803b6ede11509e3513798fc366f720))
* **engine:** wire async-trigger subsystems into session manager ([6a2ee54](https://github.com/dsswift/ion/commit/6a2ee548fe35ec73679b5e39221cea81336ba9d8))
* **engine:** sdk runtime for ion.webhooks and ion.schedule ([02bb77f](https://github.com/dsswift/ion/commit/02bb77f0c2558db5530bbca47f139db3c2f98c7c))

### Bug Fixes

* **engine:** lint fixes for asyncreg and webhooks ([1c2f1f5](https://github.com/dsswift/ion/commit/1c2f1f513c2a6e125dfedfdf07815bae2e666c34))

## [1.25.0](https://github.com/dsswift/ion/compare/engine-v1.24.0...engine-v1.25.0) (2026-05-25)

### Features

* **engine:** bridge getContextUsage and searchHistory (#127) ([59e0eb4](https://github.com/dsswift/ion/commit/59e0eb43e6b0ad8c6684aee17319bb53ed141de9))
* **desktop:** unify slash pipeline + /clear checkpoint ([1a3894d](https://github.com/dsswift/ion/commit/1a3894dd2073077b90b98efb9cfec511bce284a9))
* **engine:** early-stop continuation with opt-in wire protocol ([5f79236](https://github.com/dsswift/ion/commit/5f7923647e084ccd2be1ef1f3daf4d00bba7f3d8))
* **engine:** publish command registry and unknown-command result ([9621103](https://github.com/dsswift/ion/commit/962110303b577a2dd08ee9384fae3652390fc73b))
* **engine:** surface compaction facts to session_compact (#129) ([7923705](https://github.com/dsswift/ion/commit/7923705652b3afa290c326962185a47ddff4941d))
* **engine:** plan-mode lifecycle with implementation phase ([10e63c4](https://github.com/dsswift/ion/commit/10e63c4dc8f4ca85991b323c24744882bca54037))
* **engine:** add workspace_file_changed hook + watcher (#130) ([e8377e9](https://github.com/dsswift/ion/commit/e8377e96a91704524d430c13ec538031c3826608))
* **engine:** add engine_plan_proposal workflow event ([844feaf](https://github.com/dsswift/ion/commit/844feaf5f08d0f1dc1c790190f0eddd4cd0074bf))

### Bug Fixes

* **engine:** wire before_provider_request hook (#128) ([d969bd5](https://github.com/dsswift/ion/commit/d969bd5fa2ebca0f003b38b97f1d3f937784624d))
* **engine:** wire agent_start / agent_end hooks (#126) ([7c9373b](https://github.com/dsswift/ion/commit/7c9373b05c699efab2015638eb2237906abb7873))
* **engine:** /clear leak + expand Skill tool with claude-skills manifest ([b7f1b2b](https://github.com/dsswift/ion/commit/b7f1b2bc423384aad95189b29c9c48ca8ac45c6f))
* **engine:** split conversation persistence to fix /clear (#146) ([b512bfd](https://github.com/dsswift/ion/commit/b512bfddedb0a6faf1e9c20edcb0c8a7a5d8449f))
* **engine:** replace sleep with poll in ion serve test ([6b71fae](https://github.com/dsswift/ion/commit/6b71fae57dc08211ab79d5a9986958249b9fbdf9))

## [1.24.0](https://github.com/dsswift/ion/compare/engine-v1.23.3...engine-v1.24.0) (2026-05-23)

### Features

* **engine:** add hybrid backend routing ([1e530d1](https://github.com/dsswift/ion/commit/1e530d15dc4d43981979015a0a6c7742c7c61346))

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

