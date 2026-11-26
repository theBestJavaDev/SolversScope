// Copyright (c) 2021-2026 Littleton Robotics & FTC Team 23511 Seattle Solvers
// http://github.com/Mechanical-Advantage
//
// Use of this source code is governed by a BSD
// license that can be found in the LICENSE file
// at the root directory of this project.

/**
 * Run picker for the Multi Field tab's "Choose run…": the runs in a folder as a list with checkboxes,
 * so picking two or three runs doesn't depend on Ctrl+click in the system file window. Tick up to
 * three and press Show; double-click one to show just that one. The main process lists the folder
 * (src/main/electron/runsFolder.ts) and loads the chosen runs ("runs-chosen").
 */

const MAX_RUNS = 3;
const FOLDER_KEY = "solversscope.runsFolder";

type RunFile = { name: string; path: string; modified: number; sizeKb: number };
type RunsList = { folder: string | null; runs: RunFile[] };

let request: { uuid: string; pane: number } | null = null;
let dialog: HTMLElement | null = null;

/** The runs folder last used (also tells Multisim's auto picker which robot project to use). */
export function storedFolder(): string | null {
  try {
    return window.localStorage.getItem(FOLDER_KEY);
  } catch {
    return null;
  }
}

/** Remembers the folder of a log that was opened, so the picker starts there next time. */
export function rememberRunFolder(file: string) {
  const index = Math.max(file.lastIndexOf("\\"), file.lastIndexOf("/"));
  if (index <= 0) return;
  try {
    window.localStorage.setItem(FOLDER_KEY, file.slice(0, index));
  } catch {
    // storage unavailable: the picker falls back to the default folder
  }
}

/** Opens the picker for one field of a Multi Field tab. */
export function openRunPicker(uuid: string, pane: number) {
  request = { uuid, pane };
  build();
  window.sendMainMessage("list-runs", { folder: storedFolder() });
}

function close() {
  dialog?.remove();
  dialog = null;
  request = null;
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className: string, text?: string): HTMLElementTagNameMap[K] {
  const element = document.createElement(tag);
  element.className = className;
  if (text !== undefined) element.textContent = text;
  return element;
}

function build() {
  dialog?.remove();
  const backdrop = el("div", "runpicker-backdrop");
  const box = el("div", "runpicker");
  box.setAttribute("role", "dialog");
  box.setAttribute("aria-label", "Choose runs");

  const header = el("div", "runpicker-header");
  const titles = el("div", "runpicker-titles");
  titles.append(
    el("div", "runpicker-title", "Choose runs"),
    el("div", "runpicker-subtitle", "Tick up to " + MAX_RUNS + ". Each one gets its own field, all playing together.")
  );
  const closeButton = el("button", "runpicker-close", "✕");
  closeButton.title = "Close";
  closeButton.addEventListener("click", close);
  header.append(titles, closeButton);

  const folderRow = el("div", "runpicker-folder");
  const folderText = el("span", "runpicker-folder-path", "Looking for your runs…");
  const changeFolder = el("button", "multifield-button", "Change folder…");
  changeFolder.addEventListener("click", () => window.sendMainMessage("browse-runs-folder"));
  folderRow.append(el("span", "runpicker-folder-label", "Folder"), folderText, changeFolder);

  const search = el("input", "runpicker-search");
  search.placeholder = "Search runs…";
  const list = el("div", "runpicker-list");

  const footer = el("div", "runpicker-footer");
  const count = el("span", "runpicker-count", "None picked");
  const browse = el("button", "runpicker-link", "Browse files instead…");
  browse.title = "Use the system file window";
  browse.addEventListener("click", () => {
    if (request !== null) window.sendMainMessage("choose-run-for-field", request);
    close();
  });
  const cancel = el("button", "multifield-button", "Cancel");
  cancel.addEventListener("click", close);
  const show = el("button", "multifield-button runpicker-show", "Show");
  show.disabled = true;
  footer.append(count, browse, cancel, show);

  box.append(header, folderRow, search, list, footer);
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

/** Fills the picker with the runs the main process listed ("runs-list"). */
export function handleRunsList(data: RunsList) {
  if (dialog === null || request === null) return;
  const folderText = dialog.querySelector(".runpicker-folder-path") as HTMLElement;
  const list = dialog.querySelector(".runpicker-list") as HTMLElement;
  const search = dialog.querySelector(".runpicker-search") as HTMLInputElement;
  const count = dialog.querySelector(".runpicker-count") as HTMLElement;
  const show = dialog.querySelector(".runpicker-show") as HTMLButtonElement;
  folderText.textContent = data.folder ?? "No runs folder found yet";
  folderText.title = data.folder ?? "";
  if (data.folder !== null) {
    try {
      window.localStorage.setItem(FOLDER_KEY, data.folder);
    } catch {
      // storage unavailable
    }
  }

  const picked: string[] = [];
  const submit = (files: string[]) => {
    if (request === null || files.length === 0) return;
    window.sendMainMessage("runs-chosen", { files, uuid: request.uuid, pane: request.pane });
    close();
  };
  const update = () => {
    count.textContent = picked.length === 0 ? "None picked" : picked.length + " of " + MAX_RUNS + " picked";
    show.disabled = picked.length === 0;
    show.textContent = picked.length > 1 ? "Show " + picked.length + " runs" : "Show";
    list.querySelectorAll("input").forEach((box) => {
      const input = box as HTMLInputElement;
      input.disabled = !input.checked && picked.length >= MAX_RUNS;
      input.closest(".runpicker-row")?.classList.toggle("disabled", input.disabled);
    });
  };
  show.onclick = () => submit([...picked]);

  list.replaceChildren();
  if (data.runs.length === 0) {
    list.appendChild(
      el(
        "div",
        "runpicker-empty",
        data.folder === null
          ? "Press “Change folder…” and pick the folder with your runs (in the robot code: TeamCode\\build\\sim)."
          : "No runs in this folder. Press “Change folder…” to pick another one."
      )
    );
  }
  const format = new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit"
  });
  for (const run of data.runs) {
    const row = el("label", "runpicker-row");
    const box = el("input", "runpicker-check");
    box.type = "checkbox";
    box.addEventListener("change", () => {
      const index = picked.indexOf(run.path);
      if (box.checked && index < 0) picked.push(run.path);
      if (!box.checked && index >= 0) picked.splice(index, 1);
      update();
    });
    row.addEventListener("dblclick", (event) => {
      event.preventDefault();
      submit([run.path]);
    });
    row.append(
      box,
      el("span", "runpicker-name", run.name.replace(/\.[^.]+$/, "")),
      el("span", "runpicker-date", format.format(new Date(run.modified)))
    );
    row.dataset.name = run.name.toLowerCase();
    list.appendChild(row);
  }
  search.oninput = () => {
    const query = search.value.trim().toLowerCase();
    list.querySelectorAll<HTMLElement>(".runpicker-row").forEach((row) => {
      row.hidden = query !== "" && !(row.dataset.name ?? "").includes(query);
    });
  };
  update();
}
