// Copyright (c) 2021-2026 Littleton Robotics & FTC Team 23511 Seattle Solvers
// http://github.com/Mechanical-Advantage
//
// Use of this source code is governed by a BSD
// license that can be found in the LICENSE file
// at the root directory of this project.

/**
 * Multisim's "Run autos…": the robot code's autos (tests in RunAutos.java, listed by the main
 * process in src/main/electron/simAutos.ts) with checkboxes. "Robot code" picks where they come from:
 * the checkout on disk, or any branch (run from a copy, so the checkout is never touched). Ticking an
 * auto picks it from the branch shown, so the same auto can be picked on two branches. Tick up to
 * three and press Run: they run one after another (progress shown here, with Cancel), then the
 * Multisim tab shows the new runs side by side, all playing from the auto START.
 */

import { storedFolder } from "./runPicker";

const MAX_AUTOS = 3;
const MAX_LOG_LINES = 400;

type SimAuto = { method: string; className: string; description: string };
type SimAutosList = {
  repo: string | null;
  autos: SimAuto[];
  branch: string;
  current: string | null;
  branches: string[];
  error?: string;
};
type SimAutosDone = { files: string[]; failed: string[]; cancelled: boolean; exitCode: number | null };
/** One picked run: an auto from a branch ("" = the robot code as it is on disk). */
type Pick = { auto: SimAuto; branch: string };

let request: { uuid: string } | null = null;
let dialog: HTMLElement | null = null;
let running = false;
/** The auto being run now, e.g. "AutoMaxBlue (2 of 3)". */
let current = "";
/** Why runs made no log ("!!!" lines from the main process). */
let problems: string[] = [];
let picked: Pick[] = [];
/** The branch the list shows (ticking an auto picks it from this branch). */
let branch = "";

/** How a run is named (the test method, capitalized: AutoMax and AutoMaxBlue share a class). */
function runName(auto: SimAuto): string {
  return auto.method.charAt(0).toUpperCase() + auto.method.slice(1);
}

function pickName(pick: Pick): string {
  return runName(pick.auto) + (pick.branch === "" ? "" : " @" + pick.branch);
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className: string, text?: string): HTMLElementTagNameMap[K] {
  const element = document.createElement(tag);
  element.className = className;
  if (text !== undefined) element.textContent = text;
  return element;
}

/** Opens the auto picker for a Multisim tab (or shows the run in progress). */
export function openAutoPicker(uuid: string) {
  if (running && dialog !== null) return;
  request = { uuid };
  picked = [];
  build();
  window.sendMainMessage("list-sim-autos", { folder: storedFolder(), branch });
}

function close() {
  if (running) return; // the Cancel button stops a run first
  dialog?.remove();
  dialog = null;
  request = null;
}

function q<T extends HTMLElement>(selector: string): T {
  return dialog!.querySelector(selector) as T;
}

function build() {
  dialog?.remove();
  const backdrop = el("div", "runpicker-backdrop");
  const box = el("div", "runpicker autopicker");
  box.setAttribute("role", "dialog");
  box.setAttribute("aria-label", "Run autos");

  const header = el("div", "runpicker-header");
  const titles = el("div", "runpicker-titles");
  titles.append(
    el("div", "runpicker-title", "Run autos"),
    el(
      "div",
      "runpicker-subtitle",
      "Tick up to " +
        MAX_AUTOS +
        " autos. Switch “Robot code” to pick from another branch (e.g. the same auto on two branches)."
    )
  );
  const closeButton = el("button", "runpicker-close", "✕");
  closeButton.title = "Close";
  closeButton.addEventListener("click", close);
  header.append(titles, closeButton);

  const repoRow = el("div", "runpicker-folder");
  const branchSelect = el("select", "autopicker-branch");
  branchSelect.title = "Which robot code to run: your checkout as it is on disk, or a branch as committed";
  branchSelect.addEventListener("change", () => {
    branch = branchSelect.value;
    q<HTMLElement>(".runpicker-list").replaceChildren(
      el("div", "runpicker-empty", "Reading the autos on " + (branch === "" ? "your checkout" : branch) + "…")
    );
    window.sendMainMessage("list-sim-autos", { folder: storedFolder(), branch });
  });
  repoRow.append(
    el("span", "runpicker-folder-label", "Robot code"),
    branchSelect,
    el("span", "runpicker-folder-path autopicker-repo", "Looking for the robot code…")
  );

  const search = el("input", "runpicker-search");
  search.placeholder = "Search autos…";
  const list = el("div", "runpicker-list");

  const progress = el("div", "autopicker-progress");
  progress.hidden = true;
  progress.append(el("div", "autopicker-stage", "Starting the robot sim…"), el("pre", "autopicker-log"));

  const footer = el("div", "runpicker-footer");
  const count = el("span", "runpicker-count", "None picked");
  const cancel = el("button", "multifield-button autopicker-cancel", "Close");
  cancel.addEventListener("click", () => {
    if (running) {
      window.sendMainMessage("cancel-sim-autos");
      q<HTMLElement>(".autopicker-stage").textContent = "Stopping…";
    } else {
      close();
    }
  });
  const run = el("button", "multifield-button runpicker-show autopicker-run", "Run");
  run.disabled = true;
  run.addEventListener("click", start);
  footer.append(count, cancel, run);

  box.append(header, repoRow, search, list, progress, footer);
  backdrop.appendChild(box);
  backdrop.addEventListener("mousedown", (event) => {
    if (event.target === backdrop) close();
  });
  backdrop.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      event.stopPropagation();
      close();
    }
  });
  document.body.appendChild(backdrop);
  dialog = backdrop;
  search.focus();
}

function updatePicked() {
  if (dialog === null) return;
  const count = q<HTMLElement>(".runpicker-count");
  const run = q<HTMLButtonElement>(".autopicker-run");
  count.textContent =
    picked.length === 0
      ? "None picked"
      : picked.map(pickName).join(" · ") + "  (" + picked.length + "/" + MAX_AUTOS + ")";
  count.title = count.textContent;
  run.disabled = picked.length === 0;
  run.textContent = picked.length > 1 ? "Run " + picked.length + " autos" : "Run";
  dialog.querySelectorAll<HTMLInputElement>(".runpicker-list input").forEach((input) => {
    input.disabled = !input.checked && picked.length >= MAX_AUTOS;
    input.closest(".runpicker-row")?.classList.toggle("disabled", input.disabled);
  });
}

/** Fills the picker with the autos the main process found ("sim-autos-list"). */
export function handleSimAutosList(data: SimAutosList) {
  if (dialog === null || running || data.branch !== branch) return;
  const repo = q<HTMLElement>(".autopicker-repo");
  const list = q<HTMLElement>(".runpicker-list");
  const search = q<HTMLInputElement>(".runpicker-search");
  const select = q<HTMLSelectElement>(".autopicker-branch");
  repo.textContent = data.repo ?? "Not found";
  repo.title = data.repo ?? "";

  // Robot code menu: the checkout on disk first, then the branches
  select.replaceChildren();
  const option = (value: string, text: string) => {
    const element = el("option", "", text);
    element.value = value;
    select.appendChild(element);
  };
  option("", "Your checkout" + (data.current !== null ? " (" + data.current + ")" : ""));
  data.branches.forEach((name) => option(name, name));
  if (branch !== "" && !data.branches.includes(branch)) option(branch, branch);
  select.value = branch;

  list.replaceChildren();
  if (data.autos.length === 0) {
    list.appendChild(
      el(
        "div",
        "runpicker-empty",
        (data.error ?? "No autos found.") +
          (data.repo === null
            ? " Open a run from the robot project once (Choose runs… → Change folder… → its TeamCode\\build\\sim) so SolversScope knows where it is."
            : "")
      )
    );
  }
  for (const auto of data.autos) {
    const row = el("label", "runpicker-row autopicker-row");
    const box = el("input", "runpicker-check");
    box.type = "checkbox";
    const pickedIndex = () => picked.findIndex((pick) => pick.auto.method === auto.method && pick.branch === branch);
    box.checked = pickedIndex() >= 0;
    box.addEventListener("change", () => {
      const index = pickedIndex();
      if (box.checked && index < 0) picked.push({ auto, branch });
      if (!box.checked && index >= 0) picked.splice(index, 1);
      updatePicked();
    });
    const text = el("span", "autopicker-text");
    text.append(el("span", "runpicker-name", runName(auto)));
    if (auto.description !== "") text.append(el("span", "autopicker-desc", auto.description));
    row.append(box, text);
    row.dataset.name = (runName(auto) + " " + auto.description).toLowerCase();
    list.appendChild(row);
  }
  const filter = () => {
    const query = search.value.trim().toLowerCase();
    list.querySelectorAll<HTMLElement>(".runpicker-row").forEach((row) => {
      row.hidden = query !== "" && !(row.dataset.name ?? "").includes(query);
    });
  };
  search.oninput = filter;
  filter();
  updatePicked();
}

function start() {
  if (request === null || picked.length === 0 || dialog === null) return;
  running = true;
  problems = [];
  q<HTMLElement>(".runpicker-search").hidden = true;
  q<HTMLElement>(".runpicker-list").hidden = true;
  q<HTMLSelectElement>(".autopicker-branch").disabled = true;
  q<HTMLElement>(".autopicker-progress").hidden = false;
  q<HTMLElement>(".autopicker-log").textContent = "";
  const stage = q<HTMLElement>(".autopicker-stage");
  stage.classList.remove("autopicker-error");
  stage.textContent =
    "Starting the robot sim for " + picked.map(pickName).join(", ") + "… (the first run also builds the code)";
  q<HTMLButtonElement>(".autopicker-run").hidden = true;
  q<HTMLButtonElement>(".autopicker-cancel").textContent = "Cancel";
  window.sendMainMessage("run-sim-autos", {
    uuid: request.uuid,
    folder: storedFolder(),
    picks: picked.map((pick) => ({ method: pick.auto.method, branch: pick.branch }))
  });
}

/** One line of output from the run ("sim-autos-progress"). */
export function handleSimAutosProgress(line: string) {
  if (dialog === null || !running) return;
  const log = q<HTMLElement>(".autopicker-log");
  const lines = (log.textContent ?? "").split("\n").filter((l) => l !== "");
  lines.push(line);
  log.textContent = lines.slice(-MAX_LOG_LINES).join("\n");
  log.scrollTop = log.scrollHeight;
  const stage = q<HTMLElement>(".autopicker-stage");
  if (line.startsWith("!!! ")) {
    problems.push(line.slice(4));
    return;
  }
  const next = /^=== Running (\S+) \((\d+) of (\d+)\)/.exec(line);
  if (next !== null) {
    current = next[1] + " (" + next[2] + " of " + next[3] + ")";
    stage.textContent = "Preparing " + current + "…";
    return;
  }
  const task = /^> Task (\S+)/.exec(line);
  if (task !== null) {
    const name = task[1].split(":").pop() ?? task[1];
    stage.textContent = name.toLowerCase().includes("test")
      ? "Running " + current + " in the robot sim…"
      : "Building the robot code for " + current + " (" + name + ")…";
  }
}

/** All runs finished ("sim-autos-done"): close on success, else say what went wrong. */
export function handleSimAutosDone(result: SimAutosDone) {
  running = false;
  if (dialog === null) return;
  const stage = q<HTMLElement>(".autopicker-stage");
  const cancel = q<HTMLButtonElement>(".autopicker-cancel");
  cancel.textContent = "Close";
  if (result.cancelled) {
    stage.textContent = "Stopped.";
    return;
  }
  if (result.failed.length === 0) {
    close();
    return;
  }
  stage.classList.add("autopicker-error");
  stage.textContent =
    (result.files.length > 0 ? "Showing the runs that finished. " : "") +
    (problems.length > 0
      ? problems.join(" · ")
      : "No new run from " + result.failed.join(", ") + ". The output below says why.");
}
