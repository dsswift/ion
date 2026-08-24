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

## [1.75.0](https://github.com/dsswift/ion/compare/engine-v1.74.0...engine-v1.75.0) (2026-08-24)

### Features

* **engine:** publish a run epoch on every status snapshot ([a9b387e](https://github.com/dsswift/ion/commit/a9b387ee11c5208aac8fe0a1f7a5719c70d25f5f))

## [1.74.0](https://github.com/dsswift/ion/compare/engine-v1.73.0...engine-v1.74.0) (2026-08-23)

### Features

* **engine:** improve conversation workflow state ([13370b2](https://github.com/dsswift/ion/commit/13370b232666b6fa83eefa07a3a8e0212a897c9f))

### Bug Fixes

* **engine:** harden durable file persistence ([d9f32ff](https://github.com/dsswift/ion/commit/d9f32ff1e272fcea0b1d76738ab95423d2d96753))
* **engine:** support Windows durable temp cleanup ([a5df90b](https://github.com/dsswift/ion/commit/a5df90b43e512eaf301c3e79522b2e493d7c4c11))

## [1.73.0](https://github.com/dsswift/ion/compare/engine-v1.72.0...engine-v1.73.0) (2026-08-23)

### Features

* **engine:** add background task controls ([9521055](https://github.com/dsswift/ion/commit/952105507f79b21ae2f02c184bd9a109c4a18615))

### Bug Fixes

* **engine:** guide background waits to park ([92e68d4](https://github.com/dsswift/ion/commit/92e68d4dd201ab0c6fff62a7845671c0feb2cbc8))
* **engine:** stop timed-out prompts without deadlock ([cb5e249](https://github.com/dsswift/ion/commit/cb5e249e830fc14f5ebb753f7ca674ee4742da9b))
* **engine:** stabilize dispatch integration cleanup ([d33cb31](https://github.com/dsswift/ion/commit/d33cb319d23bb5aecdb4585712d34d86806299b0))
* **engine:** align dispatch integration controls ([8065807](https://github.com/dsswift/ion/commit/80658079cb57f314fb99716afff496518b7c32cf))

## [1.72.0](https://github.com/dsswift/ion/compare/engine-v1.71.1...engine-v1.72.0) (2026-08-22)

### Features

* **engine:** modernize mcp protocol support ([5dcb8bd](https://github.com/dsswift/ion/commit/5dcb8bd845d426ac7befabffd9a7ba1bebe4473f))
* **engine:** wire settle/resume commands through server dispatch ([b9d7f33](https://github.com/dsswift/ion/commit/b9d7f3372bae0b319dd30d78534017253cec30f6))
* **engine:** add resolve_permission_denials to release retained denials ([0612157](https://github.com/dsswift/ion/commit/06121573cb6f90eb59145cb96f059768a28333aa))

### Bug Fixes

* **engine:** restore reliable generated titles ([e549701](https://github.com/dsswift/ion/commit/e549701b6f5c565225297bcc98f0e1776706d3dc))
* **engine:** retain status detail across log storms and title checks ([0318c6f](https://github.com/dsswift/ion/commit/0318c6fb7f8091d4c1ccea5955a31ec2b6bf4145))
* **engine:** omit removed landed worktrees from list ([39ba45c](https://github.com/dsswift/ion/commit/39ba45c454a5434be5eb15ce586abe17e752d650))
* **engine:** harden tool execution, telemetry, and permission release ([a4cea56](https://github.com/dsswift/ion/commit/a4cea56bcf91b4fb70fab10bde6b2a916acf955c))
* **engine:** test dispatch panic recovery directly ([d90e1a2](https://github.com/dsswift/ion/commit/d90e1a24ec00c8b8aacc8ab2cee689570077d031))
* **engine:** initialize mcp integration client ([c23d9f1](https://github.com/dsswift/ion/commit/c23d9f1e4c33c27fe73552fd255e1dac10272b53))

## [1.71.1](https://github.com/dsswift/ion/compare/engine-v1.71.0...engine-v1.71.1) (2026-08-20)

### Bug Fixes

* **engine:** make ctxStack release identity-scoped, not blind top-of-stack ([2217315](https://github.com/dsswift/ion/commit/22173157bb3ec37c83873890f0ef8bcb3873aad4))

## [1.71.0](https://github.com/dsswift/ion/compare/engine-v1.70.0...engine-v1.71.0) (2026-08-18)

### Features

* **engine:** add automatic run recovery ([1ededa2](https://github.com/dsswift/ion/commit/1ededa22caa9b18c099cb2c9867a80952daa57f3))

### Bug Fixes

* **engine:** compact to target after micro pass ([103317b](https://github.com/dsswift/ion/commit/103317b22b74e1f70567155c6344c87bfed874d0))
* **engine:** make prompt delivery idempotent ([4f5a9f3](https://github.com/dsswift/ion/commit/4f5a9f33aafd03538177a6cdfcac7abffe5308e2))
* **engine:** deliver missed schedule catch-up ([067c4e9](https://github.com/dsswift/ion/commit/067c4e95186fd6e4499b553559ac50aab7edbc1c))

## [1.70.0](https://github.com/dsswift/ion/compare/engine-v1.69.0...engine-v1.70.0) (2026-08-14)

### Features

* **engine:** document full agent-state recovery ([dd268dd](https://github.com/dsswift/ion/commit/dd268dd2583c69da3a5e58fe4e343e422945202e))
* **engine:** contain landed worktree context ([989ed52](https://github.com/dsswift/ion/commit/989ed52a6b8508a5dd80d8a634e6ea27293bb64f))

### Bug Fixes

* **engine:** preserve agent state beyond broadcast bounds ([4d8898c](https://github.com/dsswift/ion/commit/4d8898cc519e3c28faa8fc0c891b9eef904bc780))
* **engine:** keep protected metadata exact ([6af9ab7](https://github.com/dsswift/ion/commit/6af9ab7f227e294ff9794ea10b81ca3110247633))
* **engine:** detach full agent-state responses ([975dc50](https://github.com/dsswift/ion/commit/975dc50b5a7451162432dfdef3e21305cb11d1da))
* **engine:** restore terminal dispatch members ([564933c](https://github.com/dsswift/ion/commit/564933c53457063b1207447a29f5fd89508ff1cf))
* **engine:** persist dispatched child transcripts ([510ecab](https://github.com/dsswift/ion/commit/510ecab9a5586d46cb5c1b092a9e616de7ab5c61))
* **engine:** bound protected agent metadata ([ef3ca7a](https://github.com/dsswift/ion/commit/ef3ca7aa615d5ab0843878f8472f48a86ad3bff3))
* **engine:** retain reused native dispatch transcripts ([9983b42](https://github.com/dsswift/ion/commit/9983b422972ab9fee4b97a26bb48a5c004df4442))
* **engine:** decode transcript mirror ownership ([335e096](https://github.com/dsswift/ion/commit/335e096eb13ad98cc247c69a32b59275fe34ad59))
* **repo:** align secure Go toolchains ([acf315f](https://github.com/dsswift/ion/commit/acf315f5b182bad0b6a085c3d990f1632e376a69))

## [1.69.0](https://github.com/dsswift/ion/compare/engine-v1.68.0...engine-v1.69.0) (2026-08-12)

### Features

* **engine:** add operator thinking policy ([1f5d7b8](https://github.com/dsswift/ion/commit/1f5d7b8da83cea3bf3d879b8087d34e4df2f7709))

### Bug Fixes

* **engine:** restore session dispatch state after loss ([163c724](https://github.com/dsswift/ion/commit/163c724a482d54b49cf2ec5ec538b80869e92284))
* **engine:** preserve context baseline after output-only turns ([19d00a5](https://github.com/dsswift/ion/commit/19d00a5ac996ea873f06ef7e62f4dc3fbdb37c8a))
* **engine:** restore manager build identity ([49fc0d5](https://github.com/dsswift/ion/commit/49fc0d55b5cd737d48cd7cee9a9a206cab4e02e3))
* **engine:** preserve MCP tool images ([3f3cb36](https://github.com/dsswift/ion/commit/3f3cb36f30148297b4159eac52b212c38205d634))
* **engine:** order OpenAI tool image results ([7c03efc](https://github.com/dsswift/ion/commit/7c03efc9d4b57cb3150573a866c2b4755c017437))
* **engine:** persist dispatch recovery state ([db02117](https://github.com/dsswift/ion/commit/db0211760098a618d804e314fd1af867bde1ea29))
* **engine:** restore thinking policy config ([e48eef2](https://github.com/dsswift/ion/commit/e48eef2724ce78b99340e967f31215819c321b41))
* **engine:** stabilize integration dispatch tests ([bcd69e4](https://github.com/dsswift/ion/commit/bcd69e4556b2603531c3eaebe0b294106d170f29))

## [1.68.0](https://github.com/dsswift/ion/compare/engine-v1.67.0...engine-v1.68.0) (2026-08-12)

### Features

* **engine:** add engine_agent_state_clamped advisory ([904076a](https://github.com/dsswift/ion/commit/904076a34187dd4cd01c63fb42d290c88054a283))

### Bug Fixes

* **engine:** reclaim stalled schedule in-flight slots ([e005685](https://github.com/dsswift/ion/commit/e0056853751fb88669f7cd01a6732fb2e3277d30))
* **engine:** detect session-manager lock stalls; re-arm heartbeat on interval change ([910b267](https://github.com/dsswift/ion/commit/910b2676ac4554b6503f53d92386d379a8db822c))
* **engine:** break manager-lock/extension readLoop deadlock ([6903bda](https://github.com/dsswift/ion/commit/6903bdae8af3628cc2f27c49c2d5e41f041ac05d))
* **engine:** stop losing dispatch records on concurrent persistence ([703467e](https://github.com/dsswift/ion/commit/703467e70f97f9df5def331ba944f9b3514f3581))
* **engine:** give a live run ownership of its conversation ([d40e017](https://github.com/dsswift/ion/commit/d40e01704cf6806c1c49d26c9a59b175dadc8445))
* **engine:** bound engine_agent_state metadata size at ingest ([1fd127b](https://github.com/dsswift/ion/commit/1fd127b520927318f85bf9c62943f00b00b51d6b))
* **engine:** dedup and coalesce engine_agent_state emissions ([5ed1193](https://github.com/dsswift/ion/commit/5ed1193e2fc542a337adfa5cc3b6a5a1e4d32771))
* **engine:** cache negative HasKey results with write-path invalidation ([0cfe58a](https://github.com/dsswift/ion/commit/0cfe58af072dcf8d7bc98901e803499b03a4461a))
* **engine:** enforce agent metadata bounds over protected keys ([e8a7e83](https://github.com/dsswift/ion/commit/e8a7e8305ca2efff8f91df40e2e5441eff2e535d))
* **engine:** atomically publish workspace test pid ([6c42de3](https://github.com/dsswift/ion/commit/6c42de38e60b70086f4f5e637c95a2d0b62054e6))
* **engine:** preserve queued notification context ([b01fe92](https://github.com/dsswift/ion/commit/b01fe92e896dc90216a328cd6bc64d4204bde8b9))

## [1.67.0](https://github.com/dsswift/ion/compare/engine-v1.66.0...engine-v1.67.0) (2026-08-12)

### Features

* **engine:** make lost-dispatch notices durable ([b1f0e60](https://github.com/dsswift/ion/commit/b1f0e6050e1e0ebdf19157db09b39d972517f1ce))
* **engine:** add bounded session command lanes ([5f1d5c6](https://github.com/dsswift/ion/commit/5f1d5c65bcc17852c574c72dff4fdb6a990c6b5b))
* **engine:** validate engine and SDK build identity ([8db588a](https://github.com/dsswift/ion/commit/8db588a7fa3653644e7f1d7d95dc1ccaeb94bb44))

### Bug Fixes

* **engine:** throttle repeated in-flight skip logs ([e22fcb2](https://github.com/dsswift/ion/commit/e22fcb2e8b12df964cd68513bcc40ada26f8122d))
* **engine:** bound git-context subprocesses ([440fc2f](https://github.com/dsswift/ion/commit/440fc2f46bdb6811f8c2d5e0d9c8dfc6df00aaff))
* **engine:** release session lock before prompt preparation ([cfbb13e](https://github.com/dsswift/ion/commit/cfbb13e69aba94c6a3846a7d386c2b6bef492544))
* **engine:** default minimal server context ([6268d9c](https://github.com/dsswift/ion/commit/6268d9cc702fa02351b27f971b28d5499b314b4d))
* **engine:** restore agent depth budget hook field ([33beae1](https://github.com/dsswift/ion/commit/33beae1311c5d6da328431a817338db0b85f34dc))
* **engine:** preserve extension identity across dispatches ([92eb983](https://github.com/dsswift/ion/commit/92eb9831fdaafd9f1be5ea0c8eede6e41d6521fc))
* **engine:** honor model provenance in slash commands ([b541c88](https://github.com/dsswift/ion/commit/b541c88b9105ca806e3c37ec8f45b3c4c83ca062))
* **engine:** preserve conversation context through compaction ([efb4f75](https://github.com/dsswift/ion/commit/efb4f755ea9bc496c84b969fa68bb38f5c32b973))
* **engine:** retain buffered lifecycle events ([268b74d](https://github.com/dsswift/ion/commit/268b74d196e067f8ebfca6f3bba08e369f699c56))

## [1.66.0](https://github.com/dsswift/ion/compare/engine-v1.65.0...engine-v1.66.0) (2026-08-12)

### Features

* **engine:** broker multi-cloud machine identity (#346) ([871c9c7](https://github.com/dsswift/ion/commit/871c9c79009fafb1f4193c1d45d79577ddf9f5a3))
* **engine:** preserve MCP result content (#348) ([ba6b842](https://github.com/dsswift/ion/commit/ba6b84213732657aba5bd70d1646033fd047d789))

### Bug Fixes

* **engine:** hydrate PATH from interactive shells ([5a89f17](https://github.com/dsswift/ion/commit/5a89f170592741699417ee11064f3744824284a7))
* **engine:** persist dispatch terminal errors in child history ([4bb9948](https://github.com/dsswift/ion/commit/4bb99489d85b6c2b1b0c5deea8a038b76c0164db))
* **engine:** stabilize child error revival test ([863a2ea](https://github.com/dsswift/ion/commit/863a2eab4f6591b8aa2492ecf02fffd5c1065eac))
* **engine:** update integration tool callbacks ([8a0fc62](https://github.com/dsswift/ion/commit/8a0fc622c5dfcff8384ed21c72653206efc58f6f))

## [1.65.0](https://github.com/dsswift/ion/compare/engine-v1.64.1...engine-v1.65.0) (2026-08-11)

### Features

* **engine:** add extension SDK contract mechanisms (#311) ([15aee77](https://github.com/dsswift/ion/commit/15aee776015a912d2a9f1772b0c6a8a202168e67))
* **engine:** dispatch agents asynchronously by default ([2bd68cd](https://github.com/dsswift/ion/commit/2bd68cd378c0ee2f9fc16e41e56a0a5c0c347195))
* **engine:** install Go SDK for source builds ([c831b6e](https://github.com/dsswift/ion/commit/c831b6ec01ebd349d3ec8624c8dff805438f421d))
* **engine:** add model provenance to slash commands ([142538b](https://github.com/dsswift/ion/commit/142538bce6babd17c56fff893a00e5024e3721ec))
* **engine:** run context breakdown asynchronously ([3835714](https://github.com/dsswift/ion/commit/3835714acda59bb8aaf53f3306e3d2d3a5ea9598))
* **engine:** cover linked graph containment ([42563cb](https://github.com/dsswift/ion/commit/42563cb3ba42a51f34db8c7088e201aa24754bf6))
* **engine:** dispatch agents asynchronously by default ([9103b43](https://github.com/dsswift/ion/commit/9103b4350567bc826f2aed5859491144910549dd))

### Bug Fixes

* **engine:** refuse blocking foreground sleep, cap bash timeout ([592d25d](https://github.com/dsswift/ion/commit/592d25dbfad485846182b8fcb85e3032a3a373dc))
* **engine:** require dispatch registry on every extension context ([210f25a](https://github.com/dsswift/ion/commit/210f25a66df76ba5bec8e254ac0f0941012ee26f))
* **engine:** reap orphaned transpile bundles ([f067b92](https://github.com/dsswift/ion/commit/f067b9268bb72d1c46f2c02a841daa2da7c4e789))
* **engine:** frontmatter model overrides conversation model ([1fa91ac](https://github.com/dsswift/ion/commit/1fa91ac72d5f58356e311a879c0f82cebf56d10b))
* **engine:** preserve clear context boundary ([d2261f1](https://github.com/dsswift/ion/commit/d2261f1ef2f0c308f87d5d5035169ad510055ff3))
* **engine:** resolve model metadata in extension tool contexts ([8c20578](https://github.com/dsswift/ion/commit/8c20578c98a13a77e9a2860d2a6a8a8438e3ccb8))
* **engine:** resolve hybrid backend capabilities per run ([b055308](https://github.com/dsswift/ion/commit/b0553080257ae10293a2f17cef09fe8d90cccea8))
* **engine:** use canonical backend type log field ([2f284ab](https://github.com/dsswift/ion/commit/2f284ab1f3cd61a56a8ec26fcee6b3787c1ed4e1))
* **engine:** distinguish degraded steer delivery from live drain ([994a563](https://github.com/dsswift/ion/commit/994a5637d85cfc5a3b583450518b4fcce523d9cd))
* **engine:** remove duplicate hook envelope test ([522ab4e](https://github.com/dsswift/ion/commit/522ab4e43036813f6c96062670c0585f421b6b7d))
* **engine:** stabilize Linux race tests ([e0e185f](https://github.com/dsswift/ion/commit/e0e185fcb457d6f18a2b46e4f35831f703336848))
* **engine:** synchronize run identity access ([589b7ae](https://github.com/dsswift/ion/commit/589b7ae3687d97c2fb6fd144d53bfe42ace422c4))
* **engine:** synchronize model context access ([d179cf4](https://github.com/dsswift/ion/commit/d179cf42d0432b76cc3c2fec621e73c4cb929e7a))

## [1.64.1](https://github.com/dsswift/ion/compare/engine-v1.64.0...engine-v1.64.1) (2026-08-10)

## [1.64.0](https://github.com/dsswift/ion/compare/engine-v1.63.2...engine-v1.64.0) (2026-08-08)

### Features

* **engine:** default thinking effort in engine.json ([8af4a97](https://github.com/dsswift/ion/commit/8af4a97b1360e8c3deb0212ee95af17fb43c5a5b))
* **engine:** extend the thinking ladder with xhigh and max ([ea4980e](https://github.com/dsswift/ion/commit/ea4980e7053e2df9224a382bfcc9556542b57dd6))
* **engine:** add model tier administration ([a9aac3a](https://github.com/dsswift/ion/commit/a9aac3a613d296029a8701c2134ceca5b6c8beb5))
* **engine:** add client tool gate ([18b51af](https://github.com/dsswift/ion/commit/18b51af7a665a7b857f67ef78714433bfbb0eb7c))
* **engine:** harden worktree context and branch safety ([3e45c41](https://github.com/dsswift/ion/commit/3e45c417fc580c53deb617e5ca10780e387062d8))
* **engine:** add cross-worktree query tools ([6b9fb82](https://github.com/dsswift/ion/commit/6b9fb82ed722b5f7fd95168e2ee42821eb5d199e))

### Bug Fixes

* **engine:** drop reasoning_effort for misdeclared chat dialects ([f29b4f0](https://github.com/dsswift/ion/commit/f29b4f09fb35948112e8e9c62c92d5f836e1cde2))
* **engine:** let adaptive models choose their own reasoning depth ([d57eb2f](https://github.com/dsswift/ion/commit/d57eb2fae3172578172a88720647cc837eb672dc))
* **engine:** bound egress spool trim and buffer memory ([405b50c](https://github.com/dsswift/ion/commit/405b50cb3bfa433638357b567477796515722821))
* **engine:** align worktree v3 engine delivery ([db4c465](https://github.com/dsswift/ion/commit/db4c46504e3441eebc169adce58b853007ede3d8))
* **engine:** retain acp client across process close ([67ac437](https://github.com/dsswift/ion/commit/67ac4372ef95ab0758e2e51d20abd77c2ef51143))

## [1.63.2](https://github.com/dsswift/ion/compare/engine-v1.63.1...engine-v1.63.2) (2026-08-06)

### Bug Fixes

* **engine:** poll for watchdog run removal instead of one check ([21052df](https://github.com/dsswift/ion/commit/21052df8a94a1aab9b714fa93800df132958727c))

## [1.63.1](https://github.com/dsswift/ion/compare/engine-v1.63.0...engine-v1.63.1) (2026-08-04)

### Bug Fixes

* **engine:** resolve backend capabilities per run, not on the outer ([841aadd](https://github.com/dsswift/ion/commit/841aadd7527473f79c2d63e68609421d559e59a4))
* **engine:** make forced compaction reclaim context ([9b624fd](https://github.com/dsswift/ion/commit/9b624fdfe913910358f8137831d1b09ca8818b7b))
* **engine:** stop advertising gateway models under ids that route elsewhere ([ce204db](https://github.com/dsswift/ion/commit/ce204dbdab7e7534b96d47d0a918a02b2d6afe30))
* **engine:** correct the auto-exit ADR citation ([51fa709](https://github.com/dsswift/ion/commit/51fa70904cd78470a7765bff86924c33a621f78f))
* **engine:** honor mid-run plan mode in the provider tool list ([42beb2e](https://github.com/dsswift/ion/commit/42beb2e78fea9bc7055cf430fb66e048f35fd7d3))
* **engine:** stop persisting the stale plan-mode claim ([e628d2f](https://github.com/dsswift/ion/commit/e628d2f29818332bfe5a394de23bb501c6ea86b2))
* **engine:** reformat compact log call to escape check-logging blind spot ([4af5f02](https://github.com/dsswift/ion/commit/4af5f025039b3dbd7fb2c0a392357b16a190410d))

## [1.63.0](https://github.com/dsswift/ion/compare/engine-v1.62.0...engine-v1.63.0) (2026-08-03)

### Features

* **engine:** workspace context, attribution, completion reason ([a85b2ca](https://github.com/dsswift/ion/commit/a85b2ca39a628aa6463321cb92bf3630e4944522))

### Bug Fixes

* **engine:** guard bench merge completion ([ca5e07e](https://github.com/dsswift/ion/commit/ca5e07e6c6b5bbc78a9bbfd758118485fb53cfad))
* **engine:** honor PlanModeSafe in plan mode tool tests ([a7d1613](https://github.com/dsswift/ion/commit/a7d1613a73fdd4e3be9264880af276c271320022))

## [1.62.0](https://github.com/dsswift/ion/compare/engine-v1.61.0...engine-v1.62.0) (2026-08-03)

### Features

* **engine:** scope trace_id to the run, not the session ([1720941](https://github.com/dsswift/ion/commit/1720941d0d38728e1f18fc9deccebeb039d0e657))
* **engine:** publish run and trace identity to extensions ([5934733](https://github.com/dsswift/ion/commit/5934733a217b031712a143e4483631699c00ecaa))

### Bug Fixes

* **engine:** correct misused canonical log field keys ([462e867](https://github.com/dsswift/ion/commit/462e86728d2134677a2f83e03536cc5752c36119))
* **engine:** stop minting spec-invalid all-zero correlation ids ([29a6fc4](https://github.com/dsswift/ion/commit/29a6fc4b50821bb674322378aee2387a4b0837a4))
* **engine:** propagate run traces through OTLP telemetry ([a875216](https://github.com/dsswift/ion/commit/a875216d742f613f593213088201c39ecfe1352b))

## [1.61.0](https://github.com/dsswift/ion/compare/engine-v1.60.0...engine-v1.61.0) (2026-08-01)

### Features

* **engine:** publish context occupancy on the breakdown event ([a8c596b](https://github.com/dsswift/ion/commit/a8c596bf120128cbec426908d2ebbd1fdef4255d))
* **engine:** containment and ion-meta removal ([f551f28](https://github.com/dsswift/ion/commit/f551f28e239811f131ef9caae23ae68bead56a28))
* **engine:** enumerate injection kinds and publish machineAuthored ([ed7c1e1](https://github.com/dsswift/ion/commit/ed7c1e121dfc20c6144e29aae8207de49d539724))

### Bug Fixes

* **engine:** thread injection kind through every injection path ([175c71e](https://github.com/dsswift/ion/commit/175c71e4947a85d8290cf2afbf80020a80ab4333))

## [1.60.0](https://github.com/dsswift/ion/compare/engine-v1.59.1...engine-v1.60.0) (2026-08-01)

### Features

* **engine:** resolve_model_tier command and standard-tier conflict assist ([26b4bcd](https://github.com/dsswift/ion/commit/26b4bcd3902128afe60c66867c3f5a1e6d986668))
* **engine:** bench briefing and routing tools for bench conversations ([d1d353f](https://github.com/dsswift/ion/commit/d1d353fbf7253279ce209140258b9eb4941807e3))
* **engine:** resolve_model_tier client command ([14e766a](https://github.com/dsswift/ion/commit/14e766a669ea2dd84b9b4c7faad5e96623541a2e))
* **engine:** add MCP server administration with OAuth login ([1b6140c](https://github.com/dsswift/ion/commit/1b6140c28691077e991c5e1321a3ec07f4deefec))

### Bug Fixes

* **engine:** resolve bash cd targets in the worktree gate ([9f8fa03](https://github.com/dsswift/ion/commit/9f8fa03f871cd5b3f1b7fa873448facb82f12e9a))
* **engine:** dispatch lifecycle — park, revive, credit, and loss ([d98fd20](https://github.com/dsswift/ion/commit/d98fd20452568986a7e6038c91ccc0ad95cf4f16))
* **engine:** fail fast on keyless requests to canonical providers ([a7fc344](https://github.com/dsswift/ion/commit/a7fc344ac0360d74b366cf4cde0103ce0abed39a))
* **engine:** remove duplicate sdk source location section ([46620f6](https://github.com/dsswift/ion/commit/46620f6ce471e0bbbd59e2a24cc0470f6d7a310d))
* **engine:** make the MCP StreamableHTTP transport spec-conformant ([9e0e626](https://github.com/dsswift/ion/commit/9e0e62604f7992118f9cbcde9f62e8000b5cb000))
* **engine:** refresh MCP tokens per request, once per server ([73a41d8](https://github.com/dsswift/ion/commit/73a41d862991527d8b621416aac438da86bec614))
* **engine:** surface dead MCP grants and stop retrying them ([eb34111](https://github.com/dsswift/ion/commit/eb34111a168a475d9d29a35f2cd4e85937ff70af))
* **engine:** connect MCP servers lazily at first prompt ([3872113](https://github.com/dsswift/ion/commit/387211352a676c0c0af2a8bab3efaa1a551bd68f))
* **engine:** release the pkce callback port on wind-down ([3e41999](https://github.com/dsswift/ion/commit/3e419995e5cefed34562bde7eb8d9b608e13d743))

## [1.59.1](https://github.com/dsswift/ion/compare/engine-v1.59.0...engine-v1.59.1) (2026-07-28)

### Bug Fixes

* **engine:** de-flake the tool-stall watchdog test on linux -race ([4d8c3d0](https://github.com/dsswift/ion/commit/4d8c3d0ed181745169a4cae81c2414ebc07050be))

## [1.59.0](https://github.com/dsswift/ion/compare/engine-v1.58.0...engine-v1.59.0) (2026-07-28)

### Features

* **engine:** refuse writes outside a worktree conversation's own tree ([477ae2a](https://github.com/dsswift/ion/commit/477ae2a58f24f214ee09c482c355f683d7fdaf7b))
* **engine:** a bench refuses edits and names the member that owns the file ([e2ae12d](https://github.com/dsswift/ion/commit/e2ae12dd2f42d0f2318dc260c58356e50f3f1775))
* **engine:** accept prompt text on stdin ([87575fb](https://github.com/dsswift/ion/commit/87575fb5ea319cd5ec0841279a68adaacd5d4010))

### Bug Fixes

* **engine:** build the socket-buffer tuning per platform ([b99e6ed](https://github.com/dsswift/ion/commit/b99e6ed9e69ed63f97ae1a71e237665afd0385ee))

## [1.58.0](https://github.com/dsswift/ion/compare/engine-v1.57.1...engine-v1.58.0) (2026-07-27)

### Features

* **engine:** refuse git history writes inside a bench ([825e315](https://github.com/dsswift/ion/commit/825e315aeac29fbbff3e685c7450833aaa588c35))

### Bug Fixes

* **engine:** assert the dispatch fixture instead of rewriting it ([a14168b](https://github.com/dsswift/ion/commit/a14168b3898560e1ee80f0dd222f3464bccf97f3))
* **engine:** persist changed working directory on runs ([811e294](https://github.com/dsswift/ion/commit/811e2944f468930a8f7aafaf45edfa3f88398dd9))

## [1.57.1](https://github.com/dsswift/ion/compare/engine-v1.57.0...engine-v1.57.1) (2026-07-27)

### Bug Fixes

* **engine:** enlarge Unix socket buffer to prevent client eviction ([9c4cbf1](https://github.com/dsswift/ion/commit/9c4cbf153e816fa79fa21be5079995a718a5631d))

## [1.57.0](https://github.com/dsswift/ion/compare/engine-v1.56.1...engine-v1.57.0) (2026-07-27)

### Features

* **engine:** wake orchestrator on background bash completion ([6387a0c](https://github.com/dsswift/ion/commit/6387a0c426d62e06cfcbb296f6740b2ea09064f9))
* **engine:** additive project plan-mode bash with enterprise ceiling ([04551b2](https://github.com/dsswift/ion/commit/04551b2249820cfb932511abd828c083ae67da03))

### Bug Fixes

* **engine:** scope the skill registry per session and allow Skill in plan mode ([8ed8fe0](https://github.com/dsswift/ion/commit/8ed8fe0201842ca8c20b75824c64f9947408c38d))
* **engine:** report true context usage at idle and uncap percent ([bb3c08f](https://github.com/dsswift/ion/commit/bb3c08ff96e411aa80867f3cb06b32efefa109a8))
* **engine:** render error log fields as messages, not empty objects ([1f08988](https://github.com/dsswift/ion/commit/1f08988e67636d6a58f08d46337c66cd8e4ce88b))
* **engine:** stop taking the git index lock when reading repo context ([58260ab](https://github.com/dsswift/ion/commit/58260ab2ef4981f09a28bd50b59d97bf490d7846))

## [1.56.1](https://github.com/dsswift/ion/compare/engine-v1.56.0...engine-v1.56.1) (2026-07-26)

### Bug Fixes

* **engine:** implement claude-code auth probe and login driver (#320) ([f222aa4](https://github.com/dsswift/ion/commit/f222aa43a2c780408f5bde13a3612fa6483a9621))

## [1.56.0](https://github.com/dsswift/ion/compare/engine-v1.55.0...engine-v1.56.0) (2026-07-26)

### Features

* **engine:** native openai responses api streaming client ([595f65c](https://github.com/dsswift/ion/commit/595f65c251fda02ad75161c1572d835e8735bd21))
* **engine:** dialect-routed gateway discovery and qualified model ids ([0e2cc42](https://github.com/dsswift/ion/commit/0e2cc42ec0f61b8b9c0e6716717c01c9eb467ef5))
* **engine:** provider displayName config surfaced on provider entries ([bb03c32](https://github.com/dsswift/ion/commit/bb03c327d4637f46fbe494b4205120c65c58fac4))

### Bug Fixes

* **engine:** stop catalog enrichment clobbering discovered models ([ea9ab30](https://github.com/dsswift/ion/commit/ea9ab304035fc9ab659bffbe270d4fa4eab853bc))

## [1.55.0](https://github.com/dsswift/ion/compare/engine-v1.54.0...engine-v1.55.0) (2026-07-25)

### Features

* **engine:** add image generation model support ([fe028be](https://github.com/dsswift/ion/commit/fe028be5ed6579576d19342c71cc623195fe4d4a))
* **engine:** add oidc credential provider to relay transport ([8e03a45](https://github.com/dsswift/ion/commit/8e03a45ed26f7bcae5bfebf45b6fc90c14053f08))
* **engine:** add injection kind and classify slash-command injections ([fd47c19](https://github.com/dsswift/ion/commit/fd47c19f4d4bf8bba0f2e3ae1b490ec7e3df8003))
* **engine:** resolve and list skills from .ion/skills roots ([5021559](https://github.com/dsswift/ion/commit/5021559c60d572ffedf3bec035ba54900eab310c))
* **engine:** append usage block to agent tool results ([b8fe853](https://github.com/dsswift/ion/commit/b8fe8532412748c9fbca4b8c3f0b4cc6e252da1f))
* **engine:** add run_in_background to the bash tool ([c2bf2a0](https://github.com/dsswift/ion/commit/c2bf2a07935235277c2c5d7b32774a6d13617655))

### Bug Fixes

* **engine:** persist /clear as display-only slash entry for pill ordering ([c1a8d58](https://github.com/dsswift/ion/commit/c1a8d5874b5c4f72e8bd9194ecf35dd776db8108))
* **engine:** key credential store from keyfile, not hostname ([b4dca34](https://github.com/dsswift/ion/commit/b4dca346ee1259e1f651506236952ad02f2b334e))
* **engine:** add plan-mode third turn-ending for no-plan requests ([f572f85](https://github.com/dsswift/ion/commit/f572f85a8917153a593093374f011d433a0d08b2))

## [1.54.0](https://github.com/dsswift/ion/compare/engine-v1.53.0...engine-v1.54.0) (2026-07-22)

### Features

* **engine:** pin enterprise provider definitions in EnforceEnterprise ([f9ce3de](https://github.com/dsswift/ion/commit/f9ce3de236360f9cba11930c4205b511f74b178c))
* **engine:** emit enforcement audit events through telemetry ([5690480](https://github.com/dsswift/ion/commit/56904805f5d58ca8d6811fcd8c8fb7367fed206c))
* **engine:** enforce extension loading allowlist at host load path (#308) ([6a9228c](https://github.com/dsswift/ion/commit/6a9228c651dc2dd6db76cab92ca77d701bf2a0a7))
* **engine:** stamp event_id and install_id on egress records (#310) ([99d9c69](https://github.com/dsswift/ion/commit/99d9c6964a14c5147ddf64c7390c59ada37bb482))

### Bug Fixes

* **engine:** map telemetry events in OTLP egress for parity ([bbf766d](https://github.com/dsswift/ion/commit/bbf766dcc304c8295aee22de9cc53dc822484ea3))
* **engine:** route telemetry/web/operator HTTP through enterprise transport ([d6b7ec1](https://github.com/dsswift/ion/commit/d6b7ec1eb578b20a38c96c69fe459d3e2315c53f))

## [1.53.0](https://github.com/dsswift/ion/compare/engine-v1.52.0...engine-v1.53.0) (2026-07-21)

### Features

* **engine:** enterprise policy seals, limits, and dispatch cap ([71f7f38](https://github.com/dsswift/ion/commit/71f7f385477377086cd2ea3681196f3007ff8164))

## [1.52.0](https://github.com/dsswift/ion/compare/engine-v1.51.0...engine-v1.52.0) (2026-07-21)

### Features

* **engine:** add egress request timeout config option ([1f7a187](https://github.com/dsswift/ion/commit/1f7a1872e98a83e54a10233fb0e67426e243b56d))
* **engine:** persist clear checkpoint to tree; replay on history load ([70d5132](https://github.com/dsswift/ion/commit/70d5132430363a2a1c9954707c6744a8be57eb3b))

### Bug Fixes

* **engine:** guard status cross-check during prompt dispatch window ([0dc0290](https://github.com/dsswift/ion/commit/0dc0290f07a4ea697dafb62f95b36b74a61b3bb5))

## [1.51.0](https://github.com/dsswift/ion/compare/engine-v1.50.2...engine-v1.51.0) (2026-07-21)

### Features

* **engine:** add egress chunk size config option ([91dac65](https://github.com/dsswift/ion/commit/91dac657d8b084b098afcaa6435f8d1d9a81ed53))
* **engine:** implement chunked egress with spool rewrite ([bbd6118](https://github.com/dsswift/ion/commit/bbd6118b817d0ebbb4f79a3a7a60cad083e497a6))

## [1.50.2](https://github.com/dsswift/ion/compare/engine-v1.50.1...engine-v1.50.2) (2026-07-20)

### Bug Fixes

* **engine:** guard scheduler/webhook resolve nil-deref panics ([12d3034](https://github.com/dsswift/ion/commit/12d303479afe10115e2eb13ac93d18dce4308767))
* **engine:** eliminate silent failures across push/scheduler/mcp/attachments ([bd03249](https://github.com/dsswift/ion/commit/bd032495252d57e77ed01a20766b4bc3866db26c))
* **engine:** resolve errcheck check-blank/type-assertion fallout ([8ea8cb2](https://github.com/dsswift/ion/commit/8ea8cb25d3288899571f541d32180e18d5e88e19))

## [1.50.1](https://github.com/dsswift/ion/compare/engine-v1.50.0...engine-v1.50.1) (2026-07-20)

## [1.50.0](https://github.com/dsswift/ion/compare/engine-v1.49.0...engine-v1.50.0) (2026-07-20)

### Features

* **engine:** resource_get command for lazy item content fetch (#211) ([38e440a](https://github.com/dsswift/ion/commit/38e440aaa30ec95fbdf7e47c7385aa31f429f115))

## [1.49.0](https://github.com/dsswift/ion/compare/engine-v1.48.0...engine-v1.49.0) (2026-07-20)

### Features

* **engine:** expose enterPlanMode / exitPlanMode / getPlanMode on SDK (#160) ([39a221a](https://github.com/dsswift/ion/commit/39a221a5914833a8570ffad4651f7f8291c5aac1))
* **engine:** add ION_DATA_DIR for multi-instance deployments (#191) ([4de4d6a](https://github.com/dsswift/ion/commit/4de4d6a4e123b80a855b4f94c74d676c1ac22fd5))

## [1.48.0](https://github.com/dsswift/ion/compare/engine-v1.47.1...engine-v1.48.0) (2026-07-20)

### Features

* **engine:** pinned sessions exempt from orphan reaping (#281) ([196bc15](https://github.com/dsswift/ion/commit/196bc15c6dae5294ce2341c851c87b4881120b41))

### Bug Fixes

* **engine:** apiBackend emits document blocks for PDF wire attachments (#271) ([ed82020](https://github.com/dsswift/ion/commit/ed820206dfec43e175133546ba8e50ccd7cfad5f))

## [1.47.1](https://github.com/dsswift/ion/compare/engine-v1.47.0...engine-v1.47.1) (2026-07-19)

### Bug Fixes

* **engine:** surface extension init-failure stderr in error events (#201) ([a7c1bbd](https://github.com/dsswift/ion/commit/a7c1bbd805b9c032ca3b87e910b9e8e5e9a7f8a1))
* **engine:** structured EMFILE error + fd pressure logging in Bash tool (#241) ([77da33c](https://github.com/dsswift/ion/commit/77da33cf8f439f1ba04da347f66ac5465534e6a2))

## [1.47.0](https://github.com/dsswift/ion/compare/engine-v1.46.2...engine-v1.47.0) (2026-07-19)

### Features

* **engine:** add PlanFileProjectScoped capability to BackendCapabilities ([9275b9a](https://github.com/dsswift/ion/commit/9275b9a9521db5ce6ba6a5a473f0db9e6ad25e63))

### Bug Fixes

* **engine:** preserve interval cadence on host replacement; emit unhosted (#285, #280) ([36f8b4b](https://github.com/dsswift/ion/commit/36f8b4be01a31612fd2d1acc75914dc2727bd300))
* **engine:** resolve plan-mode bash allowlist fresh at dispatch ([8f32626](https://github.com/dsswift/ion/commit/8f3262662b0c761368ad38cf49f61355eec5d8e5))
* **engine:** downgrade HasKey success log from INFO to DEBUG ([e52ae08](https://github.com/dsswift/ion/commit/e52ae08679cee95364eef8cd23f1abbf4fe14c30))
* **engine:** preserve retryable classification for stream-idle errors ([c0cb342](https://github.com/dsswift/ion/commit/c0cb3422345b691ac1ad86ee145234fb819a75cb))
* **engine:** raise codex backend test timeouts for CI race detector ([7979a2f](https://github.com/dsswift/ion/commit/7979a2ff244b1b56316734d6e8dfed9b235edd8d))

## [1.46.2](https://github.com/dsswift/ion/compare/engine-v1.46.1...engine-v1.46.2) (2026-07-18)

### Bug Fixes

* **engine:** raise scheduler predicate/handler error logs to ERROR level (#276) ([ee562ce](https://github.com/dsswift/ion/commit/ee562cece4d608ea484dea89b45e6d9d63de1a61))
* **engine:** enrich CliBackend empty-stderr exit error with diagnostic context (#277) ([aa869a8](https://github.com/dsswift/ion/commit/aa869a8991ff7077754829785088d0181dfd4434))
* **engine:** prevent cmd.Wait() data race in disposeInternal vs captureExitStatus (#278) ([6d6c373](https://github.com/dsswift/ion/commit/6d6c373257fba15ec79f5c5dab1a3f2cd3abec03))
* **engine:** cover fireJobWithMeta error paths via FireScheduleNow in tests (#276) ([ac0f90d](https://github.com/dsswift/ion/commit/ac0f90dbaa487b2470a461280043125c30787d05))
* **engine:** log ERROR when disposeInternal process-reap timeout fires (#278) ([99c5d09](https://github.com/dsswift/ion/commit/99c5d09c8a46caab93224f8e7272aef85baa0020))
* **engine:** add dispose-first race-order test for host_wait_race (#278) ([ffed44b](https://github.com/dsswift/ion/commit/ffed44b527d15b2981301e57a77f89d4a2bdceac))

## [1.46.1](https://github.com/dsswift/ion/compare/engine-v1.46.0...engine-v1.46.1) (2026-07-18)

### Bug Fixes

* **engine:** catch up interval jobs across restarts ([027b0cd](https://github.com/dsswift/ion/commit/027b0cddf8f9121c7414d078414c939b9da4739d))

## [1.46.0](https://github.com/dsswift/ion/compare/engine-v1.45.1...engine-v1.46.0) (2026-07-17)

### Features

* **engine:** add machine identity to log fields ([6e9dabd](https://github.com/dsswift/ion/commit/6e9dabd26e469c19bed23c59acdf9584c679253a))
* **engine:** add user turn persisted event ([7348cc6](https://github.com/dsswift/ion/commit/7348cc680402e5f9a4a463ac846a7c98573c20e4))

### Bug Fixes

* **engine:** replay user-prompt image blocks on the user row ([5d6ffca](https://github.com/dsswift/ion/commit/5d6ffca11a431da52aac4006be19a3e8e30c2af4))

## [1.45.1](https://github.com/dsswift/ion/compare/engine-v1.45.0...engine-v1.45.1) (2026-07-17)

### Bug Fixes

* **engine:** rebind idle session when caller asserts a different conversation ([1edace7](https://github.com/dsswift/ion/commit/1edace7570d74d8a0c455a2241791243a47efd07))

## [1.45.0](https://github.com/dsswift/ion/compare/engine-v1.44.0...engine-v1.45.0) (2026-07-17)

### Features

* **engine:** logging and observability: structured JSONL, dashboards, egress, gates ([f0b55c3](https://github.com/dsswift/ion/commit/f0b55c32b511186a49b5e9af1c0d6b38e00b7d9a))
* **engine:** per-model cost breakdown ([97618f3](https://github.com/dsswift/ion/commit/97618f3e82fec58db2063dc0e46e155d2da6b6c4))
* **engine:** correctness and preflight fixes, UI/lifecycle cleanup, ADR-017 ([d5ce23a](https://github.com/dsswift/ion/commit/d5ce23acbae3211e22ea32dc2775bec11e0d4e2f))
* **engine:** plan mode fixes and layered dispatch context ([773e541](https://github.com/dsswift/ion/commit/773e541b914ae5a7eb903447deef7561b6d93766))
* **engine:** schedule: once kind and missed-slot detection ([e53ad7f](https://github.com/dsswift/ion/commit/e53ad7fd318599a7f9f0ab40fbf11795a201bd58))
* **engine:** plugin management, skills, and initial messages ([c43aedb](https://github.com/dsswift/ion/commit/c43aedb69b262c47be5f641622cbfb9f4171eaef))
* **engine:** expose turn count and max output tokens ([682576e](https://github.com/dsswift/ion/commit/682576e11fe65387a7c7fe3f53f570b7662e4425))
* **engine:** native image support through tool and provider paths ([9a32cac](https://github.com/dsswift/ion/commit/9a32cac9cf88524bd4119bcb22426b399537e73f))
* **engine:** extension prompt_injected rendered as user turns ([35f8f94](https://github.com/dsswift/ion/commit/35f8f948d0804b69d2ab90792801c322e22207ef))
* **engine:** transcript identity convergence, stream reset, tree repair ([1bc0236](https://github.com/dsswift/ion/commit/1bc023677686d0340dc3c7b12d8efa8e4b35f9d9))
* **engine:** harness dedup and relocate markers, drop collapse machinery ([394558f](https://github.com/dsswift/ion/commit/394558fdd0565de25f9a999e749792a8cbabec7c))
* **engine:** task_suspend primitive, SDK ctx.suspend, dispatch revive ([892aaca](https://github.com/dsswift/ion/commit/892aacac6afc748bf329fdac2956b8f92e1e78ec))
* **engine:** multi-backend: codex/grok/cursor ACP, provider login ([c7ea85e](https://github.com/dsswift/ion/commit/c7ea85e0d07f22653b6ba9975210100746c41840))
* **engine:** tree-native conversation rewind ([bc0d194](https://github.com/dsswift/ion/commit/bc0d194e82d0d92684f55578a42e6788fc6d110f))
* **engine:** credential-based backend routing and tab storage unify ([800005d](https://github.com/dsswift/ion/commit/800005d1eedb943dfe76d23fb5891cc796b14112))
* **engine:** providers_updated refresh signal ([bdaf0ce](https://github.com/dsswift/ion/commit/bdaf0cee3f8b2bb4b4e6902b1f5b60442583a932))
* **engine:** native plan-mode bridging across delegated CLIs ([d4416f3](https://github.com/dsswift/ion/commit/d4416f3788b2e03241e4ba5f806a328f464c255c))
* **engine:** backend capability contract and native-session cursors ([5e452d1](https://github.com/dsswift/ion/commit/5e452d15b99d1eab21038d5b81be12000bc2b60b))
* **engine:** ion_agent tool wiring to grok/cursor, mobile dashboard ([c95cbd0](https://github.com/dsswift/ion/commit/c95cbd09a41f0faf88658b29375be4bbc429ab91))

### Bug Fixes

* **engine:** engine-owned OIDC login orchestration ([ff8f110](https://github.com/dsswift/ion/commit/ff8f110191142b0bd7ef23b6cdcead77a2c792e0))
* **engine:** relay transport: stall watchdog, wire seqs, APNs push-failed ([0257f93](https://github.com/dsswift/ion/commit/0257f935e3e1318ceea3288d3e5ba76a8bc0b6e9))
* **engine:** warm lan auth verdict, namespace, and cooldown ([44f08bf](https://github.com/dsswift/ion/commit/44f08bfe9d0f430b145b4810e8e086cfdf573394))
* **engine:** prompt_injected kind, suppress agent_completion user bubble ([231981f](https://github.com/dsswift/ion/commit/231981f244b660e94e6dd07bd3a3fff872fff86d))
* **repo:** run linux tests as non-root with node, fix chmod test for root ([51ed77f](https://github.com/dsswift/ion/commit/51ed77f0e1f2ce8a36a8589427144fa67071c1e4))
* **engine:** ignore nested node_modules/.git in workspace watcher ([8bcd184](https://github.com/dsswift/ion/commit/8bcd1848413cad2a8fe0a64439067b53f2a50426))
* **engine:** repair integration/e2e test compile breaks, bump toolchain ([d749312](https://github.com/dsswift/ion/commit/d749312a1e646d080a7cd7f12412ca06b6fc7c84))

## [1.44.0](https://github.com/dsswift/ion/compare/engine-v1.43.0...engine-v1.44.0) (2026-07-05)

### Features

* **cli-backend:** inline PDF/image attachments as content blocks ([9b387e2](https://github.com/dsswift/ion/commit/9b387e2040ed32f09da56bc8117e0ebf2bd6a249))
* **engine:** document blocks from wire attachments + 64MB line cap ([0b26dfb](https://github.com/dsswift/ion/commit/0b26dfb21446a12f6473392b679fa92a88c70261))

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

