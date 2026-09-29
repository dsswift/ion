# Changelog

All notable changes to the Ion Studio Server will be documented here. This
file is maintained by the release pipeline; do not edit by hand.

## 0.1.0

Initial scaffold. Package, workspace membership, and CI lane created by the
Ion Studio Server, Environments, and Overlay Removal program (child 04).

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

