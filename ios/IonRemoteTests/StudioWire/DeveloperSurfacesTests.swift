import XCTest
@testable import IonRemote

/// The developer surfaces a server offers, as the welcome and the policy
/// frame carry them. Wire shape: `packages/shared/src/developer-surfaces.ts`.
final class DeveloperSurfacesTests: XCTestCase {
    private func decode<T: Decodable>(_ type: T.Type, _ json: String) throws -> T {
        try JSONDecoder().decode(type, from: Data(json.utf8))
    }

    private let welcomeHead = """
    "protocolVersion":1,"environmentId":"env","label":"Server","platform":"darwin","serverVersion":"1","engineVersion":"1",
    "capabilities":[],"principal":{"subject":"s","displayName":"d"},"scopes":[],"enterprisePolicy":null,"settingsHiddenGroups":[],"snapshot":{}
    """

    func testWelcomeDecodesEachSurfaceIndependently() throws {
        let welcome = try decode(StudioWelcome.self, """
        {\(welcomeHead),"developerSurfaces":{"sourceControl":false,"commitGraph":false,"repositoryStatus":true,"worktrees":false},"policyHash":"sha256:x"}
        """)
        XCTAssertEqual(welcome.developerSurfaces, DeveloperSurfaces(sourceControl: false, commitGraph: false, repositoryStatus: true, worktrees: false))
    }

    func testWelcomeFromAServerWithoutTheFieldOffersEverySurface() throws {
        let welcome = try decode(StudioWelcome.self, "{\(welcomeHead)}")
        XCTAssertNil(welcome.developerSurfaces)
        XCTAssertEqual(welcome.developerSurfaces ?? .allEnabled, .allEnabled)
    }

    func testWelcomeRoundTripsTheSurfaces() throws {
        let welcome = try decode(StudioWelcome.self, """
        {\(welcomeHead),"developerSurfaces":{"sourceControl":true,"commitGraph":true,"repositoryStatus":true,"worktrees":false}}
        """)
        let again = try JSONDecoder().decode(StudioWelcome.self, from: JSONEncoder().encode(welcome))
        XCTAssertEqual(again.developerSurfaces?.worktrees, false)
    }

    func testEnvironmentPolicyCarriesTheSurfaces() throws {
        let policy = try decode(StudioEnvironmentPolicy.self, """
        {"enterprisePolicy":null,"settingsHiddenGroups":[],"developerSurfaces":{"sourceControl":true,"commitGraph":false,"repositoryStatus":true,"worktrees":true},"policyHash":"sha256:y"}
        """)
        XCTAssertEqual(policy.developerSurfaces?.commitGraph, false)
        XCTAssertEqual(policy.policyHash, "sha256:y")
    }

    func testProfilingIsReadAndDefaultsOnFromAnOlderServer() throws {
        let current = try decode(DeveloperSurfaces.self, #"{"sourceControl":true,"commitGraph":true,"repositoryStatus":true,"worktrees":true,"profiling":false}"#)
        XCTAssertFalse(current.profiling)
        let older = try decode(DeveloperSurfaces.self, #"{"sourceControl":true,"commitGraph":true,"repositoryStatus":true,"worktrees":true}"#)
        XCTAssertTrue(older.profiling)
        let encoded = try JSONSerialization.jsonObject(with: JSONEncoder().encode(current)) as? [String: Bool]
        XCTAssertEqual(encoded?["profiling"], false)
    }

    func testTheGitPaneStaysWhileEitherOfItsPartsIsOffered() {
        var surfaces = DeveloperSurfaces.allEnabled
        surfaces.sourceControl = false
        XCTAssertTrue(surfaces.gitPaneOffered)
        surfaces.commitGraph = false
        XCTAssertFalse(surfaces.gitPaneOffered)
        XCTAssertTrue(surfaces.repositoryFeedOffered)
        surfaces.repositoryStatus = false
        XCTAssertFalse(surfaces.repositoryFeedOffered)
    }
}
