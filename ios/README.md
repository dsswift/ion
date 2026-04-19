# Ion Remote (iOS)

iPhone companion app for Ion Desktop. View agent sessions, approve permissions, and send prompts from your phone.

## Requirements

- Xcode 15+
- iOS 17+
- Ion Desktop running on the same network (for local pairing) or a relay server (for remote)

## Build

Open in Xcode and run:

```bash
cd ios
xcodebuild -project IonRemote.xcodeproj -scheme IonRemote \
  -destination 'generic/platform=iOS' build
```

Or open `IonRemote.xcodeproj` in Xcode and hit Run.

## Architecture

SwiftUI app with two connection modes:

```
iPhone --[LAN, Bonjour/mDNS]--> Ion Desktop (direct)
iPhone --[WebSocket, TLS]-----> Relay server --> Ion Desktop (remote)
```

- **BonjourBrowser:** discovers Ion Desktop on the local network via mDNS
- **LANClient:** direct WebSocket connection over LAN
- **RelayClient:** WebSocket connection through the relay server
- **TransportManager:** picks the best available transport (LAN preferred, relay fallback)
- **E2ECrypto:** end-to-end encryption for all messages (relay never sees plaintext)

### Key Components

| Directory | Purpose |
|-----------|---------|
| `IonRemote/App/` | App entry point |
| `IonRemote/Views/` | SwiftUI views: session list, permission cards, settings |
| `IonRemote/ViewModels/` | Session view model, state management |
| `IonRemote/Networking/` | Transport layer: LAN, relay, Bonjour |
| `IonRemote/Crypto/` | E2E encryption, keychain storage |
| `IonRemote/Models/` | Data models: messages, tabs, devices |

## Pairing

1. Open Ion Desktop settings, go to the Remote tab
2. A QR code appears with connection details
3. Scan the QR code from Ion Remote on your phone
4. Devices exchange encryption keys and connect

Once paired, the phone reconnects automatically on the same network. For remote access (different networks), both devices connect through the relay server.

## License

[MIT](LICENSE)
