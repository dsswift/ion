# Changelog

All notable changes to the iOS app will be documented here. This file is
maintained by the release pipeline; do not edit by hand.

## 1.0.0 - 2026-04-28

Initial 1.0.0 baseline. Reference iOS client for Ion Engine, connecting
through the relay to access remote engine instances.

Subsequent versions will be auto-generated from conventional commit messages.

## [1.31.0](https://github.com/dsswift/ion/compare/ios-v1.30.0...ios-v1.31.0) (2026-05-28)

### Features

* **desktop:** add per-instance waiting state to engine ui ([b8be7b2](https://github.com/dsswift/ion/commit/b8be7b226a03e1c19ce5581031c14d013df6dff0))

## [1.30.0](https://github.com/dsswift/ion/compare/ios-v1.29.0...ios-v1.30.0) (2026-05-25)

### Features

* **engine:** plan-mode lifecycle with implementation phase ([10e63c4](https://github.com/dsswift/ion/commit/10e63c4dc8f4ca85991b323c24744882bca54037))
* **ios:** make ask user question card collapsible ([1bd01e1](https://github.com/dsswift/ion/commit/1bd01e1767611ba10e9335b02b5ec071b2afe2f0))
* **ios:** add tab group pin support and ui components ([058d472](https://github.com/dsswift/ion/commit/058d4723943efd03771eaba56f97c3fa521f4d0c))
* **ios:** decode engine_plan_proposal event ([f7fff62](https://github.com/dsswift/ion/commit/f7fff62144ba0c1b4a585f7fc3df4664c1609308))
* **ios:** decode engine_early_stop_decision_request event ([6f32778](https://github.com/dsswift/ion/commit/6f3277851cbc4658c502bddfda8f10e26052c749))
* **desktop:** project user settings to iOS via wire protocol ([5d8e596](https://github.com/dsswift/ion/commit/5d8e5962f54c29c29dffd6b313af73a47b7c421c))
* **ios:** show desktop settings with apple-style settings ui ([268e133](https://github.com/dsswift/ion/commit/268e1339f29932d50eeeecd28f9a8aec9348c8a1))
* **ios:** decode engine_command_registry + engine_command_result ([7c659c0](https://github.com/dsswift/ion/commit/7c659c0040a1717f2de48b48ef048b784685e0ce))
* **ios:** add device-locked handling in install flow ([70614b0](https://github.com/dsswift/ion/commit/70614b0b154cb0167b5b431907ed7c4f62686194))

### Bug Fixes

* **ios:** write optimistic message timestamp in milliseconds ([774fce8](https://github.com/dsswift/ion/commit/774fce85c0e414111b04cfa2aac5141f8247c39d))
* **ios:** add opus 4.7 to available models ([b85db64](https://github.com/dsswift/ion/commit/b85db64ca9cfa3e1b1bd9608f4a3a454d438c93a))
* **ios:** refresh git on tab list, pane open, foreground ([3c0fbaa](https://github.com/dsswift/ion/commit/3c0fbaa451a81e0d5b0742dd58f42d1288b3adb0))

## [1.29.0](https://github.com/dsswift/ion/compare/ios-v1.28.0...ios-v1.29.0) (2026-05-22)

### Features

* **ios:** add ask user question card ([bad41e9](https://github.com/dsswift/ion/commit/bad41e9cc5fa9f8ec14119686f6ee29f4d3c924a))
* **ios:** add collapsed count badge to harness messages ([b96e9b1](https://github.com/dsswift/ion/commit/b96e9b11bc1b1379aa05150d5e523ffc539b096a))
* **ios:** persist and restore draft input in tabs ([3e5f026](https://github.com/dsswift/ion/commit/3e5f026fb577af34d343112c755bd40c542c9083))
* **ios:** show running agent count in engine view ([05c9e10](https://github.com/dsswift/ion/commit/05c9e109645b63674f333a3e96b11d42980b20ea))
* **ios:** add remote display customization ([6920b86](https://github.com/dsswift/ion/commit/6920b86a1e0d1b1fb5d4c168a0dd52aec335f555))
* **ios:** enhance tab views with git status display ([1e1178d](https://github.com/dsswift/ion/commit/1e1178de2a709a51c60a25b419cfbe2c004a0f72))
* **ios:** add voice-to-text input ([da105eb](https://github.com/dsswift/ion/commit/da105ebf43eb5a18826ceafef9ae33d3165c18e9))
* **ios:** add tab group pinning functionality ([13f81f4](https://github.com/dsswift/ion/commit/13f81f41f444c0e69524532a60b18a7d0cce70fc))

### Bug Fixes

* **ios:** resolve nil instanceId and rekey state on instance move ([3430ffd](https://github.com/dsswift/ion/commit/3430ffd41dfb61f0ebec15608d149b7078a9b8e9))
* **ios:** reload conversation on reconnect ([5dfc5c7](https://github.com/dsswift/ion/commit/5dfc5c7ff6b5004b924fa4b9fe40db83eccc4862))
* **ios:** fix speech engine transcript accumulation ([03f5a2f](https://github.com/dsswift/ion/commit/03f5a2ff637036fb52e462d961deb14055807cd7))

## [1.28.0](https://github.com/dsswift/ion/compare/ios-v1.27.0...ios-v1.28.0) (2026-05-21)

### Features

* **ios:** add tab search functionality ([1d036c2](https://github.com/dsswift/ion/commit/1d036c2bec2963d64d78140c801be666876e0ba0))
* **ios:** show thinking status on prompt send ([a809371](https://github.com/dsswift/ion/commit/a809371de2cb079b389f647841b760e323e8973a))
* **ios:** add multiline input to prompt field ([555f5d5](https://github.com/dsswift/ion/commit/555f5d5ebcde85d34d298541c672629b86a1e138))
* **ios:** add engine instance move command ([3d6b7de](https://github.com/dsswift/ion/commit/3d6b7de549b6ace4940d7d5ac1874c755d0891e2))
* **ios:** add engine instance move event handling ([4a4d73b](https://github.com/dsswift/ion/commit/4a4d73b5d769dc01f78627fd3696ab7cca3caf13))
* **ios:** add ui for moving engine instances ([a45619a](https://github.com/dsswift/ion/commit/a45619a77c73428afb5ee548f5d6bc985d0523fd))

### Bug Fixes

* **ios:** remove delay when loading engine messages ([671aeb7](https://github.com/dsswift/ion/commit/671aeb7d2fb10badc462f26b1dea6ecc2e765883))

## [1.27.0](https://github.com/dsswift/ion/compare/ios-v1.26.1...ios-v1.27.0) (2026-05-20)

### Features

* **ios:** add collapsible tab groups with persistence ([a184b27](https://github.com/dsswift/ion/commit/a184b276a73e714fae2a151e7eea114cbceb2336))
* **ios:** add conversation attachments sheet ([f048763](https://github.com/dsswift/ion/commit/f048763fc1dc887d4171d8bd27f8816d5e543e4a))
* **ios:** add file loading to ios explorer ([a650629](https://github.com/dsswift/ion/commit/a6506291d67475277125b29a0f11434b1b899222))
* **ios:** add attachment command and events ([76cc3da](https://github.com/dsswift/ion/commit/76cc3dab94a293724fc19cf500b7da7223dd3de2))

## [1.26.1](https://github.com/dsswift/ion/compare/ios-v1.26.0...ios-v1.26.1) (2026-05-19)

### Bug Fixes

* **engine:** unify context window and persist token cache ([5024b80](https://github.com/dsswift/ion/commit/5024b805f4b25dff5ea9dc9f6b5cb470d4a3a61c))

## [1.26.0](https://github.com/dsswift/ion/compare/ios-v1.25.0...ios-v1.26.0) (2026-05-19)

### Features

* **ios:** add tab group reordering support ([7ea1733](https://github.com/dsswift/ion/commit/7ea1733569d5a841308814d6feea3cd4dbadd62c))

### Bug Fixes

* **ios:** filter stale device pairings from install detection ([999f58b](https://github.com/dsswift/ion/commit/999f58bd36140a2a6994aa5cb67402701197ac44))

## [1.25.0](https://github.com/dsswift/ion/compare/ios-v1.24.0...ios-v1.25.0) (2026-05-19)

### Features

* **ios:** add model list support to remote protocol ([91f2eb6](https://github.com/dsswift/ion/commit/91f2eb6442bfa0d8ea85dfd2f72dd0c9f6d14904))

### Bug Fixes

* **ios:** correct diagnostic log event name ([33938f5](https://github.com/dsswift/ion/commit/33938f5c04db9473b428f7d80f992a336bb38e67))

## [1.24.0](https://github.com/dsswift/ion/compare/ios-v1.23.0...ios-v1.24.0) (2026-05-17)

### Features

* **ios:** add terminal snapshot buffering ([66db599](https://github.com/dsswift/ion/commit/66db59958b6695e389e9fc7094f8e49648150332))
* **ios:** add git operations with graph visualization and commit details ([75c9fb7](https://github.com/dsswift/ion/commit/75c9fb7289c33b23ca688ed7e098e2fecaacefc0))
* **ios:** add crash signal and exception handler to diagnostic logs ([d674e4f](https://github.com/dsswift/ion/commit/d674e4ffeb045af406dbbc832227f19799bab554))

### Bug Fixes

* **ios:** buffer snapshot updates before viewDidLoad to prevent crash ([8e2aa59](https://github.com/dsswift/ion/commit/8e2aa59a25cc441cac77138ab138b880c7ec2ffb))
* **ios:** correct tab selection for conversation ([5699cf1](https://github.com/dsswift/ion/commit/5699cf1da2fa0e682b363bb2181c5c906027af3b))
* **ios:** deduplicate messages to prevent ui crashes ([258164c](https://github.com/dsswift/ion/commit/258164c0efa490e4b04152ee8ba9cd75cffd1a6c))

## [1.23.0](https://github.com/dsswift/ion/compare/ios-v1.22.0...ios-v1.23.0) (2026-05-16)

### Features

* **ios:** move plan/auto toggle to status bar ([8bc21c5](https://github.com/dsswift/ion/commit/8bc21c5be0d653aef972acb588b45cbeb48c775f))

### Bug Fixes

* **ios:** streamline conversation toolbar layout ([0c2732f](https://github.com/dsswift/ion/commit/0c2732f0aba353f1fabbcbff7bb051101729d14a))
* **ios:** stamp version from VERSION file at build time ([ab09672](https://github.com/dsswift/ion/commit/ab0967204b7b518ef06f3da1697f917637236abc))
* **ios:** use copy-on-write for message mutations ([8e7c2f4](https://github.com/dsswift/ion/commit/8e7c2f4740f7f5d9e857d850ea2ba2f182f84bb3))

## [1.22.0](https://github.com/dsswift/ion/compare/ios-v1.21.0...ios-v1.22.0) (2026-05-15)

### Features

* **ios:** add client message id to prompt commands ([0a452c9](https://github.com/dsswift/ion/commit/0a452c93f6cf247d42564555c02bceb7b4d03e1d))
* **ios:** add persistent rolling logs and diagnostic instrumentation ([0516ecb](https://github.com/dsswift/ion/commit/0516ecb3897a669c25892f7a37486b44ee48e164))

## [1.21.0](https://github.com/dsswift/ion/compare/ios-v1.20.0...ios-v1.21.0) (2026-05-15)

### Features

* **ios:** add toast notification system ([77d22bf](https://github.com/dsswift/ion/commit/77d22bf8417d740f440685ab184359b5a7483200))

## [1.20.0](https://github.com/dsswift/ion/compare/ios-v1.19.0...ios-v1.20.0) (2026-05-15)

### Features

* **ios:** add image attachments to messages ([109795c](https://github.com/dsswift/ion/commit/109795c54a055d92832415528fa77bef8dce1a80))

## [1.19.0](https://github.com/dsswift/ion/compare/ios-v1.18.1...ios-v1.19.0) (2026-05-15)

### Features

* **ios:** add correlation id to file upload flow ([6e51d30](https://github.com/dsswift/ion/commit/6e51d30d110f628f96be23198abe0cfbb0a35974))
* **ios:** add lastActivityAt tracking to tab state ([f58b474](https://github.com/dsswift/ion/commit/f58b474739f37d56676ab94da3158cf9b3d6703e))
* **ios:** add voice mode with TTS playback and controls ([6f05ca2](https://github.com/dsswift/ion/commit/6f05ca289bed3daf037bc817b77a2970f64bb791))
* **ios:** reposition permission card above status bar ([99a9a74](https://github.com/dsswift/ion/commit/99a9a74fc217338fe400b1d33984ac4723b217d0))
* **ios:** add collapsible plan approval card ([808c022](https://github.com/dsswift/ion/commit/808c02226fb6bd6dd6a0ca9f80c05e64a89a347e))

## [1.18.1](https://github.com/dsswift/ion/compare/ios-v1.18.0...ios-v1.18.1) (2026-05-14)

### Bug Fixes

* **ios:** improve voice TTS trigger and simplify settings UI ([8d4813c](https://github.com/dsswift/ion/commit/8d4813c8ac719991f1e33593068e3d0dd2637cb2))

## [1.18.0](https://github.com/dsswift/ion/compare/ios-v1.17.0...ios-v1.18.0) (2026-05-14)

### Features

* **ios:** add voice readback with ElevenLabs TTS on task complete ([baeb06e](https://github.com/dsswift/ion/commit/baeb06e6be66501c4f754313abb659060faa93dd))

## [1.17.0](https://github.com/dsswift/ion/compare/ios-v1.16.0...ios-v1.17.0) (2026-05-14)

### Features

* **ios:** add KeychainHelper for secure API key storage ([d9be704](https://github.com/dsswift/ion/commit/d9be704520f873db22d5bf4a0d2a0dc8b73833ec))
* **ios:** add VoiceService for ElevenLabs text-to-speech ([a3a5c7f](https://github.com/dsswift/ion/commit/a3a5c7f3dce59b8d4b09d4ade4595c06484b94f3))
* **ios:** add voice section to Settings for ElevenLabs TTS ([ac1f563](https://github.com/dsswift/ion/commit/ac1f5632b93b1372b4a1a7119e51f3d0045f598b))
* **ios:** add VoiceService and engineTurnHasText to SessionViewModel ([8c661f9](https://github.com/dsswift/ion/commit/8c661f94c243967aeb4388d53c828d8e31b43df5))
* **ios:** speak assistant responses via VoiceService in handleEngineMessageEnd ([6b97953](https://github.com/dsswift/ion/commit/6b979531da4fa4d92886cb753d88572b380cb6e8))

## [1.16.0](https://github.com/dsswift/ion/compare/ios-v1.15.1...ios-v1.16.0) (2026-05-14)

### Features

* **ios:** add agent status ui and dialog sheet ([da7bd9c](https://github.com/dsswift/ion/commit/da7bd9cdb4e413dc51720643fc6f2d213e47ebb3))
* **ios:** enhance agent bar with live timer and expansion ([7b00e53](https://github.com/dsswift/ion/commit/7b00e53d4833131939b09932ba1ae656a1df44bd))
* **ios:** add hours to duration display format ([c83599f](https://github.com/dsswift/ion/commit/c83599f059170fc17a159b4dffe075bb9bf56650))
* **ios:** add attachment support for conversations and engine tabs ([182e1aa](https://github.com/dsswift/ion/commit/182e1aafb670f1b4d3e11b96ff82c825557124bc))
* **ios:** add compaction row and blue activity indicator ([3c97833](https://github.com/dsswift/ion/commit/3c978330eb7567d3ea3b3b9e93e1449ebabd0aba))
* **ios:** dismiss keyboard after sending message ([75821c9](https://github.com/dsswift/ion/commit/75821c9a0d9835605bb59c8b97712b86b64b23a2))
* **ios:** add implement button to plan full screen ([7928f26](https://github.com/dsswift/ion/commit/7928f26e9820d677c68dcd4913a8ee476cc7be02))
* **ios:** add native iPad support with sidebar navigation ([0260248](https://github.com/dsswift/ion/commit/026024888b1ffacbbe8c47d1ccc7342523d9f015))
* **ios:** add multi-device install with interactive selec... ([5755dbe](https://github.com/dsswift/ion/commit/5755dbeda0b60e42f92d7ba014d89551af532284))
* **ios:** add model selection commands and ui ([d05bbda](https://github.com/dsswift/ion/commit/d05bbda2c437e49d2765fc8522befc1ab9f539e9))
* **ios:** add optimistic user message rendering ([0420f85](https://github.com/dsswift/ion/commit/0420f85915bd82364f58e016f3ac6726b4275575))
* **ios:** replace LazyVStack scroll with UICollectionView ([beb41a4](https://github.com/dsswift/ion/commit/beb41a44d65adca4e51638e49c9c948972abf275))

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

