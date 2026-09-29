import Foundation
import XCTest
@testable import IonRemote

/// Server answers for the integrations pages, copied from the shapes the
/// server's handlers return (`server/src/protocol/auth-flow-actions.ts`,
/// `misc-actions.ts`, `server/src/automation/`).
enum IntegrationsFixtures {

    static func json(_ text: String) -> JSONValue {
        do {
            return try JSONDecoder().decode(JSONValue.self, from: Data(text.utf8))
        } catch {
            XCTFail("fixture is not JSON: \(error)")
            return .null
        }
    }

    static let mcpServers = #"""
    [
      {"name":"linear","transport":"http","url":"https://mcp.linear.app/mcp","connected":true,"authenticated":true,"toolCount":23},
      {"name":"files","transport":"stdio","command":"npx","connected":false,"authenticated":false,"lastError":"spawn npx ENOENT"}
    ]
    """#

    static let identity = #"{"user":"user@example.com","username":"user@example.com","displayName":"Example User","oid":"00000000-0000-0000-0000-000000000001","issuer":"https://login.example.org/v2.0"}"#

    static let userRule = #"""
    {"id":"user.a","name":"My rule","enabled":true,"trigger":{"kind":"event","event":"worktree:pin-advanced"},
     "condition":{"all":[{"path":"payload.stage","operator":"equals","value":"bug"}]},
     "steps":[{"kind":"worktree:set-stage","payload":{"stage":"test"}},
              {"type":"branch","condition":{"any":[{"path":"payload.branchName","operator":"exists"}]},"then":[{"kind":"record"}]}],
     "createdAt":"2026-01-01T00:00:00.000Z","updatedAt":"2026-01-01T00:00:00.000Z"}
    """#

    static let listing = #"""
    {"locked":false,"entries":[
      {"definition":\#(userRule),"source":"user","effective":true},
      {"definition":{"id":"p1","name":"Project rule","enabled":true,"trigger":{"kind":"event","event":"worktree:created"},"steps":[{"kind":"record"}],"createdAt":"2026-01-01T00:00:00.000Z","updatedAt":"2026-01-01T00:00:00.000Z"},"source":"project","effective":true,"locallyDisabled":true},
      {"definition":{"id":"b1","name":"Built-in rule","enabled":true,"trigger":{"kind":"event","event":"worktree:landed"},"actions":[{"kind":"record"}],"createdAt":"2026-01-01T00:00:00.000Z","updatedAt":"2026-01-01T00:00:00.000Z"},"source":"built-in","effective":false,"overriddenBy":"enterprise"}
    ]}
    """#

    static let history = #"""
    [
      {"id":"h1","automationId":"user.a","eventType":"worktree:pin-advanced","causation":{"rootId":"r","chain":["user.a"],"depth":1},
       "startedAt":"2026-01-01T00:00:00.000Z","finishedAt":"2026-01-01T00:00:01.000Z","outcome":"failed","error":"stage refused",
       "trace":{"trigger":{"eventType":"worktree:pin-advanced"},
                "condition":{"type":"group","all":[{"type":"condition","path":"payload.stage","operator":"equals","expected":"bug","actual":"bug","matched":true}],"any":[],"matched":true},
                "causation":{"decision":"continued","input":{"rootId":"r","chain":[],"depth":0},"output":{"rootId":"r","chain":["user.a"],"depth":1}},
                "steps":[{"type":"action","kind":"worktree:set-stage","outcome":"failed","error":"stage refused"},
                         {"type":"branch","condition":{"type":"group","all":[],"any":[{"type":"condition","path":"payload.branchName","operator":"exists","matched":false}],"matched":false},"selected":"else","steps":[]}]}},
      {"id":"h0","automationId":"gone","eventType":"worktree:created","causation":{"rootId":"r","chain":[],"depth":0},
       "startedAt":"2025-12-31T00:00:00.000Z","finishedAt":"2025-12-31T00:00:00.000Z","outcome":"succeeded"}
    ]
    """#

    /// Walks up from this file to a path in the repository.
    static func repoFile(_ relative: String, file: StaticString = #filePath) throws -> URL {
        var dir = URL(fileURLWithPath: "\(file)").deletingLastPathComponent()
        for _ in 0..<8 {
            let candidate = dir.appendingPathComponent(relative)
            if FileManager.default.fileExists(atPath: candidate.path) { return candidate }
            dir = dir.deletingLastPathComponent()
        }
        throw XCTSkip("\(relative) not found above \(file)")
    }
}
