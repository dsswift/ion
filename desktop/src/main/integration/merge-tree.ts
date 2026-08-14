/**
 * Stable wrapper around `git merge-tree --write-tree`.
 *
 * Git documents human `CONFLICT (...)` messages as non-stable. This parser reads
 * the machine conflicted-file section selected by `--name-only -z`, and treats
 * process exit status as the authority for clean vs conflicted results.
 */
import { execFile as execFileCb } from "child_process";
import { promisify } from "util";
import { withGitSlot } from "../git-runner";
import type { MergePrediction } from "../../shared/types-worktree-overlap";

const execFile = promisify(execFileCb);

export interface MergeTreeResult {
  prediction: MergePrediction;
  tree?: string;
  conflictPaths: string[];
  error?: string;
}

export async function mergeTree(
  directory: string,
  left: string,
  right: string,
): Promise<MergeTreeResult> {
  try {
    const { stdout } = await withGitSlot(() =>
      execFile(
        "git",
        ["merge-tree", "--write-tree", "--name-only", "-z", left, right],
        {
          cwd: directory,
          maxBuffer: 10 * 1024 * 1024,
        },
      ),
    );
    return {
      prediction: "clean",
      // Git guarantees top-level tree OID first. Clean merges can append
      // informational NUL records for renames and binary paths.
      tree: firstRecord(stdout),
      conflictPaths: [],
    };
  } catch (error) {
    const err = error as {
      code?: number;
      stdout?: string;
      stderr?: string;
      message?: string;
    };
    if (err.code !== 1) {
      return {
        prediction: "unavailable",
        conflictPaths: [],
        error: err.stderr?.trim() || err.message || String(error),
      };
    }
    const records = (err.stdout ?? "").split("\0");
    // Non-stdin `--name-only -z` output is tree, path records, then an empty
    // delimiter before informational records. Only the path section is stable.
    return {
      prediction: "conflict",
      tree: records[0],
      conflictPaths: records
        .slice(
          1,
          records.indexOf("") < 0 ? records.length : records.indexOf(""),
        )
        .filter(Boolean),
    };
  }
}

function firstRecord(output: string): string | undefined {
  return splitNul(output)[0];
}

function splitNul(output: string): string[] {
  return output
    .split("\0")
    .map((part) => part.replace(/^\n+|\n+$/g, ""))
    .filter(Boolean);
}
