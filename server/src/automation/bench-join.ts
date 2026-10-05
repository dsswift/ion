import { debug, log } from "../logger";
import { addMember, assembleWorkspace, findMemberWorkspace, updateMember } from "../integration/bench-ops";
import { lookupWorktreeRegistration } from "../worktree/registry-helpers";
import type { AutomationActionContext } from "@ion/shared/types-automation";

const TAG = "automation.bench_join";

/**
 * The `bench:join` action: put the event's worktree on its source branch's
 * integration bench at its current commit. A worktree that is not a member
 * is enrolled and the bench assembled; one that already is has its pin
 * updated, which assembles too. An event with no worktree is skipped, like
 * every worktree action.
 */
export async function joinBench(context: AutomationActionContext): Promise<void> {
  const worktreePath = context.event.payload?.worktreePath;
  if (typeof worktreePath !== "string" || !worktreePath) {
    debug(TAG, "bench:join skipped: no worktreePath in event payload", { automation_id: context.automation.id });
    return;
  }
  const registration = lookupWorktreeRegistration(worktreePath);
  if (!registration?.sourceBranch) {
    throw new Error(`bench:join: ${worktreePath} is not a worktree with a source branch`);
  }
  const { repoPath, sourceBranch, branchName } = registration;
  if (findMemberWorkspace(repoPath, sourceBranch, worktreePath)) {
    const updated = await updateMember(repoPath, sourceBranch, worktreePath);
    log(TAG, "bench member updated by automation", { automation_id: context.automation.id, worktree_path: worktreePath, source_branch: sourceBranch, ok: updated.ok });
    if (!updated.ok) throw new Error(updated.error ?? "The bench could not take the worktree's update");
    return;
  }
  const added = await addMember(repoPath, sourceBranch, worktreePath, branchName);
  if (!added.ok) throw new Error(added.error ?? "The worktree could not join the bench");
  const assembled = await assembleWorkspace(repoPath, sourceBranch);
  log(TAG, "worktree joined its bench by automation", { automation_id: context.automation.id, worktree_path: worktreePath, source_branch: sourceBranch, assembled: assembled.ok });
  if (!assembled.ok) throw new Error(assembled.error ?? "The bench did not assemble after the worktree joined");
}
