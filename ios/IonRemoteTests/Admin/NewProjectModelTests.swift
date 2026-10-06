import XCTest
@testable import IonRemote

/// The New Project card: one `gitHosting.startProject` call carries the
/// repository, prompt, model, and harness; the card follows the server's
/// `create` job to the conversation it opened; a retry for the same
/// repository keeps its request id so the server resumes.
@MainActor
final class NewProjectModelTests: XCTestCase {

    private let caller = FakeActionCaller(scopes: nil)
    private let events = ServerAdminEvents()
    private let serverId = "server-1"
    private var client: ServerAdminClient { ServerAdminClient(serverLabel: "Studio Mac", caller: caller) }
    private func json(_ text: String) -> JSONValue { ProjectsFixtures.json(text) }

    private static let accounts = """
    [{"host":"github.com","provider":"github","account":"example-user","credentialSource":"host","choosesVisibility":true,
      "owners":[{"id":"user:example-user","label":"example-user","kind":"user"}]}]
    """

    private func makeModel() async -> NewProjectModel {
        caller.answer(.gitHostingAccounts, with: .success(json(Self.accounts)))
        let model = NewProjectModel(serverId: serverId, serverLabel: "Studio Mac", client: client, baseDir: "~/source/", events: events)
        await model.repository.loadAccounts()
        model.repository.name = "idea"
        return model
    }

    private func createJob(id: String = "job-1", phase: String, stage: String = "cloning: receiving objects", percent: Int? = nil, tabId: String? = nil, error: String? = nil) -> String {
        var fields = ["\"id\":\"\(id)\"", "\"kind\":\"create\"", "\"dir\":\"/Users/dev/source/idea\"", "\"phase\":\"\(phase)\"",
                      "\"stage\":\"\(stage)\"", "\"startedAt\":1726000000000"]
        if let percent { fields.append("\"percent\":\(percent)") }
        if let tabId { fields.append("\"tabId\":\"\(tabId)\"") }
        if let error { fields.append("\"error\":\"\(error)\"") }
        return "{\(fields.joined(separator: ","))}"
    }

    private func publishJob(_ job: String) {
        events.publish(ServerAdminEvent(serverId: serverId, channel: ServerAdminEvent.projectJob, payload: json(job)))
    }

    private func startCalls() -> [[String: JSONValue]] {
        caller.calls.filter { $0.action == "gitHosting.startProject" }.compactMap { call in
            if case .object(let fields) = call.args.first { return fields }
            return nil
        }
    }

    func testStartSendsOneRequestAndReturnsTheConversationTheJobOpened() async {
        caller.answer(.gitHostingStartProject, with: .success(json(#"{"jobId":"job-1","dir":"/Users/dev/source/idea"}"#)))
        let model = await makeModel()
        model.prompt = "  Build a todo app \n"
        model.pickModel("claude-fable-5-1", providerId: "anthropic")
        model.profileId = "dev"

        async let opened = model.start()
        while startCalls().isEmpty { await Task.yield() }
        publishJob(createJob(phase: "running", percent: 40))
        publishJob(createJob(id: "someone-elses", phase: "failed", error: "not ours"))
        publishJob(createJob(phase: "done", stage: "sending prompt", tabId: "tab-1"))
        let tabId = await opened

        XCTAssertEqual(tabId, "tab-1")
        XCTAssertNil(model.error)
        XCTAssertFalse(model.busy)
        let fields = startCalls()[0]
        XCTAssertEqual(fields["host"], .string("github.com"))
        XCTAssertEqual(fields["owner"], .string("user:example-user"))
        XCTAssertEqual(fields["name"], .string("idea"))
        XCTAssertEqual(fields["visibility"], .string("private"))
        XCTAssertEqual(fields["parentDir"], .string("~/source"))
        XCTAssertEqual(fields["prompt"], .string("Build a todo app"))
        XCTAssertEqual(fields["model"], .string("claude-fable-5-1"))
        XCTAssertEqual(fields["providerId"], .string("anthropic"))
        XCTAssertEqual(fields["profileId"], .string("dev"))
        XCTAssertNotNil(fields["requestId"])
    }

    func testARetryForTheSameRepositoryResumesAndAnotherRepositoryStartsOver() async {
        caller.answer(.gitHostingStartProject, with: .success(json(#"{"jobId":"job-1","dir":"/Users/dev/source/idea"}"#)))
        let model = await makeModel()

        async let first = model.start()
        while startCalls().count < 1 { await Task.yield() }
        publishJob(createJob(phase: "failed", error: "git clone exited 128"))
        let firstResult = await first
        XCTAssertNil(firstResult)
        XCTAssertEqual(model.error, "git clone exited 128")
        XCTAssertNil(model.modelId, "no pick keeps the server's default")

        async let second = model.start()
        while startCalls().count < 2 { await Task.yield() }
        publishJob(createJob(phase: "done", tabId: "tab-1"))
        _ = await second

        model.repository.name = "other-idea"
        async let third = model.start()
        while startCalls().count < 3 { await Task.yield() }
        publishJob(createJob(phase: "done", tabId: "tab-2"))
        _ = await third

        let ids = startCalls().map { $0["requestId"] }
        XCTAssertEqual(ids[0], ids[1], "a retry of the same repository resumes its request")
        XCTAssertNotEqual(ids[1], ids[2], "another repository is a new request")
        XCTAssertNil(startCalls()[0]["model"])
    }

    func testTheDefaultModelFollowsTheHarnessAndThePickerCanReturnToIt() async {
        caller.answer(.settingsLoad, with: .success(.object(["preferredModel": .string("plain-model"), "engineDefaultModel": .string("engine-model")])))
        let model = await makeModel()
        await model.loadDefaults()

        XCTAssertEqual(model.effectiveModelId, "plain-model")
        model.profileId = "dev"
        XCTAssertEqual(model.effectiveModelId, "engine-model")
        model.pickModel("claude-fable-5-1", providerId: "anthropic")
        XCTAssertEqual(model.effectiveModelId, "claude-fable-5-1")
        model.pickModel("", providerId: "")
        XCTAssertNil(model.modelId)
        XCTAssertNil(model.providerId)
        XCTAssertEqual(model.effectiveModelId, "engine-model")
    }
}
