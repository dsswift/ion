# Changelog

All notable changes to this project will be documented in this file.

## [0.1.21](https://github.com/dsswift/ion/compare/sdk/go-v0.1.20...sdk/go-v0.1.21) (2026-10-03)

### Features

* **sdk:** add resource_exhausted dispatch refusal fields ([58c48d8](https://github.com/dsswift/ion/commit/58c48d89a0db7c1a0e3ebe3c913195786f861428))

## [0.1.20](https://github.com/dsswift/ion/compare/sdk/go-v0.1.19...sdk/go-v0.1.20) (2026-10-03)

### Features

* **sdk:** add session_before_release hook (#420) ([d74e7e0](https://github.com/dsswift/ion/commit/d74e7e0b8ea48eecf0bd6a050436bcdc956b06dd))

## [0.1.19](https://github.com/dsswift/ion/compare/sdk/go-v0.1.18...sdk/go-v0.1.19) (2026-10-03)

### Features

* **sdk:** add wiki link hooks and integrity scan (#399) ([6483cc7](https://github.com/dsswift/ion/commit/6483cc7af00ee28f7a413a65abfe12afd53376bc))

## [0.1.18](https://github.com/dsswift/ion/compare/sdk/go-v0.1.17...sdk/go-v0.1.18) (2026-10-02)

### Features

* **sdk:** carry the policy failure on on_error (#386) ([b6b49c0](https://github.com/dsswift/ion/commit/b6b49c08393f25d5c64e97aec78a00d3c078c709))
* **sdk:** add park check-in interval to dispatch options ([db53733](https://github.com/dsswift/ion/commit/db53733be6631cab6dbc1bd2009eb5c30a96c878))
* **sdk:** read conversation records from the go sdk (#436) ([7978eab](https://github.com/dsswift/ion/commit/7978eab33dd714c4832e142ad9ff21fc984075b0))

## [0.1.17](https://github.com/dsswift/ion/compare/sdk/go-v0.1.16...sdk/go-v0.1.17) (2026-10-02)

### Features

* **engine:** add parent-scoped dispatch conversation read (#398) ([d1fd156](https://github.com/dsswift/ion/commit/d1fd156cd63022a3c3cc88568e1d8a5a94411ab5))

## [0.1.16](https://github.com/dsswift/ion/compare/sdk/go-v0.1.15...sdk/go-v0.1.16) (2026-10-01)

### Features

* **sdk:** mirror child conversation id on go dispatch outcomes (#380) ([9b8d0d3](https://github.com/dsswift/ion/commit/9b8d0d333cb59f7cd58953389c60aea686389106))

## [0.1.15](https://github.com/dsswift/ion/compare/sdk/go-v0.1.14...sdk/go-v0.1.15) (2026-09-30)

### Features

* **sdk:** add protected operations to the go sdk (#383) ([3faebf8](https://github.com/dsswift/ion/commit/3faebf833070e1f6cad5be1ec611e978b15e5aa8))
* **sdk:** read application config from go extensions (#382) ([d635373](https://github.com/dsswift/ion/commit/d63537394ce03c6747e38d514b8ae8f2930b8f1e))
* **sdk:** read scoped application config in go (#382) ([cb83922](https://github.com/dsswift/ion/commit/cb83922b01f486fc82765d4afb7d261d9dd37893))

## [0.1.14](https://github.com/dsswift/ion/compare/sdk/go-v0.1.13...sdk/go-v0.1.14) (2026-09-30)

### Features

* **engine:** keep dispatch history, flag ambiguous names (#388) ([ac074ed](https://github.com/dsswift/ion/commit/ac074ed871d2f7935bb4df180377d90b03725237))
* **engine:** scope dispatch control and persist history (#388) ([0906e2e](https://github.com/dsswift/ion/commit/0906e2e762326d376164de819d6ad921a947df92))

## [0.1.13](https://github.com/dsswift/ion/compare/sdk/go-v0.1.12...sdk/go-v0.1.13) (2026-09-29)

### Features

* **sdk:** scope data, credentials, and tools per principal ([6b2a351](https://github.com/dsswift/ion/commit/6b2a3511f471a86c6570e7040761ce0caa32ee1b))
* **sdk:** move conversations and worktrees across machines ([c170d0f](https://github.com/dsswift/ion/commit/c170d0ff4c371ec19f48b48ba2b70b3eca7d6425))
* **sdk:** report extension versions from the handshake ([a01dbb7](https://github.com/dsswift/ion/commit/a01dbb759a40d03d5de98fd79f240f0d191b2272))

## [0.1.12](https://github.com/dsswift/ion/compare/sdk/go-v0.1.11...sdk/go-v0.1.12) (2026-09-07)

### Bug Fixes

* **repo:** clear final parity gate failures ([0cc7e56](https://github.com/dsswift/ion/commit/0cc7e56f39cfc3e7c31e7cbb02482f1655d83f56))

## [0.1.11](https://github.com/dsswift/ion/compare/sdk/go-v0.1.10...sdk/go-v0.1.11) (2026-09-06)

### Bug Fixes

* **sdk:** recover stalled tool attempts ([ee9fad5](https://github.com/dsswift/ion/commit/ee9fad5f7094e7ad9f179a538f7a1a421c23aeec))

## [0.1.10](https://github.com/dsswift/ion/compare/sdk/go-v0.1.9...sdk/go-v0.1.10) (2026-09-03)

### Features

* **sdk:** expose verified identity context (#377) ([196c63d](https://github.com/dsswift/ion/commit/196c63d11eee77f9ac49134fbe74e63aba974935))

## [0.1.9](https://github.com/dsswift/ion/compare/sdk/go-v0.1.8...sdk/go-v0.1.9) (2026-09-02)

### Bug Fixes

* **sdk:** update dispatch SDK surface and identity docs ([4486de1](https://github.com/dsswift/ion/commit/4486de15a3c5f01306a04d453dce207cfe692a12))
* **sdk:** align model boundary options ([7e94906](https://github.com/dsswift/ion/commit/7e94906663aede81c8428abe3e3520e3fc80163e))

## [0.1.8](https://github.com/dsswift/ion/compare/sdk/go-v0.1.7...sdk/go-v0.1.8) (2026-08-27)

### Features

* **sdk:** expose dispatch tool count and work expectation ([7af10a0](https://github.com/dsswift/ion/commit/7af10a04da1b4533ba4916548b71b1219fe4431a))

## [0.1.7](https://github.com/dsswift/ion/compare/sdk/go-v0.1.6...sdk/go-v0.1.7) (2026-08-25)

### Features

* **sdk:** group latest schedule catch-up ([2ea2bd3](https://github.com/dsswift/ion/commit/2ea2bd36fcb40ab920fa132b1bb445788b61b18b))

## [0.1.6](https://github.com/dsswift/ion/compare/sdk/go-v0.1.5...sdk/go-v0.1.6) (2026-08-23)

### Features

* **sdk:** add dispatch recall controls ([c8c6b8a](https://github.com/dsswift/ion/commit/c8c6b8a2c05df97f5b6d5e739d96b030a55ded43))

## [0.1.5](https://github.com/dsswift/ion/compare/sdk/go-v0.1.4...sdk/go-v0.1.5) (2026-08-22)

### Features

* **sdk:** expose dispatch wait metadata ([6648800](https://github.com/dsswift/ion/commit/664880009cd097c0dd835cb4670f33216221e43c))

### Bug Fixes

* **sdk:** mirror elicitation payload fields ([7d2809b](https://github.com/dsswift/ion/commit/7d2809b74a06831c65aecceab729ae9070d8e21b))

## [0.1.4](https://github.com/dsswift/ion/compare/sdk/go-v0.1.3...sdk/go-v0.1.4) (2026-08-18)

### Features

* **sdk:** expose run recovery controls ([c86fa15](https://github.com/dsswift/ion/commit/c86fa1504667c4ed05df99cae274cd5b50afb850))

### Bug Fixes

* **sdk:** report registered hooks in handshake ([3197724](https://github.com/dsswift/ion/commit/31977243c65ea9bfc7e08462292e43c06c17b001))

## [0.1.3](https://github.com/dsswift/ion/compare/sdk/go-v0.1.2...sdk/go-v0.1.3) (2026-08-12)

### Bug Fixes

* **sdk:** report Go SDK build identity ([1dc6f89](https://github.com/dsswift/ion/commit/1dc6f8988636c7f414b24730a0440a0a101c5920))
* **sdk:** expose lost dispatch acknowledgement ([8533f4c](https://github.com/dsswift/ion/commit/8533f4c0be0905f4b2b01d7643a472567d4f69c3))
* **sdk:** synchronize dispatch hook contract ([b6d8ab6](https://github.com/dsswift/ion/commit/b6d8ab64fce2aafff67db26233a6163846691bda))

## [0.1.2](https://github.com/dsswift/ion/compare/sdk/go-v0.1.1...sdk/go-v0.1.2) (2026-08-12)

### Features

* **engine:** preserve MCP result content (#348) ([ba6b842](https://github.com/dsswift/ion/commit/ba6b84213732657aba5bd70d1646033fd047d789))

## [0.1.1](https://github.com/dsswift/ion/compare/sdk/go-v0.1.0...sdk/go-v0.1.1) (2026-08-11)

### Features

* **sdk:** add Go extension SDK (#311) ([dd75106](https://github.com/dsswift/ion/commit/dd751068c1745e16f2bfc96980962e7fe78178eb))

### Bug Fixes

* **sdk:** mirror dispatch acknowledgement surface ([b569942](https://github.com/dsswift/ion/commit/b5699426254b8700a39ded4644ceb5cbe89b6c48))
* **sdk:** remove premature dispatch surface ([b46d25b](https://github.com/dsswift/ion/commit/b46d25b7c0b03c4faf60e1aadd69161cebb0a6ff))
* **sdk:** remove dead terminal binding ([08aa559](https://github.com/dsswift/ion/commit/08aa559e58e55673af59b11f21c4f4e789ce6d4f))

