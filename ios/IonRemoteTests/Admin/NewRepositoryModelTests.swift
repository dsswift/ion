import XCTest
@testable import IonRemote

/// Add project's "New Repo" source: the hosting shapes decode, the calls send
/// what the server's handlers read, and create-and-clone follows the clone
/// job to the checkout.
@MainActor
final class NewRepositoryModelTests: XCTestCase {

    private let caller = FakeActionCaller(scopes: nil)
    private let events = ServerAdminEvents()
    private let serverId = "server-1"
    private var client: ServerAdminClient { ServerAdminClient(serverLabel: "Studio Mac", caller: caller) }
    private func json(_ text: String) -> JSONValue { ProjectsFixtures.json(text) }

    private static let accounts = """
    [{"host":"github.com","provider":"github","account":"example-user","credentialSource":"host","choosesVisibility":true,
      "owners":[{"id":"user:example-user","label":"example-user","kind":"user"},{"id":"org:example-org","label":"example-org","kind":"org"}]},
     {"host":"dev.azure.com","provider":"azure-devops","account":"user@example.com","credentialSource":"user","choosesVisibility":false,
      "owners":[{"id":"example-org/Platform","label":"example-org/Platform","kind":"project"}]},
     {"host":"gitlab.com","provider":"gitlab","account":"","credentialSource":"exchange-gitlab","choosesVisibility":true,"owners":[],"error":"401 Unauthorized"}]
    """
    private static let repository = """
    {"host":"github.com","provider":"github","owner":"example-org","name":"app","webUrl":"https://github.com/example-org/app",
     "sshUrl":"git@github.com:example-org/app.git","httpsUrl":"https://github.com/example-org/app.git","defaultBranch":"main"}
    """

    private func makeModel() -> NewRepositoryModel {
        NewRepositoryModel(serverId: serverId, serverLabel: "Studio Mac", client: client, baseDir: "~/source/", events: events)
    }

    private func publishJob(_ job: String) {
        events.publish(ServerAdminEvent(serverId: serverId, channel: ServerAdminEvent.projectJob, payload: json(job)))
    }

    func testHostingShapesDecode() throws {
        let accounts = try json(Self.accounts).decoded(as: [GitHostingAccount].self)
        XCTAssertEqual(accounts.map(\.provider), [.github, .azureDevops, .gitlab])
        XCTAssertEqual(accounts[0].credentialSource, .host)
        XCTAssertEqual(accounts[0].owners.map(\.kind), [.user, .org])
        XCTAssertEqual(accounts[0].title, "github.com · example-user")
        XCTAssertFalse(accounts[1].choosesVisibility)
        XCTAssertEqual(accounts[1].provider.ownerTitle, "Project")
        XCTAssertEqual(accounts[2].error, "401 Unauthorized")
        XCTAssertEqual(accounts[2].title, "gitlab.com")

        let repository = try json(Self.repository).decoded(as: GitHostingRepository.self)
        XCTAssertEqual(repository.sshUrl, "git@github.com:example-org/app.git")
        XCTAssertEqual(repository.defaultBranch, "main")
    }

    func testAccountsKeepOnlyTheOnesThatCanCreateAndNameTheRefusals() async {
        caller.answer(.gitHostingAccounts, with: .success(json(Self.accounts)))
        let model = makeModel()
        XCTAssertNil(model.accounts)

        await model.loadAccounts()

        XCTAssertEqual(model.accounts?.map(\.host), ["github.com", "dev.azure.com"])
        XCTAssertEqual(model.refusals, ["gitlab.com: 401 Unauthorized"])
        XCTAssertEqual(model.account?.host, "github.com", "the first account is chosen until another is")
        XCTAssertEqual(model.owner?.id, "user:example-user")
        model.accountId = "dev.azure.com|user@example.com"
        model.ownerId = ""
        XCTAssertEqual(model.owner?.id, "example-org/Platform")
    }

    func testAFailedListingSaysWhyAndCanBeReadAgain() async {
        caller.answer(.gitHostingAccounts, with: .failure(StudioActionFailure.failed(code: "connection_lost", message: "The connection dropped before 'gitHosting.accounts' was answered")))
        let model = makeModel()

        await model.loadAccounts()

        XCTAssertNil(model.accounts, "a list never read is not an empty list")
        XCTAssertEqual(model.loadError, "The connection dropped before 'gitHosting.accounts' was answered")
        XCTAssertNil(model.error)
        model.retryAccounts()
        XCTAssertNil(model.loadError)
        caller.answer(.gitHostingAccounts, with: .success(json(Self.accounts)))
        await model.loadAccounts()
        XCTAssertEqual(model.accounts?.map(\.host), ["github.com", "dev.azure.com"])
    }

    func testTheNameIsCheckedBeforeAnythingIsCreated() async {
        caller.answer(.gitHostingAccounts, with: .success(json(Self.accounts)))
        let model = makeModel()
        await model.loadAccounts()
        XCTAssertFalse(model.canCreate, "an empty name creates nothing")
        XCTAssertNil(model.nameProblem, "and is not yet a problem to show")
        XCTAssertEqual(model.clonePreview, "~/source/<name>")

        model.name = "my app"
        XCTAssertNotNil(model.nameProblem)
        XCTAssertFalse(model.canCreate)
        model.name = "app.git"
        XCTAssertNotNil(model.nameProblem)
        model.name = " app "
        XCTAssertNil(model.nameProblem)
        XCTAssertTrue(model.canCreate)
        XCTAssertEqual(model.clonePreview, "~/source/app")
    }

    func testCreateAndCloneSendsBothCallsAndReturnsTheCheckoutWhenTheJobIsDone() async {
        caller.answer(.gitHostingAccounts, with: .success(json(Self.accounts)))
        caller.answer(.gitHostingCreateRepository, with: .success(json(Self.repository)))
        caller.answer(.environmentProjectsClone, with: .success(json(#"{"jobId":"job-1","dir":"/Users/dev/source/app"}"#)))
        let model = makeModel()
        await model.loadAccounts()
        model.ownerId = "org:example-org"
        model.name = "app"
        model.details = "An app"

        async let directory = model.createAndClone()
        // The model subscribes before its first call; these wait in its stream until it reads them.
        while caller.calls.count < 3 { await Task.yield() }
        publishJob(ProjectsFixtures.job(id: "someone-elses", dir: "/Users/dev/source/other", phase: "failed", error: "not ours"))
        publishJob(ProjectsFixtures.job(id: "job-1", dir: "/Users/dev/source/app", phase: "running", percent: 40))
        publishJob(ProjectsFixtures.job(id: "job-1", dir: "/Users/dev/source/app", phase: "done", percent: 100))
        let result = await directory

        XCTAssertEqual(result, "/Users/dev/source/app")
        XCTAssertNil(model.error)
        XCTAssertFalse(model.busy)
        XCTAssertEqual(Array(caller.calls.dropFirst()), [
            .init(action: "gitHosting.createRepository", args: [.object([
                "host": .string("github.com"), "owner": .string("org:example-org"), "name": .string("app"),
                "visibility": .string("private"), "description": .string("An app")
            ])]),
            .init(action: "environment.projects.clone", args: [.object([
                "remote": .object(["sshUrl": .string("git@github.com:example-org/app.git"), "httpsUrl": .string("https://github.com/example-org/app.git")]),
                "parentDir": .string("~/source"), "name": .string("app"), "trust": .bool(true)
            ])])
        ])
    }

    func testAFailedCloneIsReportedInTheServersWords() async {
        caller.answer(.gitHostingAccounts, with: .success(json(Self.accounts)))
        caller.answer(.gitHostingCreateRepository, with: .success(json(Self.repository)))
        caller.answer(.environmentProjectsClone, with: .success(json(#"{"jobId":"job-1","dir":"/Users/dev/source/app"}"#)))
        let model = makeModel()
        await model.loadAccounts()
        model.name = "app"

        async let directory = model.createAndClone()
        while caller.calls.count < 3 { await Task.yield() }
        publishJob(ProjectsFixtures.job(id: "job-1", dir: "/Users/dev/source/app", phase: "failed", error: "Permission denied (publickey)."))
        let result = await directory

        XCTAssertNil(result)
        XCTAssertEqual(model.error, "Permission denied (publickey).")
    }

    func testARefusedCreateClonesNothing() async {
        caller.answer(.gitHostingAccounts, with: .success(json(Self.accounts)))
        caller.answer(.gitHostingCreateRepository, with: .failure(StudioActionFailure.failed(code: "create_failed", message: "name already exists on this account")))
        let model = makeModel()
        await model.loadAccounts()
        model.name = "app"

        let result = await model.createAndClone()

        XCTAssertNil(result)
        XCTAssertEqual(model.error, "name already exists on this account")
        XCTAssertFalse(caller.calls.contains { $0.action == "environment.projects.clone" })
    }
}
