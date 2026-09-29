/**
 * server-questions-wiring-browser-stub — the Studio renderer's build-time
 * replacement for `server/src/questions/questions-wiring.ts`.
 *
 * The real file holds the process-wide `QuestionsCoordinator` singleton and
 * wires it to the prompt pipeline and broadcast. It is reachable from the
 * renderer transitively through `store/questions-read.ts` and
 * `store/restored-denied.ts` (`sessionStore.ts`'s reactive selectors), and
 * pulls in `questions-coordinator.ts`'s `import { randomUUID } from 'crypto'`
 * — no browser equivalent for the Node `crypto` module import form. Per the
 * module's own docs, "QuestionsCoordinator — the ONE owner of guided-
 * questions workflow state. Lives in desktop main." The renderer only ever
 * sees questions state via `desktop_questions_state`/revisioned patches over
 * the studio-wire, never by holding its own coordinator.
 *
 * `questionsSnapshot()` returns an empty snapshot so read-side helpers
 * degrade gracefully instead of throwing; every mutating/dispatching
 * function is an inert no-op. Wired in via `electron.vite.config.ts`'s
 * renderer plugin, keyed on questions-wiring.ts's resolved absolute path so
 * every relative import of it resolves here.
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function questionsCoordinator(): any {
  return null;
}
export function isQuestionsResumePrompt(_reqId: string): boolean {
  return false;
}
export function notifyQuestionsPromptDispatched(_tabId: string, _reqId: string): void {}
export function registerQuestionsPromptSink(_sink: (prompt: unknown) => Promise<void> | void): void {}
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function wireQuestions(_bridge: unknown): any {
  return null;
}
export function applyQuestionsPatch(_patch: unknown): { actionId: string; accepted: boolean; error?: string } {
  return { actionId: "", accepted: false, error: "questions coordinator is server-owned; not available in the Studio renderer" };
}
export function applyQuestionsAction(_action: unknown): { actionId: string; accepted: boolean; error?: string } {
  return { actionId: "", accepted: false, error: "questions coordinator is server-owned; not available in the Studio renderer" };
}
export function rehydrateQuestionsFromRows(_tabId: string, _rows: unknown[]): boolean {
  return false;
}
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function questionsSnapshot(): { workflows: any[]; lastActionResult: undefined } {
  return { workflows: [], lastActionResult: undefined };
}
export function handleQuestionsRemoteCommand(_cmd: unknown): boolean {
  return false;
}
