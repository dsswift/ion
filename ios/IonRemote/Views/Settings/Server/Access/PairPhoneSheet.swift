import SwiftUI

/// Pairs another phone with a server: a QR code to scan, and the code to type
/// after finding the server nearby. Closes itself when the phone is paired or
/// the link expires.
struct PairPhoneSheet: View {
    @Environment(\.appTheme) private var theme
    @Environment(\.dismiss) private var dismiss
    let serverLabel: String
    @State var model: PairPhoneModel

    var body: some View {
        NavigationStack {
            List {
                if let offer = model.offer {
                    Section {
                        PairingQRCodeView(text: offer.url)
                            .frame(maxWidth: .infinity)
                            .listRowBackground(Color.clear)
                    } footer: {
                        Text("Scan this with the other phone's camera. Treat it as a password.")
                            .frame(maxWidth: .infinity)
                            .multilineTextAlignment(.center)
                    }
                    Section {
                        if let code = offer.code {
                            Text(code)
                                .font(.system(.title, design: .monospaced).weight(.semibold)) // design-type: display-size code read off this screen and typed on another device; text-style based, so it still scales
                                .tracking(3)
                                .textSelection(.enabled)
                                .frame(maxWidth: .infinity)
                        } else {
                            Text("\(serverLabel) has no code to type right now, so scan the QR code.")
                                .foregroundStyle(theme.textSecondary)
                        }
                    } header: {
                        Text("Or type this code")
                    } footer: {
                        if offer.code != nil {
                            Text("On the other phone, find \(serverLabel) nearby and type this code.")
                        }
                    }
                    Section {
                        TimelineView(.periodic(from: .now, by: 1)) { context in
                            LabeledContent("Expires in", value: AccessCountdown.remaining(until: offer.expiresAt, now: context.date))
                                .monospacedDigit()
                        }
                    } footer: {
                        Text("This closes when the phone is paired.")
                    }
                } else if let error = model.error {
                    Section {
                        Text(error).foregroundStyle(theme.statusError)
                    }
                } else {
                    Section {
                        HStack(spacing: IonSpace.compactGap) {
                            ProgressView()
                            Text("Preparing a pairing…").foregroundStyle(theme.textSecondary)
                        }
                    }
                }
            }
            .navigationTitle("Pair a phone")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { Task { await model.finish(.cancelled) } }
                }
            }
        }
        .task { await model.start() }
        .task { await model.watch() }
        .task { await runExpiryClock() }
        .onChange(of: model.outcome) { _, outcome in
            if outcome != nil { dismiss() }
        }
        .onDisappear {
            // Swiped away without finishing: a discovery window this opened
            // must not stay open behind the person's back.
            Task { await model.finish(.cancelled) }
        }
    }

    private func runExpiryClock() async {
        while !Task.isCancelled {
            do {
                try await Task.sleep(for: .seconds(1))
            } catch {
                return // cancelled: the sheet closed
            }
            await model.tick(now: Date())
        }
    }
}
