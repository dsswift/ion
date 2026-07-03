# Changelog

All notable changes to the iOS app will be documented here. This file is
maintained by the release pipeline; do not edit by hand.

## 1.0.0 - 2026-04-28

Initial 1.0.0 baseline. Reference iOS client for Ion Engine, connecting
through the relay to access remote engine instances.

Subsequent versions will be auto-generated from conventional commit messages.

## [1.44.0](https://github.com/dsswift/ion/compare/ios-v1.43.0...ios-v1.44.0) (2026-07-03)

### Features

* **ios:** unify plain and extension-hosted conversations (#256) ([02bae5f](https://github.com/dsswift/ion/commit/02bae5f9d097a8bd76512370ec944e788fcd602a))
* **ios:** project dispatch depth/parentId onto iOS surface ([6918d48](https://github.com/dsswift/ion/commit/6918d484444735de17cb3e63f2f16a793d435d61))
* **ios:** dispatch telemetry, Transcript view, recursive agent popup ([0a3b346](https://github.com/dsswift/ion/commit/0a3b3462e5f7b63df55a8d50bd0b3b0c51197d72))
* **ios:** thinking-hoist parity + label parity + dead-code cleanup ([678839e](https://github.com/dsswift/ion/commit/678839ef24af0b9b38a6a6d2c082277a82279f22))
* **ios:** desktop_request_context_breakdown + session ID fix ([9eb4b06](https://github.com/dsswift/ion/commit/9eb4b06a2cb0ba5e5fdb3271ca39c3789cf8ca12))
* **ios:** iOS desktop_context_breakdown wire + RemoteTabState cost/token fields ([1c1089a](https://github.com/dsswift/ion/commit/1c1089a083fee498d97d2278e648226aeef1ad11))

### Bug Fixes

* **ios:** restore plan divider Message decode across restart ([f785bca](https://github.com/dsswift/ion/commit/f785bcaa0dfb7d92ddf0b67468cf86c46cb1c3cb))
* **ios:** drive plan marker from plan_file_written not entry ([795116c](https://github.com/dsswift/ion/commit/795116c6a9b555e5aa3ccd550ef07c79bd50ec50))
* **ios:** sync dispatchId contract ([76e4d1c](https://github.com/dsswift/ion/commit/76e4d1cd616fba9ebc7cece9837503926a591ebf))
* **ios:** add SendIntent enum and essential deferred queue ([652d2f0](https://github.com/dsswift/ion/commit/652d2f031e1ad5fbc8bfa81e647bd277d28d3ae7))

## [1.43.0](https://github.com/dsswift/ion/compare/ios-v1.42.0...ios-v1.43.0) (2026-06-19)

### Features

* **ios:** add clear-all to global notifications panel ([4ff105b](https://github.com/dsswift/ion/commit/4ff105b97e4390ec6d17ecb52369c07e6edfc9b7))
* **ios:** render slash pill from engine metadata ([708369d](https://github.com/dsswift/ion/commit/708369db1aa9aa8c22778cb04cbfef00b4f6c380))

## [1.42.0](https://github.com/dsswift/ion/compare/ios-v1.41.0...ios-v1.42.0) (2026-06-18)

### Features

* **ios:** desktop_ wire prefix + paged plan-content fetch (#240) ([e351845](https://github.com/dsswift/ion/commit/e351845d8895bca575bdc44fbfe295135277e949))
* **ios:** render extended-thinking row + toggle (#158) ([5f86aaa](https://github.com/dsswift/ion/commit/5f86aaa34dba282d331a5ee3d1c8676851bb3813))
* **ios:** per-conversation thinking picker in conversation status bar ([51537d7](https://github.com/dsswift/ion/commit/51537d77d28eadac4b531c8b5b3b4d43204845c0))

### Bug Fixes

* **ios:** seed file editor from cached content on reopen ([618220b](https://github.com/dsswift/ion/commit/618220b6bbcaf77be81f57c1fb88992a55c7d7c7))

## [1.41.0](https://github.com/dsswift/ion/compare/ios-v1.40.0...ios-v1.41.0) (2026-06-16)

### Features

* **ios:** kind-agnostic resource rendering (#179) ([0f5ac8d](https://github.com/dsswift/ion/commit/0f5ac8d5c02446817d768598361429c809a8f0e2))

## [1.40.0](https://github.com/dsswift/ion/compare/ios-v1.39.0...ios-v1.40.0) (2026-06-15)

### Features

* **ios:** add engine-tab rewind to reach desktop parity ([305f3bf](https://github.com/dsswift/ion/commit/305f3bf90e0f4567672fb5918506820c2bf4aec8))
* **ios:** rename Engine* instance vocab to Conversation* ([1dae06b](https://github.com/dsswift/ion/commit/1dae06b0337b64722901d6bf96445cc06f123fd3))

### Bug Fixes

* **ios:** mirror engine context window fix in status bar ([f0bdd9e](https://github.com/dsswift/ion/commit/f0bdd9ebbcabcecc707da978ed248e23fe06901c))
* **ios:** suppress restored card after /clear divider ([f8109a1](https://github.com/dsswift/ion/commit/f8109a1e8329fb58ca5fd32a98671356ddf6dbe4))

## [1.39.0](https://github.com/dsswift/ion/compare/ios-v1.38.0...ios-v1.39.0) (2026-06-12)

### Features

* **ios:** add resource event decoding with NormalizedEvent+Resource (#180) ([b26a1f4](https://github.com/dsswift/ion/commit/b26a1f41a8e39610e6937082a9767092e7bf717c))
* **ios:** decode plan-mode auto-exit event with contract sync tests (#187) ([4e93efa](https://github.com/dsswift/ion/commit/4e93efa5ed797b7055def44c0bf4d280d52250fe))
* **ios:** render model fallback indicator on engine instance (#174) ([464cf69](https://github.com/dsswift/ion/commit/464cf697c135f83fe58228ad92700d40c315bb52))
* **ios:** add NotificationsView, ResourceStore, and delete support (#188) ([e5bb058](https://github.com/dsswift/ion/commit/e5bb05866a9831d81d8bae71f447eb8a3fbc053e))
* **ios:** add slash command autocomplete and frontmatter rendering ([09c9714](https://github.com/dsswift/ion/commit/09c97142513e10f56aed159475796bc033f2974c))
* **ios:** add intercept rendering and focus reporting ([324c188](https://github.com/dsswift/ion/commit/324c188b9a2562b134e156dd36b46a15f469e1b7))
* **ios:** add sub-tab close confirmation and awaiting-children state ([8427f0f](https://github.com/dsswift/ion/commit/8427f0f9e882767704e1bbaeaa661307f0988322))
* **ios:** mirror ConversationInstance with per-instance EngineInstanceInfo (#203) ([d8ae2d9](https://github.com/dsswift/ion/commit/d8ae2d9887bf08f4ee1df5f849daff58de2fc603))
* **ios:** decode RunStalledEvent and add engine run stalled handler ([2a5fd53](https://github.com/dsswift/ion/commit/2a5fd531bcb261ad3955a59e6412aadd830a6291))
* **ios:** add session status event dispatcher and synthesis tests ([79576a3](https://github.com/dsswift/ion/commit/79576a3cef69346c4fa1049e56235bb248f81ca6))
* **ios:** display conversationId on engine instance bar and context menu (#213) ([a8c6795](https://github.com/dsswift/ion/commit/a8c67957fc4146b292ac2b6e8f1508ba121352c4))
* **ios:** add resource manifest sync, persistence, and attachments UI (#212) ([039ef6e](https://github.com/dsswift/ion/commit/039ef6ec32fd9b270fb5fc4f097451738f02407c))

### Bug Fixes

* **ios:** stabilize snapshot-driven engine state and event decoding ([7cd4a25](https://github.com/dsswift/ion/commit/7cd4a259d37a05457a403272bdf28aed7a631f95))
* **ios:** add payload compression and align transport receive decoding ([ad20877](https://github.com/dsswift/ion/commit/ad208772b3eb663fc6bc9f95affcc394069169f4))
* **ios:** fix streaming auto-tail and scope plan card per instance ([7c834dd](https://github.com/dsswift/ion/commit/7c834dd3fb2819d1f95211fdfdc377c8404682de))
* **ios:** fix attachment loading, caching, and engine instance switching ([653c356](https://github.com/dsswift/ion/commit/653c35690966e9e0bcf0b07417df3381389200c5))

## [1.38.0](https://github.com/dsswift/ion/compare/ios-v1.37.0...ios-v1.38.0) (2026-06-05)

### Features

* **engine:** fall back to default model on unresolved tier alias (#174) ([4a9d7af](https://github.com/dsswift/ion/commit/4a9d7af0d9cc017df65de66fff33d3b49accda6d))
* **desktop:** show yaml frontmatter in markdown preview ([6e3ebb9](https://github.com/dsswift/ion/commit/6e3ebb972fb0a16926118c8caf874d8fe0e9985e))

### Bug Fixes

* **desktop:** show ion-native slash commands when claude-compat off ([1481e56](https://github.com/dsswift/ion/commit/1481e560f3c6e39d89fbba410f07cfc2c3e262e2))

## [1.37.0](https://github.com/dsswift/ion/compare/ios-v1.36.0...ios-v1.37.0) (2026-06-05)

### Features

* **ios:** add keyboard utility bar with per-view toggles ([acee173](https://github.com/dsswift/ion/commit/acee1738c57ef0806d1d1aec7970cd830f3d2fd0))
* **ios:** mirror desktop categories + full settings projection ([b248eaf](https://github.com/dsswift/ion/commit/b248eafde082a4611d9f8b786e25804e2c609be6))
* **engine:** configurable bash commands in plan mode ([d7e6c5f](https://github.com/dsswift/ion/commit/d7e6c5f7fa0dd2695e54a7f96809db586c0217b2))

### Bug Fixes

* **ios:** shrink oversized system toast notifications ([7588303](https://github.com/dsswift/ion/commit/75883033d7809609bac5490ebf896e383590c12c))
* **ios:** render attached images on engine prompt without reload ([2fcd2d4](https://github.com/dsswift/ion/commit/2fcd2d40fa9878fbc6b960358cfedb20ea2bdb5b))
* **ios:** restore keyboard utility bar toggles in Appearance ([a9d454d](https://github.com/dsswift/ion/commit/a9d454da7c926fa5575cbefdc5af4debc3fb9ae7))

## [1.36.0](https://github.com/dsswift/ion/compare/ios-v1.35.0...ios-v1.36.0) (2026-06-04)

### Features

* **desktop:** badge slash commands in user message bubbles ([40211f2](https://github.com/dsswift/ion/commit/40211f213c6cec77e281c0a9c28d9f0db3d17442))
* **desktop:** add pill icon presets and project iOS pill state ([d580162](https://github.com/dsswift/ion/commit/d580162478286e4199d81d6e7891332193fc46f6))
* **ios:** add implement divider, plan events, and clear-context option ([848ee49](https://github.com/dsswift/ion/commit/848ee490c566393e98b987412547e805f932b352))
* **ios:** implement unified turn grouping in ui ([de98622](https://github.com/dsswift/ion/commit/de9862266105bab49a09f56c8791ac7502e23abb))
* **ios:** send reset_engine_session for engine-tab implement clear ([4bb69e5](https://github.com/dsswift/ion/commit/4bb69e5b17cb26888c5975ec26ef3198ef055d41))
* **ios:** mirror Steer applied divider on engine_steer_injected ([bb8ba6b](https://github.com/dsswift/ion/commit/bb8ba6b6b2a0f6344724b66e99ad4d3d9fae78cd))

### Bug Fixes

* **ios:** remove ActiveToolRow ([3d2953f](https://github.com/dsswift/ion/commit/3d2953f816b5098007b2c42d90690978d7ed4880))
* **ios:** tint tab rows with pill color via listRowBackground ([4ee087d](https://github.com/dsswift/ion/commit/4ee087dea34f4bcf96e02257d3f2affd9f4e8748))

## [1.35.0](https://github.com/dsswift/ion/compare/ios-v1.34.0...ios-v1.35.0) (2026-06-03)

### Features

* **ios:** add fuzzy matching for slash commands ([b227651](https://github.com/dsswift/ion/commit/b227651a00a634eaa540b78e87d755b5ead7da92))

### Bug Fixes

* **ios:** replace markdown parser to fix truncation ([25a3649](https://github.com/dsswift/ion/commit/25a364914dfc002f0ffbec70677f82c9a28183e4))

## [1.34.0](https://github.com/dsswift/ion/compare/ios-v1.33.0...ios-v1.34.0) (2026-06-02)

### Features

* **ios:** add Jarvis arc reactor theme system ([6e2df40](https://github.com/dsswift/ion/commit/6e2df40a1ed91ca15c574255e7be3dfe71548936))
* **ios:** unify conversation and engine rendering ([91aad3c](https://github.com/dsswift/ion/commit/91aad3ced3dd6eb5cf52ee3d653f3a3f4290d8aa))
* **ios:** add device switch button in Settings ([2fd6c04](https://github.com/dsswift/ion/commit/2fd6c0433b2f597e54ebcf5a94d90cfb042c06a8))
* **engine:** aggregate dispatches into pager with array model ([5d9cf05](https://github.com/dsswift/ion/commit/5d9cf057a46f69302699867adcca7241f94ebd17))
* **ios:** add terminal button to engine view toolbar ([3accedd](https://github.com/dsswift/ion/commit/3accedd4dfc42a76635a204574c3761591a892f2))
* **ios:** dispatch conversation lookup with caching ([4512473](https://github.com/dsswift/ion/commit/45124737149e105d7819d53ef5031d2d8c82ab52))
* **desktop:** dispatch pager conversation lookup and display ([992390d](https://github.com/dsswift/ion/commit/992390d4a191c294c34920bba17a3d8de74ef4b3))
* **ios:** add copy session id to tab context menus ([cd58d11](https://github.com/dsswift/ion/commit/cd58d1110b78d7bc410bbf1296aeb31d174c0e82))
* **ios:** theme-aware glass styling for tool and agent rows ([74fc399](https://github.com/dsswift/ion/commit/74fc3998b0d0c70dd0da5c48211cb41c256fd8da))
* **ios:** add full-screen agent detail view with dispatch support ([1b5b7e4](https://github.com/dsswift/ion/commit/1b5b7e4aa09615b97421e7ff84ff5e708b5d905d))

### Bug Fixes

* **engine:** preserve background dispatch agent visibility on run exit ([884d853](https://github.com/dsswift/ion/commit/884d8530f66423256399500f396afdca06105623))
* **ios:** seal engine assistant messages at turn boundary ([055b279](https://github.com/dsswift/ion/commit/055b279c94be9c5eb786d8aea33e2636a28e1b46))
* **ios:** use VStack for markdown content to fix cell sizing ([bc7eaf9](https://github.com/dsswift/ion/commit/bc7eaf9b27e611ecde781506ea26d49ba279f467))
* **ios:** respect agent panel default open setting ([3ce23c4](https://github.com/dsswift/ion/commit/3ce23c4eeadb9ad471ab945515bbe8aff02875b5))

## [1.33.0](https://github.com/dsswift/ion/compare/ios-v1.32.0...ios-v1.33.0) (2026-05-31)

### Features

* **ios:** add running state to engine instances ([2b77813](https://github.com/dsswift/ion/commit/2b77813fd1ad901fb22590086c7a4abae907e251))

## [1.32.0](https://github.com/dsswift/ion/compare/ios-v1.31.0...ios-v1.32.0) (2026-05-31)

### Features

* **ios:** add file rename support in file explorer ([4a3a205](https://github.com/dsswift/ion/commit/4a3a2058deaf247c505c9d029a1f3f8a6c0fc145))
* **engine:** add agent dispatch lifecycle with redispatch ([f9fff27](https://github.com/dsswift/ion/commit/f9fff27fccee90c2193214071c6a96aac47d493a))
* **ios:** add plan/auto toggle to engine tab footer ([1ee8beb](https://github.com/dsswift/ion/commit/1ee8beba06a0217095f8e0c683bb9d1fdc3ac12f))
* **ios:** add agent conversation support to remote ([527d63a](https://github.com/dsswift/ion/commit/527d63add02cd0ada892e8cf25303035352f9d56))

### Bug Fixes

* **ios:** add AskUserQuestion and permission card rendering to engine view ([72b13e0](https://github.com/dsswift/ion/commit/72b13e0af2499626eb4b764b02448c1838526807))
* **ios:** handle malformed tabs in snapshot decode ([0564032](https://github.com/dsswift/ion/commit/0564032507f60cb1f1551680660b090373742885))
* **ios:** prevent content overflow in message rows ([ab26367](https://github.com/dsswift/ion/commit/ab26367bed309789cef9e42cd52642784ae4f135))

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

