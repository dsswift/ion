import type { ToolDef } from "./types";

export type ToolSnapshot = { revision: number; tools: ToolDef[] };

export function createToolRegistry(
  request: (method: string, params: unknown) => Promise<unknown>,
  tools = new Map<string, ToolDef>(),
) {
  let revision = 0;
  let initialized = false;
  let transaction: Map<string, ToolDef> | null = null;
  let transactionRevision: number | null = null;
  const current = () => transaction ?? tools;
  const mutate = () => {
    revision++;
    return revision;
  };
  const register = (tool: ToolDef) => {
    current().set(tool.name, tool);
    mutate();
  };
  const deregister = (name: string) => {
    const removed = current().delete(name);
    if (removed) mutate();
    return removed;
  };
  const snapshot = (): ToolSnapshot => ({
    revision,
    tools: [...tools.values()],
  });
  const sync = async (): Promise<number> => {
    if (!initialized) return revision;
    const result = (await request(
      "ext/tool_registry_snapshot",
      snapshot(),
    )) as { revision: number };
    return result.revision;
  };
  const begin = () => {
    transaction = new Map(tools);
    transactionRevision = revision;
  };
  const commit = async () => {
    if (transaction === null) return;
    tools.clear();
    for (const [k, v] of transaction) tools.set(k, v);
    transaction = null;
    transactionRevision = null;
    await sync();
  };
  const rollback = () => {
    transaction = null;
    if (transactionRevision !== null) revision = transactionRevision;
    transactionRevision = null;
  };
  return {
    tools,
    register,
    deregister,
    snapshot,
    sync,
    setInitialized: () => {
      initialized = true;
    },
    begin,
    commit,
    rollback,
  };
}
