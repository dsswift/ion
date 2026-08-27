import type { AutomationAction } from "../../../shared/types-automation";
import type { StoreGet, StoreSet, State } from "../session-store-types";
import { rInfo } from "../../rendererLogger";

/** Executes finite main-authorized commands in owner session store. */
export function createAutomationSlice(
  _set: StoreSet,
  get: StoreGet,
): Partial<State> {
  return {
    runAutomationCommand: async (
      action: AutomationAction,
    ): Promise<string | void> => {
      const payload = action.payload ?? {};
      switch (action.kind) {
        case "conversation":
        case "conversation:run":
          return createConversation(get, payload, false);
        case "conversation:slash":
          return createConversation(get, payload, true);
        case "tab:set-color":
          return setTabColor(get, payload);
        case "tab:set-icon":
          return setTabIcon(get, payload);
        case "tab:set-group":
          return setTabGroup(get, payload);
        default:
          throw new Error(`Unsupported automation action: ${action.kind}`);
      }
    },
  };
}

async function createConversation(
  get: StoreGet,
  payload: Record<string, unknown>,
  slash: boolean,
): Promise<string> {
  const directory = stringValue(payload.directory);
  if (!directory)
    throw new Error("Automation conversation action requires directory");
  const tabId = await get().createTabInDirectory(
    directory,
    booleanValue(payload.useWorktree),
    true,
    stringValue(payload.pinToGroupId),
  );
  applyTabDecoration(get, tabId, payload);
  const prompt = slash ? slashPrompt(payload) : stringValue(payload.prompt);
  if (prompt) {
    const options = automationOptions(payload);
    if (options) get().submit(tabId, prompt, options);
    else get().submit(tabId, prompt);
  }
  rInfo("automation.command", "owner conversation command completed", {
    tab_id: tabId,
    directory,
    kind: slash ? "conversation:slash" : "conversation:run",
    submitted: !!prompt,
  });
  return tabId;
}

function automationOptions(
  payload: Record<string, unknown>,
):
  | {
      automationCausation: import("../../../shared/types-automation").AutomationCausation;
    }
  | undefined {
  const causation = payload.__automationCausation;
  return causation && typeof causation === "object"
    ? {
        automationCausation:
          causation as import("../../../shared/types-automation").AutomationCausation,
      }
    : undefined;
}
function setTabColor(get: StoreGet, payload: Record<string, unknown>): void {
  get().setTabPillColor(
    requiredTabId(payload),
    nullableString(payload, "color"),
  );
}
function setTabIcon(get: StoreGet, payload: Record<string, unknown>): void {
  get().setTabPillIcon(requiredTabId(payload), nullableString(payload, "icon"));
}
function setTabGroup(get: StoreGet, payload: Record<string, unknown>): void {
  const tabId = requiredTabId(payload);
  const groupId = nullableString(payload, "groupId");
  if (booleanValue(payload.groupPinned))
    get().moveTabToGroupAndPin(tabId, groupId ?? "");
  else get().setTabGroupId(tabId, groupId);
}
function applyTabDecoration(
  get: StoreGet,
  tabId: string,
  payload: Record<string, unknown>,
): void {
  const groupId = optionalNullableString(payload, "groupId");
  if (groupId) {
    if (booleanValue(payload.groupPinned))
      get().moveTabToGroupAndPin(tabId, groupId);
    else get().moveTabToGroup(tabId, groupId);
  }
  const pillColor = optionalNullableString(payload, "pillColor");
  if (pillColor !== undefined) get().setTabPillColor(tabId, pillColor);
  const pillIcon = optionalNullableString(payload, "pillIcon");
  if (pillIcon !== undefined) get().setTabPillIcon(tabId, pillIcon);
}
function slashPrompt(payload: Record<string, unknown>): string | undefined {
  const command = stringValue(payload.command);
  if (!command) throw new Error("conversation:slash requires command");
  const args = stringValue(payload.args);
  return `/${command}${args ? ` ${args}` : ""}`;
}
function requiredTabId(payload: Record<string, unknown>): string {
  const tabId = stringValue(payload.tabId);
  if (!tabId) throw new Error("Automation tab action requires tabId");
  return tabId;
}
function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}
function booleanValue(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}
function nullableString(
  payload: Record<string, unknown>,
  field: string,
): string | null {
  const value = payload[field];
  if (value === null || typeof value === "string") return value;
  throw new Error(`Automation action requires ${field} as string or null`);
}
function optionalNullableString(
  payload: Record<string, unknown>,
  field: string,
): string | null | undefined {
  const value = payload[field];
  return value === undefined ? undefined : nullableString(payload, field);
}
