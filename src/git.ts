import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { AardvarkClient } from "./aardvarkClient.js";
import { extractGeneratedPatch, filesTouchedByDiff, normalizeFinding } from "./normalize.js";
import type { JsonObject } from "./types.js";

type GitResult = {
  code: number;
  stdout: string;
  stderr: string;
};

export async function applyGeneratedPatch(input: {
  client: AardvarkClient;
  findingId: string;
  repoPath: string;
  autoClose?: boolean;
}): Promise<JsonObject> {
  const finding = await input.client.getFinding(input.findingId);
  const normalized = normalizeFinding(finding);
  const generatedPatch = extractGeneratedPatch(finding);
  if (!generatedPatch) {
    return failure({
      phase: "fetch",
      message: "No generated patch is available for this finding.",
      finding,
      nextStep: "Your agent can inspect the finding context from get_finding and apply the intended change manually.",
    });
  }
  const diff = generatedPatch.diff;
  if (!diff) {
    return failure({
      phase: "fetch",
      message: "Generated patch metadata exists, but the patch diff is missing.",
      finding,
      nextStep: "Your agent can inspect the finding context from get_finding and apply the intended change manually.",
    });
  }

  const repoPath = resolve(input.repoPath);
  const touchedFiles = filesTouchedByDiff(diff);
  const suggestedCommitMessage = generatedPatch.commitMessage ?? fallbackCommitMessage(normalized.title);

  const currentHead = await gitText(["rev-parse", "HEAD"], repoPath);
  await gitText(["rev-parse", "--is-inside-work-tree"], repoPath);
  const preflight = await preflightRepo(repoPath, touchedFiles);
  if (!preflight.ok) {
    return failure({
      phase: "preflight",
      message: preflight.message,
      finding,
      currentHead,
      expectedBaseCommit: generatedPatch.baseCommitSha,
      touchedFiles,
      gitStderr: preflight.details,
      suggestedCommitMessage,
    });
  }

  const tempDir = await mkdtemp(join(tmpdir(), "codex-security-cloud-patch-"));
  const patchPath = join(tempDir, "generated.patch");
  try {
    await writeFile(patchPath, diff, "utf8");

    const check = await git(["apply", "--check", patchPath], repoPath);
    if (check.code !== 0) {
      return failure({
        phase: "check",
        message: "Generated patch did not apply cleanly.",
        finding,
        currentHead,
        expectedBaseCommit: generatedPatch.baseCommitSha,
        touchedFiles,
        gitStderr: check.stderr || check.stdout,
        suggestedCommitMessage,
      });
    }

    const apply = await git(["apply", patchPath], repoPath);
    if (apply.code !== 0) {
      return failure({
        phase: "apply",
        message: "Generated patch passed check but failed during apply.",
        finding,
        currentHead,
        expectedBaseCommit: generatedPatch.baseCommitSha,
        touchedFiles,
        gitStderr: apply.stderr || apply.stdout,
        suggestedCommitMessage,
      });
    }

    const add = await git(["add", "--all", "--", ...touchedFiles], repoPath);
    if (add.code !== 0) {
      return failure({
        phase: "commit",
        message: "Generated patch was applied, but staging changed files failed.",
        finding,
        currentHead,
        expectedBaseCommit: generatedPatch.baseCommitSha,
        touchedFiles,
        gitStderr: add.stderr || add.stdout,
        suggestedCommitMessage,
      });
    }

    const commit = await git(["commit", "-m", suggestedCommitMessage], repoPath);
    if (commit.code !== 0) {
      return failure({
        phase: "commit",
        message: "Generated patch was applied, but committing failed.",
        finding,
        currentHead,
        expectedBaseCommit: generatedPatch.baseCommitSha,
        touchedFiles,
        gitStderr: commit.stderr || commit.stdout,
        suggestedCommitMessage,
      });
    }

    const commitSha = await gitText(["rev-parse", "HEAD"], repoPath);
    let close: JsonObject = { attempted: false };
    if (input.autoClose) {
      const latestFinding = await input.client.getFinding(input.findingId);
      const latest = normalizeFinding(latestFinding);
      if (typeof latest.version !== "number") {
        return failure({
          phase: "close",
          message: "Patch was committed, but the finding version was missing during auto-close.",
          finding: latestFinding,
          currentHead: commitSha,
          expectedBaseCommit: generatedPatch.baseCommitSha,
          touchedFiles,
          suggestedCommitMessage,
          commitSha,
        });
      }
      try {
        const closed = await input.client.closeFinding({
          findingId: input.findingId,
          version: latest.version,
          status: "fixed",
          reason: autoCloseReason(commitSha),
        });
        close = { attempted: true, ok: true, finding: normalizeFinding(closed) };
      } catch (error) {
        return failure({
          phase: "close",
          message: `Patch was committed, but auto-close failed. ${errorMessage(error)}`,
          finding: latestFinding,
          currentHead: commitSha,
          expectedBaseCommit: generatedPatch.baseCommitSha,
          touchedFiles,
          suggestedCommitMessage,
          commitSha,
        });
      }
    }

    return {
      ok: true,
      preApplyHead: currentHead,
      commitSha,
      changedFiles: touchedFiles,
      commitMessage: suggestedCommitMessage,
      expectedBaseCommit: generatedPatch.baseCommitSha,
      close,
    };
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

async function preflightRepo(repoPath: string, touchedFiles: string[]): Promise<{ ok: true } | { ok: false; message: string; details: string }> {
  const staged = await git(["diff", "--cached", "--quiet"], repoPath);
  if (staged.code !== 0) {
    return {
      ok: false,
      message: "Repository has staged changes. Refusing to auto-apply and commit a generated patch.",
      details: "Clear the index or ask your agent to apply the patch manually.",
    };
  }

  if (touchedFiles.length === 0) {
    return {
      ok: false,
      message: "Generated patch did not expose any touched files.",
      details: "The patch may be malformed or unsupported.",
    };
  }

  const unsafeFiles = touchedFiles.filter((file) => !isSafeRepoRelativePath(file));
  if (unsafeFiles.length > 0) {
    return {
      ok: false,
      message: "Generated patch contains unsafe file paths.",
      details: unsafeFiles.join("\n"),
    };
  }

  const status = await git(["status", "--porcelain", "--", ...touchedFiles], repoPath);
  if (status.code !== 0) {
    return {
      ok: false,
      message: "Unable to inspect touched file status.",
      details: status.stderr || status.stdout,
    };
  }
  if (status.stdout.trim()) {
    return {
      ok: false,
      message: "Generated patch touches files with existing local changes.",
      details: status.stdout.trim(),
    };
  }

  return { ok: true };
}

function isSafeRepoRelativePath(filePath: string): boolean {
  if (!filePath || filePath.startsWith("/") || filePath.includes("\0")) return false;
  return !filePath.split(/[\\/]+/).some((part) => part === "..");
}

async function gitText(args: string[], cwd: string): Promise<string> {
  const result = await git(args, cwd);
  if (result.code !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${result.stderr || result.stdout}`);
  }
  return result.stdout.trim();
}

async function git(args: string[], cwd: string): Promise<GitResult> {
  return new Promise((resolvePromise) => {
    const child = spawn("git", args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", (error) => {
      resolvePromise({ code: 1, stdout, stderr: error.message });
    });
    child.on("close", (code) => {
      resolvePromise({ code: code ?? 1, stdout, stderr });
    });
  });
}

function failure(input: {
  phase: string;
  message: string;
  finding: JsonObject;
  currentHead?: string;
  expectedBaseCommit?: string;
  touchedFiles?: string[];
  gitStderr?: string;
  suggestedCommitMessage?: string;
  commitSha?: string;
  nextStep?: string;
}): JsonObject {
  return {
    ok: false,
    phase: input.phase,
    message: input.message,
    details: {
      finding: normalizeFailureFinding(input.finding),
      currentHead: input.currentHead,
      expectedBaseCommit: input.expectedBaseCommit,
      touchedFiles: input.touchedFiles,
      gitStderr: input.gitStderr,
      suggestedCommitMessage: input.suggestedCommitMessage,
      commitSha: input.commitSha,
    },
    nextStep:
      input.nextStep ??
      "Your agent can inspect the generated diff from get_finding and apply the intended change manually.",
  };
}

function fallbackCommitMessage(title: string | undefined): string {
  return `fix: ${title ?? "apply generated security patch"}`;
}

function autoCloseReason(commitSha: string): string {
  return `An agent applied and committed the generated patch on ${formatLocalTime(new Date())}.\nCommit: ${commitSha}`;
}

function normalizeFailureFinding(finding: JsonObject): JsonObject {
  const normalized = normalizeFinding(finding);
  return {
    findingId: normalized.findingId,
    version: normalized.version,
    repoUrl: normalized.repoUrl,
    status: normalized.status,
    criticality: normalized.criticality,
    title: normalized.title,
  };
}

function formatLocalTime(date: Date): string {
  return new Intl.DateTimeFormat("en-US", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    timeZoneName: "short",
  }).format(date);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
