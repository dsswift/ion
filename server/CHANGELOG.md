# Changelog

All notable changes to the Ion Studio Server will be documented here. This
file is maintained by the release pipeline; do not edit by hand.

## 0.1.0

Initial scaffold. Package, workspace membership, and CI lane created by the
Ion Studio Server, Environments, and Overlay Removal program (child 04).

## [1.11.0](https://github.com/dsswift/ion/compare/server-v1.10.0...server-v1.11.0) (2026-10-05)

### Features

* **server:** switch branches and reload the new path (#481) ([9d665ff](https://github.com/dsswift/ion/commit/9d665ffa3ff295fd01d6da7b73cb3f2661af5023))
* **server:** close ephemeral worktrees with their conversation (#482) ([4cbacfe](https://github.com/dsswift/ion/commit/4cbacfe28cb761ece68c05965fcbbe639a02edc6))
* **ios:** pick a conversation branch from the phone (#481) ([7aa5421](https://github.com/dsswift/ion/commit/7aa542133b8b6e156fd02087cad0e21aa05c781d))
* **server:** remember a project's worktree choice (#482) ([6c6e649](https://github.com/dsswift/ion/commit/6c6e649db5d3d073011cd5bb24894b4a2d8e529c))
* **desktop:** remember worktree choices per project (#482) ([3f80caf](https://github.com/dsswift/ion/commit/3f80caf6aa4d2b456f8a1ef71e0e597f61fd912d))
* **server:** add build notice preference type ([4e23fd7](https://github.com/dsswift/ion/commit/4e23fd7baf22fcf0632ccde4fb2a62fe411e9793))

### Bug Fixes

* **server:** stop tying plan mode to the EnterPlanMode tool ([1e31953](https://github.com/dsswift/ion/commit/1e3195372f69e00257ccb9d28d7b2baec6621b94))
* **server:** size the bench conflict tests for real git (#479) ([4c3812e](https://github.com/dsswift/ion/commit/4c3812ed801fc27f084007ac374fc49eb28a81c1))
* **server:** keep the bench conflict test under the size cap (#479) ([a493677](https://github.com/dsswift/ion/commit/a493677a9f2fcd4f74a8f34ecd000ab0d1fb3d16))
* **server:** keep the preferences comment on its command (#481) ([c2b6b72](https://github.com/dsswift/ion/commit/c2b6b72a648db5569e6ee13e8714817f9d1520d8))
* **server:** finish a discard that setup interrupted ([4d42f64](https://github.com/dsswift/ion/commit/4d42f64f5234e30c9b50b61e3556fce2e7df11ed))

## [1.10.0](https://github.com/dsswift/ion/compare/server-v1.9.2...server-v1.10.0) (2026-10-05)

### Features

* **server:** track provider accounts and show their quota in the fleet ([8973bac](https://github.com/dsswift/ion/commit/8973bac6bc780358482013b1dedfdc71a9df2114))
* **server:** run the fleet on studio's pairings and unify its page ([159fbe1](https://github.com/dsswift/ion/commit/159fbe1fdf1ad36c595dab35d79d788e054bc058))
* **server:** place and queue conversations by provider quota ([9c5b46f](https://github.com/dsswift/ion/commit/9c5b46f1ce9a0be2e452801503ebbbef1cec1d18))
* **server:** switch, sign in, and remove provider accounts from the fleet ([6c97e51](https://github.com/dsswift/ion/commit/6c97e51f3d3d10d30cfd2918ec6bda830a009ec0))
* **server:** deploy releases and builds across fleet hosts ([e79bfcb](https://github.com/dsswift/ion/commit/e79bfcb93be71c4a88d1f0ee10ffac45d10a3247))
* **server:** add the fleet hub ([f163603](https://github.com/dsswift/ion/commit/f16360331177a7b4cf5ca39ef5e11cf8860a55d4))

### Bug Fixes

* **server:** keep tab saves flowing while conversations stream ([01e4585](https://github.com/dsswift/ion/commit/01e4585288cfa12da2c097d84c6700f0b46f1f93))

## [1.9.2](https://github.com/dsswift/ion/compare/server-v1.9.1...server-v1.9.2) (2026-10-03)

### Bug Fixes

* **server:** disenroll bench members whose worktree was deleted ([89db3ea](https://github.com/dsswift/ion/commit/89db3eafaa3b6dda9e6a6d8ae812763d0ee34aa6))

## [1.9.1](https://github.com/dsswift/ion/compare/server-v1.9.0...server-v1.9.1) (2026-10-03)

### Bug Fixes

* **server:** keep managed refusal code on allowlist write (#471) ([2e1f614](https://github.com/dsswift/ion/commit/2e1f614745642d1631e7be63a2508d27fbf013f8))

## [1.9.0](https://github.com/dsswift/ion/compare/server-v1.8.0...server-v1.9.0) (2026-10-03)

### Features

* **server:** refuse developer surfaces a server does not offer (#392) ([e5f553c](https://github.com/dsswift/ion/commit/e5f553c285e36ab70d95e06b383b0be405760c77))

## [1.8.0](https://github.com/dsswift/ion/compare/server-v1.7.0...server-v1.8.0) (2026-10-02)

### Features

* **server:** honor a managed engine config file (#393) ([51f5835](https://github.com/dsswift/ion/commit/51f5835ef3092255b3403db0f661a71da2266898))

## [1.7.0](https://github.com/dsswift/ion/compare/server-v1.6.0...server-v1.7.0) (2026-10-02)

### Features

* **server:** resolve enterprise policy per principal (#395) ([8307428](https://github.com/dsswift/ion/commit/8307428ba0c60372ff310f5accad7e8667b1879d))

## [1.6.0](https://github.com/dsswift/ion/compare/server-v1.5.0...server-v1.6.0) (2026-10-02)

### Features

* **server:** pass policy failures and messages to clients (#386) ([fa95a5d](https://github.com/dsswift/ion/commit/fa95a5d637c8658be9df60a126cb6364e47eb28f))
* **server:** pass the blocked extension to clients (#390) ([d3e1840](https://github.com/dsswift/ion/commit/d3e184040e6ad40a7d4c23d4e355d1c7863888df))

## [1.5.0](https://github.com/dsswift/ion/compare/server-v1.4.0...server-v1.5.0) (2026-10-02)

### Features

* **engine:** report policy override notices (#385) ([e6befb1](https://github.com/dsswift/ion/commit/e6befb1aa7655cf925cb2c010b830c2959a99180))
* **repo:** resolve per-key settings mutability from policy (#394) ([ef9ddae](https://github.com/dsswift/ion/commit/ef9ddae88bf91412c4d0cde114d8fbb320e8b5fa))
* **desktop:** separate foreground theme tokens by surface role (#396) ([effb8e8](https://github.com/dsswift/ion/commit/effb8e857d81006589957460f90902171a82f4cc))

### Bug Fixes

* **server:** drop an unused discovery import ([6f0c915](https://github.com/dsswift/ion/commit/6f0c9153cf1854e5f0abce87ab83b99cafb6ab36))
* **server:** stop the bench poll re-logging unchanged members ([5e14fb6](https://github.com/dsswift/ion/commit/5e14fb6a6df819bd669bf85e386f39950045ec49))
* **server:** keep an auto-fix tab whose operation is still open ([5a3d91e](https://github.com/dsswift/ion/commit/5a3d91efbe7d71534accf63efd820e3bfceaca26))
* **server:** let a bench merge take one side of a conflict ([803b6a3](https://github.com/dsswift/ion/commit/803b6a3ed1abf270124172a478f27a3ba35cbb25))
* **server:** keep an open bench merge reachable and abortable ([2e00f7b](https://github.com/dsswift/ion/commit/2e00f7bb1d07c3cac789dde364e89ece03e141ac))

## [1.4.0](https://github.com/dsswift/ion/compare/server-v1.3.0...server-v1.4.0) (2026-10-01)

### Features

* **server:** prompt when a provider subscription needs a person (#459) ([7469856](https://github.com/dsswift/ion/commit/746985672c68aa7ee856888becd9079db0b6bd96))
* **desktop:** always show task lists in dispatch previews ([a0f4dd6](https://github.com/dsswift/ion/commit/a0f4dd6c9d5ac11d27e5b401380765aab5072086))
* **server:** seal the managed-mode marker and log its status (#460) ([ecc3e53](https://github.com/dsswift/ion/commit/ecc3e5379d2c34bf19ec6b7b5844aa0fb47f5182))

### Bug Fixes

* **server:** never retire a worktree the export did not carry ([01a5b51](https://github.com/dsswift/ion/commit/01a5b51cb1c540ae1b54ae04eebe4e2ec3c27f79))
* **desktop:** fold root sections on explorer collapse all ([c8f1b72](https://github.com/dsswift/ion/commit/c8f1b7283af7644f01c9da0a54e17a74d6cbb403))
* **server:** keep one identity for the local connection ([12a5e82](https://github.com/dsswift/ion/commit/12a5e8274638fce0958cbaeee15fa96e2158c03b))

## [1.3.0](https://github.com/dsswift/ion/compare/server-v1.2.2...server-v1.3.0) (2026-10-01)

### Features

* **server:** dial host ports for port forward streams ([380afed](https://github.com/dsswift/ion/commit/380afed192027cd5dad8bbc5a140d11dff832e7b))

## [1.2.2](https://github.com/dsswift/ion/compare/server-v1.2.1...server-v1.2.2) (2026-10-01)

### Bug Fixes

* **server:** stop an ended relay connection hearing the channel ([ab58aa9](https://github.com/dsswift/ion/commit/ab58aa94d582a5e36175b6a7cd2b97fd759a76cf))
* **server:** name a worktree only from its first prompt ([c5038ab](https://github.com/dsswift/ion/commit/c5038abf3d246eff56f74f065cfa20108bf29fe9))

## [1.2.1](https://github.com/dsswift/ion/compare/server-v1.2.0...server-v1.2.1) (2026-10-01)

### Bug Fixes

* **server:** keep a relay channel open across token expiries ([19660db](https://github.com/dsswift/ion/commit/19660dbf7a13e8d6825660beabf582a4ac26c242))
* **server:** stub the worktree title seed in send tests (#461) ([9924fa4](https://github.com/dsswift/ion/commit/9924fa4b6c95383ef5121bb413898a185d1dd468))

## [1.2.0](https://github.com/dsswift/ion/compare/server-v1.1.2...server-v1.2.0) (2026-10-01)

### Features

* **server:** refresh the static model list with current models ([aebc9ca](https://github.com/dsswift/ion/commit/aebc9caaef901ad6f078c53dcb6a320a6e4ddce3))

### Bug Fixes

* **server:** let a client remove a stored provider api key ([b6e9149](https://github.com/dsswift/ion/commit/b6e91490fb7d7c8ae1f64dae09b7be956100af70))
* **server:** answer git subscribe with the first repo snapshot ([d2553e1](https://github.com/dsswift/ion/commit/d2553e19f2219201c2bd344bfacbe2be10240e44))
* **server:** name a worktree from its conversation's title ([3a91a04](https://github.com/dsswift/ion/commit/3a91a045df5891a87730c388c24a51a713962488))

## [1.1.2](https://github.com/dsswift/ion/compare/server-v1.1.1...server-v1.1.2) (2026-09-30)

### Bug Fixes

* **server:** stop showing refused tools as pending approvals ([3c44cab](https://github.com/dsswift/ion/commit/3c44cabf5daa87cd103faa44b68069cba8e2db67))

## [1.1.1](https://github.com/dsswift/ion/compare/server-v1.1.0...server-v1.1.1) (2026-09-30)

### Bug Fixes

* **server:** recycle the engine inside the one startup start ([462feb6](https://github.com/dsswift/ion/commit/462feb6357537a7ee457c88d76065d4dcb815d14))

## [1.1.0](https://github.com/dsswift/ion/compare/server-v1.0.1...server-v1.1.0) (2026-09-30)

### Features

* **server:** expose the provider subscription to studio (#384) ([8c82627](https://github.com/dsswift/ion/commit/8c826275e8c2f6dca68520534c9c5f3cca4f529a))
* **desktop:** choose the provider subscription in settings (#384) ([3fe95e7](https://github.com/dsswift/ion/commit/3fe95e7ddb44c1a56843638e17a819bd8064a65d))

## [1.0.1](https://github.com/dsswift/ion/compare/server-v1.0.0...server-v1.0.1) (2026-09-30)

### Bug Fixes

* **server:** welcome clients with the loaded enterprise policy ([9c6f5b1](https://github.com/dsswift/ion/commit/9c6f5b11cfbee0ffd75854665f81bc4b858b5b7f))

## [1.0.0](https://github.com/dsswift/ion/compare/server-v0.1.0...server-v1.0.0) (2026-09-29)

### ⚠ BREAKING CHANGES

* **server:** move conversations and worktrees across machines ([1e67421](https://github.com/dsswift/ion/commit/1e674212188b3e0309dffa9e6eeb74ef103feac8))

### Features

* **server:** split the repo into npm workspaces ([fdb7372](https://github.com/dsswift/ion/commit/fdb737270aa8a8325f68889bb74e5218eb723579))
* **server:** move studio business logic into the studio server ([a4ddedd](https://github.com/dsswift/ion/commit/a4ddedd9eaecb031ef297a1d3e25633888c954a1))
* **server:** scope data, credentials, and tools per principal ([35cd780](https://github.com/dsswift/ion/commit/35cd780a5a9af83e5ffdb34039ed375d1bb6f451))
* **server:** reach studio servers through a relay ([83f20cd](https://github.com/dsswift/ion/commit/83f20cd51b4185356bca400ed1251724629bc5bb))
* **server:** pair clients with a studio server ([0666118](https://github.com/dsswift/ion/commit/0666118f014c0712b1426943dae95dddd19f55d2))
* **server:** move conversations and worktrees across machines ([1e67421](https://github.com/dsswift/ion/commit/1e674212188b3e0309dffa9e6eeb74ef103feac8))
* **server:** install studio servers on remote hosts ([673accc](https://github.com/dsswift/ion/commit/673accc6c9c6ba9f3acb48f7c318f00322982b0a))
* **server:** work across environments from one studio ([124c204](https://github.com/dsswift/ion/commit/124c2046dde20a056b5f1f371a1291523dd66599))
* **server:** make ios a direct studio wire client ([b7bb636](https://github.com/dsswift/ion/commit/b7bb636096f7ab8d66ce6e1cbe878683322d375e))
* **server:** retire the overlay presentation ([b97edd3](https://github.com/dsswift/ion/commit/b97edd392ae00e604f77b5497c146f463f165b1b))
* **server:** add the browser studio client ([c66afdd](https://github.com/dsswift/ion/commit/c66afdd79655f8b4f9175a42dde8adffb562dcbf))
* **server:** extend observability to server and clients ([6de0fb7](https://github.com/dsswift/ion/commit/6de0fb7f371370b24e0938ae6e965bec87ed395c))
* **server:** reuse terminal panes by launch key ([3e81ff7](https://github.com/dsswift/ion/commit/3e81ff7960030f520d73f8f173e861934cdf7777))
* **server:** rebuild settings around scopes and servers ([d8b3995](https://github.com/dsswift/ion/commit/d8b3995d58a537db48a7af83556edbc8dd0f4734))
* **server:** ship the studio server inside the desktop ([4eeb73f](https://github.com/dsswift/ion/commit/4eeb73ff07aeff497f7b503fb143c7880c369190))
* **server:** upgrade the composer editor and attachments ([c76a204](https://github.com/dsswift/ion/commit/c76a204c350d4b127edfc0c1d9505a294ae6c4ed))
* **server:** discover studio servers on the lan ([a4d4a88](https://github.com/dsswift/ion/commit/a4d4a88dbb38bf867034d7e5321286bebac26579))
* **server:** add studio sdk composer actions ([3d7cbcd](https://github.com/dsswift/ion/commit/3d7cbcd9db07c6e0f6f49c3d31a68be16b408313))
* **server:** send push notifications through the relay ([c97dce7](https://github.com/dsswift/ion/commit/c97dce70dbbc18030b2c62a6b4a6ff5e862c3771))
* **server:** retire the tab strip, tab groups, and icon ([6a85d51](https://github.com/dsswift/ion/commit/6a85d5114f10d5c808e81a2b99d2b6a38d727732))
* **server:** add ion fleet to deploy and watch hosts ([606c70d](https://github.com/dsswift/ion/commit/606c70d8baa49b807183579a59d32d7aed718bce))
* **server:** set mcp oauth clients from every client ([5017713](https://github.com/dsswift/ion/commit/5017713cc28dcb9d1e4d9410e3bf9df442dcdc4e))
* **server:** administer a server from the phone ([a479d86](https://github.com/dsswift/ion/commit/a479d8629102d93d92c7799fd14087475ea7f545))
* **server:** add workspace search and focus-aware find ([1c8a077](https://github.com/dsswift/ion/commit/1c8a077dc8c8681268715d699b7d9ecdc319065e))
* **server:** let a person mint a pairing link for their own devices ([6bf535a](https://github.com/dsswift/ion/commit/6bf535a610d3f3c7353d693cbffacdd42adba0f8))
* **server:** report directory tree changes to subscribers ([587106d](https://github.com/dsswift/ion/commit/587106dbd3f1852593b6c65c2ac13290fdfa38fa))

### Bug Fixes

* **server:** persist delegated cli turns, costs, and steers ([1240844](https://github.com/dsswift/ion/commit/124084469b22f10f8cb573e50612897e7a9a80df))
* **server:** resolve models on the server, never invent one ([1fc4821](https://github.com/dsswift/ion/commit/1fc4821d0e92548b26d37a0750adebbeac1f408e))
* **server:** run studio servers and desktops on windows ([2931a84](https://github.com/dsswift/ion/commit/2931a8450ae5cebd80a0e89f7650b2d911f385cc))
* **server:** label local sessions with the signed-in identity ([4eadf63](https://github.com/dsswift/ion/commit/4eadf63881724a9541632e7dfb63f65cdf5a595b))
* **repo:** keep log fields from overwriting the user label ([3cefa8e](https://github.com/dsswift/ion/commit/3cefa8e06dc4b4e5926a2a5c693db53275a97fa6))
* **server:** stop directory listings blocking on powershell ([659b5bf](https://github.com/dsswift/ion/commit/659b5bf665ec1719d979c7c919b538629652d9b7))
* **server:** skip the per-event probe in git watches ([44368bf](https://github.com/dsswift/ion/commit/44368bfa043f2896c9df9c66ccb3ed0ce4eac97b))
* **repo:** prune expanded explorer folders on windows paths ([6e9118a](https://github.com/dsswift/ion/commit/6e9118a13205c2278f334402a2150a8cdc18d2b1))
* **server:** let the file api tests run on windows paths ([da6e9c1](https://github.com/dsswift/ion/commit/da6e9c1d0478b0b58af6aa63b053a20b03663ffb))
* **server:** declare the studio mirror role at boot ([e9b91de](https://github.com/dsswift/ion/commit/e9b91de28756c2969dc442cc71ca4ca8e6e3e63b))
* **server:** run server tests in utc ([32cc4f3](https://github.com/dsswift/ion/commit/32cc4f3dd248ec7ce94dabf64cfba0e3369b68da))
* **server:** stop the tall-suspend test spawning real shells ([3b571a6](https://github.com/dsswift/ion/commit/3b571a67fa5858a688942708faba641da7c71d06))
* **server:** serve the wire test harness on a pipe on windows ([9e8278f](https://github.com/dsswift/ion/commit/9e8278f0bf423106c46f105b7139884aafc6779e))

