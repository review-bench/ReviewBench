/**
 * Git operations for extraction and classification.
 *
 * Provides both bare clones (for diff analysis) and working-tree
 * checkouts (for tools that need file access).
 */

import { execFileSync } from "child_process";
import { existsSync, mkdirSync, rmSync } from "fs";
import { join } from "path";

export interface RegionCheck {
  unchanged: boolean;
  newStartLine: number | null;
  newEndLine: number | null;
}

interface GitOpts {
  cwd?: string;
  timeout?: number;
  maxBuffer?: number;
  offline?: boolean;
}

// Run git with an argv array (never a shell), so commit/ref/path values taken
// from untrusted PRs can't be interpreted as shell syntax. Returns stdout.
//
// GIT_LFS_SKIP_SMUDGE=1: corpus repos may use git-LFS, but the mirrors carry
// the LFS *pointer* files, not the large objects — so a smudge on checkout
// would fail and abort the checkout. Skip it: the pointer is all scoring needs
// (the diff shows the pointer change; the classifier reads source, not the
// LFS-tracked binaries/data).
function git(args: string[], opts: GitOpts = {}): Buffer {
  const { offline, ...processOpts } = opts;
  return execFileSync("git", args, {
    stdio: "pipe",
    ...processOpts,
    env: { ...process.env, GIT_LFS_SKIP_SMUDGE: "1", ...(offline ? { GIT_NO_LAZY_FETCH: "1" } : {}) },
  });
}

// Flags that keep the diff deterministic regardless of ambient git config:
// no external diff driver, no textconv, no color. (The three-dot range already
// matches GitHub's PR diff; further config pinning was intentionally left out to
// keep this change scoped.)
const DIFF_FLAGS = [
  "--no-ext-diff",
  "--no-textconv",
  "--no-color",
];

// Guard standalone ref arguments: a value starting with "-" would otherwise be
// parsed as a git option (option injection) even under argv. Commit SHAs are
// hex, so reject anything else.
export function assertHexRef(ref: string): void {
  if (!/^[0-9a-f]{4,64}$/i.test(ref)) {
    throw new Error(`unsafe git ref (expected a hex commit SHA): ${ref}`);
  }
}

// Parse an "owner/repo" NWO into validated segments. Requires exactly two
// GitHub-valid path segments and rejects only the "." / ".." traversal segments,
// so an nwo can't escape its intended cache directory. GitHub repo names may
// begin with punctuation (e.g. the special ".github" repo), so segments are not
// required to start with an alphanumeric — only the literal "." and ".."
// segments are unsafe. Accepts an already-mirror NWO too (e.g.
// "review-bench/owner_repo").
export function parseNwo(nwo: string): { owner: string; repo: string } {
  const m = /^([A-Za-z0-9._-]+)\/([A-Za-z0-9._-]+)$/.exec(nwo);
  if (!m || m[1] === "." || m[1] === ".." || m[2] === "." || m[2] === "..") {
    throw new Error(`unsafe repo nwo (expected "owner/repo"): ${nwo}`);
  }
  return { owner: m[1], repo: m[2] };
}

export function cloneRepo(nwo: string, cloneDir: string): void {
  if (existsSync(join(cloneDir, "HEAD"))) return;

  const repoUrl = `https://github.com/${nwo}.git`;
  git(["clone", "--bare", "--filter=blob:none", repoUrl, cloneDir], { timeout: 120_000 });
}

/**
 * Checkout a repo at a specific SHA into a working directory.
 * Reuses existing checkouts. Falls back to shallow clone if
 * the partial clone approach fails.
 *
 * Clones from the review-bench mirror rather than upstream: corpus PRs
 * reference upstream repos that can rot (deleted, or the head force-pushed
 * away), which would break scoring for those PRs. The mirror is the immutable
 * snapshot we keep for exactly this reason. MIRROR_ORG overrides the org
 * (default "review-bench"); private-mirror auth uses the ambient git credential
 * helper (as the review harness already does).
 */
export function checkoutRepo(nwo: string, sha: string, baseDir: string): string {
  // Validate both inputs before either is used to derive repoDir or reach any
  // git/fs call (existsSync, git -C, rmSync). A malformed sha or nwo (e.g. a
  // path-traversal prefix) must never reach the rmSync below and delete an
  // unrelated repo. nwo.replace(...) only rewrites the first "/", so an
  // unvalidated nwo like "foo/../../bar" would otherwise escape baseDir.
  assertHexRef(sha);
  const { owner, repo } = parseNwo(nwo);
  const repoDir = join(baseDir, `${owner}__${repo}`, sha.slice(0, 8));

  if (existsSync(join(repoDir, ".git"))) {
    // Reuse a cached checkout only if it is at the requested SHA AND clean.
    // HEAD alone isn't enough: an interrupted checkout, a failed LFS smudge, or
    // the classifier's own bash/edit tools (its cwd is this checkout) can leave
    // HEAD==sha with a dirty/incomplete tree, which would silently feed wrong
    // file context to the next reviewer scoring this PR. Verify clean, then
    // scrub any ignored/untracked leftovers (-ff also removes nested git repos);
    // rebuild from scratch on any doubt.
    let reusable = false;
    try {
      const head = git(["-C", repoDir, "rev-parse", "HEAD"]).toString().trim();
      const status = git(["-C", repoDir, "status", "--porcelain"]).toString();
      if (head === sha && status.length === 0) {
        git(["-C", repoDir, "clean", "-ffdx"]);
        reusable = true;
      }
    } catch {
      // corrupt/partial .git — fall through to rebuild
    }
    if (reusable) {
      return repoDir;
    }
    rmSync(repoDir, { recursive: true, force: true });
  }

  mkdirSync(repoDir, { recursive: true });
  const org = process.env.MIRROR_ORG ?? "review-bench";
  // Use the mirror. If the caller already passed a mirror NWO (owner === the
  // mirror org, e.g. run-codex-review --mirror-org), don't compose the name
  // twice. Built from the validated owner/repo, never a first-slash replace.
  const mirrorNwo = owner === org ? `${owner}/${repo}` : `${org}/${owner}_${repo}`;
  const repoUrl = `https://github.com/${mirrorNwo}.git`;

  try {
    git(["clone", "--filter=blob:none", "--no-checkout", repoUrl, repoDir], { timeout: 120_000 });
    git(["checkout", sha], { cwd: repoDir, timeout: 120_000 });
  } catch {
    try {
      rmSync(repoDir, { recursive: true, force: true });
      git(["clone", "--filter=blob:none", repoUrl, repoDir], { timeout: 120_000 });
      git(["fetch", "origin", sha], { cwd: repoDir, timeout: 120_000 });
      git(["checkout", sha], { cwd: repoDir, timeout: 120_000 });
    } catch {
      // Don't leave a partial checkout behind for a later call to trip over.
      try { rmSync(repoDir, { recursive: true, force: true }); } catch { /* best effort */ }
      throw new Error(`Could not checkout ${nwo}@${sha}`);
    }
  }

  return repoDir;
}

/** Validate a caller-provided frozen checkout without fetching or modifying it. */
export function validateSnapshot(repoDir: string, base: string, head: string): string {
  assertHexRef(base);
  assertHexRef(head);
  const offline = { offline: true };
  const actualHead = git(["-C", repoDir, "rev-parse", "HEAD"], offline).toString().trim();
  if (actualHead !== head) {
    throw new Error(`Snapshot HEAD differs from expected ${head}: ${actualHead}`);
  }
  if (git(["-C", repoDir, "status", "--porcelain", "--untracked-files=all", "--ignored"], offline).length > 0) {
    throw new Error(`Snapshot must be clean: ${repoDir}`);
  }
  git(["-C", repoDir, "cat-file", "-e", `${base}^{commit}`], offline);
  git(["-C", repoDir, "merge-base", base, head], offline);
  return repoDir;
}

export function fetchCommit(cloneDir: string, sha: string): void {
  assertHexRef(sha);
  try {
    git(["-C", cloneDir, "fetch", "origin", sha], { timeout: 60_000 });
  } catch {
    // May already have the commit, or it may be unreachable
  }
}

export function fileExistsAtCommit(
  cloneDir: string,
  sha: string,
  filePath: string,
): boolean {
  assertHexRef(sha);
  try {
    git(["-C", cloneDir, "cat-file", "-t", `${sha}:${filePath}`]);
    return true;
  } catch {
    return false;
  }
}

export function getFileAtCommit(
  cloneDir: string,
  sha: string,
  filePath: string,
): string | null {
  assertHexRef(sha);
  try {
    const result = git(["-C", cloneDir, "show", `${sha}:${filePath}`], {
      maxBuffer: 10 * 1024 * 1024,
    });
    return result.toString("utf-8");
  } catch {
    return null;
  }
}

export function getDiffBetweenCommits(
  cloneDir: string,
  shaFrom: string,
  shaTo: string,
  filePath: string,
): string | null {
  assertHexRef(shaFrom);
  assertHexRef(shaTo);
  try {
    // --literal-pathspecs: treat filePath as a literal path, not a pathspec, so
    // an adversarial filename like ":(exclude)x" can't reselect the diff.
    const result = git(
      ["-C", cloneDir, "--literal-pathspecs", "diff", shaFrom, shaTo, "--", filePath],
      { maxBuffer: 10 * 1024 * 1024 },
    );
    return result.toString("utf-8");
  } catch {
    return null;
  }
}

/**
 * Full PR diff (merge-base..head), computed from a local (mirror) checkout.
 *
 * This is the upstream-free source of the PR diff used by scoring: the mirror
 * preserves both SHAs even when the upstream repo has rotted, so the diff is
 * always reproducible without contacting the upstream repo.
 *
 * Uses three-dot (`from...to`) to match GitHub's PR diff (merge-base to head);
 * two-dot would include base-branch-only changes when the base is not an
 * ancestor of head. Both commits must already be present locally — a missing
 * one throws rather than silently producing a wrong/empty diff.
 */
export function getFullDiff(
  cloneDir: string,
  shaFrom: string,
  shaTo: string,
  options: Pick<GitOpts, "offline"> = {},
): string {
  assertHexRef(shaFrom);
  assertHexRef(shaTo);
  for (const sha of [shaFrom, shaTo]) {
    try {
      git(["-C", cloneDir, "cat-file", "-e", `${sha}^{commit}`], options);
    } catch {
      throw new Error(`commit ${sha} not present in ${cloneDir}; cannot diff`);
    }
  }
  const result = git(
    ["-C", cloneDir, "diff", ...DIFF_FLAGS, `${shaFrom}...${shaTo}`],
    { ...options, maxBuffer: 50 * 1024 * 1024, timeout: 180_000 },
  );
  return result.toString("utf-8");
}

/**
 * Check whether a line region is unchanged between two commits.
 *
 * If unchanged, returns remapped line numbers accounting for hunks
 * above the region that shifted lines.
 */
export function checkRegionUnchanged(
  cloneDir: string,
  shaFrom: string,
  shaTo: string,
  filePath: string,
  startLine: number,
  endLine: number,
): RegionCheck {
  const diff = getDiffBetweenCommits(cloneDir, shaFrom, shaTo, filePath);

  if (diff === null) {
    return { unchanged: false, newStartLine: null, newEndLine: null };
  }

  // No diff means file is identical
  if (diff.trim() === "") {
    return { unchanged: true, newStartLine: startLine, newEndLine: endLine };
  }

  // Parse hunks to check overlap and compute offset
  let offset = 0;
  for (const line of diff.split("\n")) {
    if (!line.startsWith("@@")) continue;

    const match = line.match(/@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/);
    if (!match) continue;

    const oldStart = parseInt(match[1], 10);
    const oldCount = match[2] ? parseInt(match[2], 10) : 1;
    const newCount = match[4] ? parseInt(match[4], 10) : 1;
    const oldEnd = oldStart + oldCount - 1;

    // Hunk overlaps with our region — code has changed
    if (oldStart <= endLine && oldEnd >= startLine) {
      return { unchanged: false, newStartLine: null, newEndLine: null };
    }

    // Hunk is before our region — accumulate line offset
    if (oldEnd < startLine) {
      offset += newCount - oldCount;
    }
  }

  // No hunks overlap — region is unchanged
  return {
    unchanged: true,
    newStartLine: startLine + offset,
    newEndLine: endLine + offset,
  };
}

/**
 * Extract a code region with surrounding context lines.
 */
export function extractCodeRegion(
  cloneDir: string,
  sha: string,
  filePath: string,
  startLine: number,
  endLine: number,
  context: number = 3,
): string | null {
  const content = getFileAtCommit(cloneDir, sha, filePath);
  if (content === null) return null;

  const lines = content.split("\n");
  const ctxStart = Math.max(0, startLine - 1 - context);
  const ctxEnd = Math.min(lines.length, endLine + context);

  const result: string[] = [];
  for (let i = ctxStart; i < ctxEnd; i++) {
    const marker = i >= startLine - 1 && i < endLine ? ">" : " ";
    result.push(`${marker} ${String(i + 1).padStart(4)} | ${lines[i]}`);
  }

  return result.join("\n");
}
