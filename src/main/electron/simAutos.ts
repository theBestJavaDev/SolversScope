// Copyright (c) 2021-2026 Littleton Robotics & FTC Team 23511 Seattle Solvers
// http://github.com/Mechanical-Advantage
//
// Use of this source code is governed by a BSD
// license that can be found in the LICENSE file
// at the root directory of this project.

/**
 * Multisim: lists the robot code's autos (the tests in RunAutos.java) and runs several of them in
 * the robot repo's sim in one Gradle build (`testDebugUnitTest --tests *.RunAutos.<method>`, with
 * SIM_NO_OPEN so the runs don't open one by one). Each auto writes TeamCode/build/sim/<Class>.rlog;
 * when the build ends, the new logs are handed to the Multi Field / Multisim tab together.
 */

import { ChildProcess, spawn, spawnSync } from "child_process";
import fs from "fs";
import path from "path";
import { findDefaultRunsFolder } from "./runsFolder";

export type SimAuto = { method: string; className: string; description: string };
export type SimAutosList = {
  repo: string | null;
  autos: SimAuto[];
  /** The branch these autos were read from ("" = the checkout as it is on disk). */
  branch: string;
  /** The branch checked out on disk (shown as "Your checkout (…)"). */
  current: string | null;
  /** Branches that can be run instead (local, then remote-only). */
  branches: string[];
  error?: string;
};
/** One auto to run, from a branch ("" = the checkout on disk, uncommitted changes included). */
export type SimAutoPick = { method: string; branch: string };

const RUN_AUTOS_FILE = "RunAutos.java";
/** Where other branches are checked out to run (inside the repo's ignored build folder). */
const WORKTREE_DIR = path.join("build", "multisim-worktree");

/**
 * The robot repo for a runs folder (anywhere under <repo>, e.g. <repo>/TeamCode/build/sim/multisim),
 * or the newest one in the home folder.
 */
export function findRobotRepo(runsFolder: string | null | undefined): string | null {
  const candidates = [runsFolder ?? null, findDefaultRunsFolder()];
  for (const folder of candidates) {
    if (folder === null) continue;
    let dir = path.resolve(folder);
    for (let up = 0; up < 6; up++) {
      if (path.basename(dir) === "multisim-worktree") break; // never treat the branch copy as the project
      if (fs.existsSync(path.join(dir, "TeamCode")) && fs.existsSync(path.join(dir, gradleScript()))) return dir;
      const parent = path.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  }
  return null;
}

function git(repo: string, args: string[]): { ok: boolean; out: string } {
  const result = spawnSync("git", ["-C", repo, ...args], { encoding: "utf-8", windowsHide: true });
  return { ok: result.status === 0, out: (result.stdout ?? "") + (result.status === 0 ? "" : result.stderr ?? "") };
}

/** The branch checked out on disk, and the branches that could be run. */
function listBranches(repo: string): { current: string | null; branches: string[] } {
  const head = git(repo, ["rev-parse", "--abbrev-ref", "HEAD"]);
  const current = head.ok && head.out.trim() !== "HEAD" ? head.out.trim() : null;
  const refs = (namespace: string) => {
    const result = git(repo, ["for-each-ref", "--sort=-committerdate", "--format=%(refname:short)", namespace]);
    return result.ok
      ? result.out
          .split(/\r?\n/)
          .map((ref) => ref.trim())
          .filter((ref) => ref !== "" && !ref.endsWith("/HEAD") && ref !== "origin")
      : [];
  };
  const local = refs("refs/heads");
  // Remote branches only when there's no local branch of the same name (origin/v1.5 when v1.5 exists)
  const remote = refs("refs/remotes").filter((ref) => !local.includes(ref.slice(ref.indexOf("/") + 1)));
  return { current, branches: [...local, ...remote] };
}

function gradleScript(): string {
  return process.platform === "win32" ? "gradlew.bat" : "gradlew";
}

/** Finds RunAutos.java under TeamCode/src/test (depth-limited walk). */
function findRunAutos(repo: string): string | null {
  const root = path.join(repo, "TeamCode", "src", "test");
  const stack: { dir: string; depth: number }[] = [{ dir: root, depth: 0 }];
  while (stack.length > 0) {
    const { dir, depth } = stack.pop()!;
    let entries: fs.Dirent[] = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isFile() && entry.name === RUN_AUTOS_FILE) return full;
      if (entry.isDirectory() && depth < 12) stack.push({ dir: full, depth: depth + 1 });
    }
  }
  return null;
}

/**
 * The autos RunAutos.java can run (`@Test public void autoMax() { simulate(new AutoMax(), ...`), read
 * from the checkout on disk or, for another branch, from git.
 */
export function listSimAutos(runsFolder: string | null | undefined, branch = ""): SimAutosList {
  const repo = findRobotRepo(runsFolder);
  if (repo === null) {
    return { repo: null, autos: [], branch, current: null, branches: [], error: "No robot code project found." };
  }
  const { current, branches } = listBranches(repo);
  const base = { repo, branch, current, branches };
  const file = findRunAutos(repo);
  if (file === null) return { ...base, autos: [], error: "No " + RUN_AUTOS_FILE + " in this robot project." };
  let source = "";
  if (branch === "") {
    try {
      source = fs.readFileSync(file, "utf-8");
    } catch {
      return { ...base, autos: [], error: "Could not read " + RUN_AUTOS_FILE + "." };
    }
  } else {
    const relative = path.relative(repo, file).split(path.sep).join("/");
    const shown = git(repo, ["show", branch + ":" + relative]);
    if (!shown.ok) return { ...base, autos: [], error: "Branch " + branch + " has no " + RUN_AUTOS_FILE + "." };
    source = shown.out;
  }
  return { ...base, autos: parseAutos(source) };
}

function parseAutos(source: string): SimAuto[] {
  const autos: SimAuto[] = [];
  // The doc comment right above the test (its body can't contain "*/", or it would swallow earlier comments)
  const pattern =
    /(?:\/\*\*((?:(?!\*\/)[\s\S])*)\*\/\s*)?@Test\s+public\s+void\s+(\w+)\s*\(\s*\)\s*\{\s*simulate\s*\(\s*new\s+(\w+)\s*\(/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(source)) !== null) {
    const description = (match[1] ?? "")
      .split(/\r?\n/)
      .map((line) => line.replace(/^\s*\*\s?/, "").trim())
      .filter((line) => line !== "" && !line.startsWith("@"))
      .join(" ");
    autos.push({ method: match[2], className: match[3], description });
  }
  return autos;
}

/** The log an auto writes (named after its class, so e.g. AutoMax red and blue write the same file). */
function autoLogPath(repo: string, auto: SimAuto): string {
  return path.join(repo, "TeamCode", "build", "sim", auto.className + ".rlog");
}

/** The name a run is shown and kept under: the test method, capitalized (AutoMaxBlue). */
export function autoRunName(auto: SimAuto): string {
  return auto.method.charAt(0).toUpperCase() + auto.method.slice(1);
}

/** A run's name with its branch, e.g. "AutoMax" (the checkout on disk) or "AutoMax@v1.5". */
export function pickRunName(auto: SimAuto, branch: string): string {
  return autoRunName(auto) + (branch === "" ? "" : "@" + branch.replace(/[^\w.-]+/g, "-"));
}

/** Where Multisim keeps each run, so runs of the same auto class (or branch) don't overwrite each other. */
function multisimLogPath(repo: string, auto: SimAuto, branch: string): string {
  return path.join(repo, "TeamCode", "build", "sim", "multisim", pickRunName(auto, branch) + ".rlog");
}

/**
 * Checks `branch` out (detached, as committed) in the repo's branch copy, made on first use. Returns its
 * folder, or null with the reason sent to `onLine`.
 */
function prepareBranch(repo: string, branch: string, onLine: (line: string) => void): string | null {
  const dir = path.join(repo, WORKTREE_DIR);
  if (!fs.existsSync(path.join(dir, ".git"))) {
    git(repo, ["worktree", "prune"]);
    onLine("Making a copy of the robot code for other branches (" + dir + ")…");
    const added = git(repo, ["worktree", "add", "--detach", "--force", dir, branch]);
    if (!added.ok) {
      onLine("Could not make the branch copy: " + added.out.trim());
      return null;
    }
  } else {
    const switched = git(dir, ["checkout", "--detach", "--force", branch]);
    if (!switched.ok) {
      onLine("Could not switch the branch copy to " + branch + ": " + switched.out.trim());
      return null;
    }
  }
  // The Android SDK path isn't committed; the copy needs the project's
  const properties = path.join(repo, "local.properties");
  if (fs.existsSync(properties)) fs.copyFileSync(properties, path.join(dir, "local.properties"));
  onLine("Robot code: " + branch + " (" + git(dir, ["log", "--oneline", "-1"]).out.trim() + ")");
  return dir;
}

let running: ChildProcess | null = null;
let busy = false;
let cancelled = false;

export function isRunningSimAutos(): boolean {
  return busy;
}

export type SimAutosResult = { files: string[]; failed: string[]; cancelled: boolean; exitCode: number | null };

/** Runs one auto in its own Gradle build; resolves with Gradle's exit code. */
function runOne(repo: string, auto: SimAuto, onLine: (line: string) => void): Promise<number | null> {
  return new Promise((resolve) => {
    const args = [":TeamCode:testDebugUnitTest", "--console=plain", "--tests", "*.RunAutos." + auto.method];
    const env = { ...process.env, SIM_NO_OPEN: "1" };
    // Full path to the wrapper: cmd doesn't search the working folder when NoDefaultCurrentDirectoryInExePath is
    // set. The arguments are fixed strings plus a Java method name (\w+), so running through the shell is safe.
    const script = path.join(repo, gradleScript());
    const child =
      process.platform === "win32"
        ? spawn('"' + script + '"', args, { cwd: repo, env, windowsHide: true, shell: true })
        : spawn(script, args, { cwd: repo, env });
    running = child;
    let buffer = "";
    const handle = (chunk: Buffer) => {
      buffer += chunk.toString();
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() ?? "";
      lines
        .map((line) => line.trim())
        .filter((line) => line !== "")
        .forEach(onLine);
    };
    child.stdout?.on("data", handle);
    child.stderr?.on("data", handle);
    child.on("error", (error) => onLine("Could not start Gradle: " + error.message));
    child.on("close", (exitCode) => {
      running = null;
      if (buffer.trim() !== "") onLine(buffer.trim());
      resolve(exitCode);
    });
  });
}

/** Why an auto's test failed, from Gradle's test results (e.g. a missing hardware device), if it did. */
function failureReason(dir: string, since: number): string | null {
  const results = path.join(dir, "TeamCode", "build", "test-results", "testDebugUnitTest");
  try {
    const file = fs.readdirSync(results).find((name) => name.includes("RunAutos") && name.endsWith(".xml"));
    if (file === undefined || fs.statSync(path.join(results, file)).mtimeMs < since - 2000) return null;
    const xml = fs.readFileSync(path.join(results, file), "utf-8");
    const message = /<failure message="([^"]*)"/.exec(xml)?.[1];
    return message === undefined
      ? null
      : message.replace(/&quot;/g, '"').replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
  } catch {
    return null;
  }
}

/**
 * Runs the picked autos one after another (each in its own Gradle build, in the checkout on disk or a
 * copy of its branch) and copies each new log to build/sim/multisim/<AutoName>[@branch].rlog.
 * `onLine` gets progress lines; `onDone` the kept logs (in the order picked) and the runs that didn't
 * produce one.
 */
export async function runSimAutos(
  repo: string,
  picks: { auto: SimAuto; branch: string }[],
  onLine: (line: string) => void,
  onDone: (result: SimAutosResult) => void
) {
  if (busy) return;
  busy = true;
  cancelled = false;
  const files: string[] = [];
  const failed: string[] = [];
  let lastExit: number | null = null;
  for (let i = 0; i < picks.length; i++) {
    const { auto, branch } = picks[i];
    const name = pickRunName(auto, branch);
    if (cancelled) {
      failed.push(name);
      continue;
    }
    onLine("=== Running " + name + " (" + (i + 1) + " of " + picks.length + ")");
    const dir = branch === "" ? repo : prepareBranch(repo, branch, onLine);
    if (dir === null) {
      failed.push(name);
      continue;
    }
    const started = Date.now();
    lastExit = await runOne(dir, auto, onLine);
    const written = autoLogPath(dir, auto);
    try {
      if (!cancelled && fs.statSync(written).mtimeMs >= started - 2000) {
        const kept = multisimLogPath(repo, auto, branch);
        fs.mkdirSync(path.dirname(kept), { recursive: true });
        fs.copyFileSync(written, kept);
        files.push(kept);
        continue;
      }
    } catch {
      // no new log
    }
    if (!cancelled) {
      const reason = failureReason(dir, started);
      onLine("!!! " + name + " made no run" + (reason !== null ? ": " + reason : " (see the output above)"));
    }
    failed.push(name);
  }
  busy = false;
  onDone({ files, failed, cancelled, exitCode: lastExit });
}

/** Stops the running build (and the test JVM under it). */
export function cancelSimAutos() {
  if (running === null || running.pid === undefined) return;
  cancelled = true;
  if (process.platform === "win32") {
    spawnSync("taskkill", ["/pid", running.pid.toString(), "/T", "/F"], { windowsHide: true });
  } else {
    running.kill("SIGTERM");
  }
}
