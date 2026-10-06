import SwiftUI

/// The "New Repo" source of Add project: the account, where under it, the
/// name, and who can see it.
struct NewRepositorySource: View {
    @Bindable var model: NewRepositoryModel

    var body: some View {
        if let accounts = model.accounts {
            if let account = model.account, let owner = model.owner {
                form(accounts: accounts, account: account, owner: owner)
            } else {
                Section {
                    Text("\(model.serverLabel) is not signed in to GitHub, GitLab or Azure DevOps with a token. Add one under Git Access, or sign in with gh, glab or az on the server.")
                        .foregroundStyle(.secondary)
                } footer: {
                    refusalsFooter
                }
            }
        } else if let loadError = model.loadError {
            Section {
                AdminErrorRow(message: loadError)
                Button("Try Again") { model.retryAccounts() }
            } footer: {
                Text("\(model.serverLabel) could not be asked for your git host accounts.")
            }
        } else {
            Section { AdminLoadingRow(text: "Looking for your git host accounts…") }
                .task { await model.loadAccounts() }
        }
    }

    @ViewBuilder private func form(accounts: [GitHostingAccount], account: GitHostingAccount, owner: GitHostingOwner) -> some View {
        Section {
            Picker("Account", selection: Binding(get: { account.id }, set: { model.accountId = $0; model.ownerId = "" })) {
                ForEach(accounts) { Text($0.title).tag($0.id) }
            }
            Picker(account.provider.ownerTitle, selection: Binding(get: { owner.id }, set: { model.ownerId = $0 })) {
                ForEach(account.owners) { Text($0.label).tag($0.id) }
            }
        } footer: {
            refusalsFooter
        }
        .disabled(model.busy)
        Section {
            TextField("my-project", text: $model.name)
                .font(.body.monospaced())
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
            TextField("Description (optional)", text: $model.details)
            if account.choosesVisibility {
                Toggle("Private", isOn: $model.isPrivate)
            }
        } header: {
            Text("Repository")
        } footer: {
            if let problem = model.nameProblem { Text(problem) }
        }
        .disabled(model.busy)
        Section {
            if let progress = model.progress {
                AdminLoadingRow(text: progress)
            } else {
                LabeledContent("Clones Into") {
                    Text(model.clonePreview).font(.callout.monospaced()).multilineTextAlignment(.trailing)
                }
            }
        } footer: {
            Text("The repository starts with a README, so a conversation can open in it right away.")
        }
    }

    @ViewBuilder private var refusalsFooter: some View {
        if !model.refusals.isEmpty {
            Text("Refused: \(model.refusals.joined(separator: "; "))")
        }
    }
}
