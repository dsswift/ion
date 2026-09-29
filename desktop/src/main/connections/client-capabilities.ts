import { WIRE_PING_CAPABILITY } from '@ion/shared/studio-wire/types'

/**
 * What this desktop advertises in every `studio_hello` (`Broker.sendHello`).
 *
 * A capability here names a reverse `studio_command` family the renderer
 * answers on the wire (`server/src/protocol/commands.ts` routes
 * `<capability>.<verb>` to a connection advertising `<capability>`). It is a
 * property of the client, not of any one Environment: the renderer answers a
 * command from whichever Environment sent it and replies to that same
 * Environment, so every connection the broker opens advertises the same set.
 *
 * - `graph`: `studio/graph/studio-graph-commands.ts` applies `graph.*`
 *   commands to the Graph View store and replies with the tool's outcome.
 * - `browser`: `main/studio-playwright/command-handler.ts` runs a browser
 *   tool body against this desktop's Playwright-driven `BrowserView` for
 *   `browser.tool`; the renderer's surface commands share the family.
 *
 * The list grows only when a renderer- or desktop-side receiver for the
 * family exists. Advertising a family nothing answers makes the server route
 * the model's tool call here and time out instead of refusing it up front.
 *
 * `wire-ping` is the one entry that names no command family: it tells the
 * server this client answers `studio_ping`, which is how the server measures
 * the round trip to it. A client that does not advertise it is never probed,
 * because a frame it cannot decode would close its connection.
 */
export const DESKTOP_CLIENT_CAPABILITIES: readonly string[] = ['graph', 'browser', WIRE_PING_CAPABILITY]
