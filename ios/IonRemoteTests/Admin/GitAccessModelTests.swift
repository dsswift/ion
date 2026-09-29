import XCTest
@testable import IonRemote

/// The Git access screen models: loading, removal, adding a credential,
/// sign-in refusals, access tests, and the commit author.
@MainActor
final class GitAccessModelTests: XCTestCase {

    private let caller = FakeActionCaller(scopes: nil)
    private var client: ServerAdminClient { ServerAdminClient(serverLabel: "Studio Mac", caller: caller) }
    private func json(_ text: String) -> JSONValue { ProjectsFixtures.json(text) }

    func testLoadReadsCredentialsKeysAndAuthor() async {
        caller.answer(.gitIdentityList, with: .success(json(GitAccessFixtures.identities)))
        caller.answer(.environmentGitHostKeys, with: .success(json(GitAccessFixtures.hostKeys)))
        caller.answer(.environmentGitAuthorGet, with: .success(json(GitAccessFixtures.author)))
        let model = GitAccessModel(serverId: "s", serverLabel: "Studio Mac", client: client)
        XCTAssertNil(model.identities)

        await model.load()

        XCTAssertEqual(model.identities?.count, 2)
        XCTAssertEqual(model.author?.name, "A User")
        XCTAssertEqual(model.noCredentialExplanation, "Git on Studio Mac uses the host's own ssh setup: id_ed25519.pub (ssh-ed25519, user@example.com).")
    }

    func testADeniedListIsShownAndTheAuthorStillLoads() async {
        let denied = FakeActionCaller(scopes: ["conversations:read"])
        denied.answer(.environmentGitAuthorGet, with: .success(json(GitAccessFixtures.author)))
        denied.answer(.environmentGitHostKeys, with: .success(.array([])))
        let model = GitAccessModel(serverId: "s", serverLabel: "Studio Mac", client: ServerAdminClient(serverLabel: "Studio Mac", caller: denied))

        await model.load()

        XCTAssertNil(model.identities)
        XCTAssertNotNil(model.identitiesError)
        XCTAssertFalse(denied.calls.contains { $0.action == "gitIdentity.list" }, "a denied action is never sent")
        XCTAssertEqual(model.author?.email, "user@example.com")
        XCTAssertEqual(model.noCredentialExplanation, "Studio Mac has no keys in ~/.ssh, so private repositories cannot be reached until you add a credential.")
    }

    func testRemovingACredentialRelists() async throws {
        caller.answer(.gitIdentityList, with: .success(json(GitAccessFixtures.identities)))
        let model = GitAccessModel(serverId: "s", serverLabel: "Studio Mac", client: client)
        await model.loadIdentities()
        let github = try XCTUnwrap(model.identities?.first)
        caller.answer(.gitIdentityList, with: .success(.array([])))

        await model.remove(github)

        XCTAssertEqual(model.identities, [])
        XCTAssertNil(model.operationError)
        XCTAssertNil(model.removingHost)
    }

    func testMintingKeepsTheSheetOpenOnThePublicKeyAndATokenCloses() async {
        caller.answer(.gitIdentityMintSshKey, with: .success(json(GitAccessFixtures.publicKey)))
        let model = AddGitCredentialModel(serverId: "s", serverLabel: "Studio Mac", client: client)
        XCTAssertTrue(model.canSubmit)

        let closesAfterMint = await model.submit()

        XCTAssertFalse(closesAfterMint)
        XCTAssertEqual(model.minted, .init(host: "github.com", publicKey: "ssh-ed25519 AAAAC3Nza ion"))

        let tokenModel = AddGitCredentialModel(serverId: "s", serverLabel: "Studio Mac", client: client)
        tokenModel.mode = .token
        XCTAssertFalse(tokenModel.canSubmit, "a token is required")
        tokenModel.token = "T"
        let closesAfterToken = await tokenModel.submit()
        XCTAssertTrue(closesAfterToken)
        XCTAssertEqual(tokenModel.token, "", "the secret does not linger in the form")
    }

    func testSignInOpensTheReturnedPageAndARefusalSaysWhatToDo() async {
        caller.answer(.gitIdentityAuthorize, with: .success(json(GitAccessFixtures.authorize)))
        let model = AddGitCredentialModel(serverId: "s", serverLabel: "Studio Mac", client: client)
        let url = await model.authorize()
        XCTAssertEqual(url?.host, "github.com")

        caller.answer(.gitIdentityAuthorize, with: .failure(StudioActionFailure.failed(code: "not_configured", message: "this server has no git.publicOrigin configured")))
        let refused = await model.authorize()
        XCTAssertNil(refused)
        XCTAssertEqual(model.error, "Studio Mac has no public address for git sign-in. An operator must set git.publicOrigin in its server.json. You can mint or paste a key instead.")
    }

    func testAccessTestsKeepOneResultPerURLNewestFirst() async {
        caller.answer(.environmentProjectsList, with: .success(ProjectsFixtures.projects(ProjectsFixtures.missingProject, ProjectsFixtures.appProject)))
        let model = GitTestAccessModel(serverId: "s", client: client)
        await model.loadSuggestion()
        XCTAssertEqual(model.url, "git@github.com:example/app.git", "defaults to the first project origin")

        caller.answer(.environmentGitTest, with: .success(json(GitAccessFixtures.failingTest)))
        await model.test()
        caller.answer(.environmentGitTest, with: .success(json(GitAccessFixtures.passingTest)))
        await model.test()

        XCTAssertEqual(model.results.count, 1)
        XCTAssertEqual(model.results.first?.ok, true)
    }

    func testCommitAuthorCopiesFromAnotherServerAndRefusesAnEmptyOne() async {
        let other = FakeActionCaller(scopes: nil)
        other.answer(.environmentGitAuthorGet, with: .success(json(GitAccessFixtures.author)))
        let laptop = PairedServerSource(serverId: "laptop", label: "Laptop", client: ServerAdminClient(serverLabel: "Laptop", caller: other))
        let model = CommitAuthorModel(serverId: "s", current: nil)
        XCTAssertFalse(model.canSave)

        await model.copy(from: laptop)
        XCTAssertEqual(model.draft, EnvironmentGitAuthor(name: "A User", email: "user@example.com"))
        XCTAssertTrue(model.canSave)

        other.answer(.environmentGitAuthorGet, with: .success(json(GitAccessFixtures.emptyAuthor)))
        await model.copy(from: laptop)
        XCTAssertEqual(model.error, "Laptop has no global git name and email set.")
        XCTAssertEqual(model.name, "A User", "a failed copy leaves the fields alone")
    }

    func testSavingTheAuthorUpdatesTheModel() async {
        caller.answer(.environmentGitAuthorSet, with: .success(json(GitAccessFixtures.author)))
        let model = GitAccessModel(serverId: "s", serverLabel: "Studio Mac", client: client)

        let saved = await model.saveAuthor(EnvironmentGitAuthor(name: "A User", email: "user@example.com"))

        XCTAssertTrue(saved)
        XCTAssertEqual(model.author?.name, "A User")
    }
}
