// Copyright (c) 2021-2026 Littleton Robotics & FTC Team 23511 Seattle Solvers
// http://github.com/Mechanical-Advantage
//
// Use of this source code is governed by a BSD
// license that can be found in the LICENSE file
// at the root directory of this project.

import type { MultisimLive, MultisimSummary } from "../../hub/multisimStats";
import Field3dRenderer, { Field3dRendererCommand } from "./Field3dRenderer";
import TabRenderer from "./TabRenderer";

/** One run in the Multisim compare panel. `summary` is null when the pane has no robot-code sim run. */
export type MultisimRunView = {
  title: string;
  color: string;
  summary: MultisimSummary | null;
  live: MultisimLive | null;
};

export type MultiFieldRendererCommand = {
  /** `empty`: nothing assigned to this field yet (shows how to fill it). */
  panes: { title: string; empty: boolean; command: Field3dRendererCommand }[];
  /** All runs drawn on one field (one pane). */
  overlay?: boolean;
  /** Compare panel data (null: panel hidden). */
  runs?: MultisimRunView[] | null;
};

type Row = {
  label: string;
  /** Formatted value for one run (live rows get the run's live values). */
  value: (run: MultisimRunView) => string;
  /** Number to diff against run A (none: no diff shown). */
  diff?: (run: MultisimRunView) => number | null;
  unit?: string;
  /** Which direction is better (colors the diff), if either. */
  better?: "higher" | "lower";
  digits?: number;
};

const fmt = (value: number | null | undefined, digits = 1, unit = "") =>
  value === null || value === undefined || !isFinite(value) ? "—" : value.toFixed(digits) + unit;

const S = (run: MultisimRunView) => run.summary;
const hitRate = (run: MultisimRunView) => {
  const s = S(run);
  return s !== null && s.shots > 0 ? (100 * s.scored) / s.shots : null;
};

const GROUPS: { title: string; rows: Row[] }[] = [
  {
    title: "Scoring",
    rows: [
      { label: "Shots", value: (r) => fmt(S(r)?.shots, 0), diff: (r) => S(r)?.shots ?? null, digits: 0 },
      {
        label: "Scored",
        value: (r) => fmt(S(r)?.scored, 0),
        diff: (r) => S(r)?.scored ?? null,
        better: "higher",
        digits: 0
      },
      {
        label: "Missed",
        value: (r) => fmt(S(r)?.missed, 0),
        diff: (r) => S(r)?.missed ?? null,
        better: "lower",
        digits: 0
      },
      {
        label: "Hit rate",
        value: (r) => fmt(hitRate(r), 0, "%"),
        diff: hitRate,
        unit: "%",
        better: "higher",
        digits: 0
      },
      {
        label: "HIVE tips",
        value: (r) => fmt(S(r)?.hiveTips, 0),
        diff: (r) => S(r)?.hiveTips ?? null,
        better: "higher",
        digits: 0
      }
    ]
  },
  {
    title: "Timing (s after START)",
    rows: [
      {
        label: "First shot",
        value: (r) => fmt(S(r)?.firstShot, 1, " s"),
        diff: (r) => S(r)?.firstShot ?? null,
        unit: " s",
        better: "lower"
      },
      {
        label: "Last shot",
        value: (r) => fmt(S(r)?.lastShot, 1, " s"),
        diff: (r) => S(r)?.lastShot ?? null,
        unit: " s",
        better: "lower"
      },
      {
        label: "Last leg change",
        value: (r) => fmt(S(r)?.lastLegChange, 1, " s"),
        diff: (r) => S(r)?.lastLegChange ?? null,
        unit: " s",
        better: "lower"
      },
      {
        label: "Stopped",
        value: (r) => fmt(S(r)?.idle, 1, " s"),
        diff: (r) => S(r)?.idle ?? null,
        unit: " s",
        better: "lower"
      }
    ]
  },
  {
    title: "Driving (auto period)",
    rows: [
      {
        label: "Path length",
        value: (r) => fmt(S(r)?.pathLength, 2, " m"),
        diff: (r) => S(r)?.pathLength ?? null,
        unit: " m",
        digits: 2
      },
      {
        label: "Top speed",
        value: (r) => fmt(S(r)?.topSpeed, 2, " m/s"),
        diff: (r) => S(r)?.topSpeed ?? null,
        unit: " m/s",
        digits: 2
      },
      {
        label: "Avg speed (moving)",
        value: (r) => fmt(S(r)?.avgSpeed, 2, " m/s"),
        diff: (r) => S(r)?.avgSpeed ?? null,
        unit: " m/s",
        digits: 2
      }
    ]
  },
  {
    title: "Now (at the playhead)",
    rows: [
      { label: "Leg", value: (r) => r.live?.leg ?? "—" },
      { label: "Speed", value: (r) => fmt(r.live?.speed, 2, " m/s") },
      {
        label: "Scored / shots so far",
        value: (r) => (r.live ? r.live.scoredSoFar + " / " + r.live.shotsSoFar : "—"),
        diff: (r) => r.live?.scoredSoFar ?? null,
        better: "higher",
        digits: 0
      }
    ]
  }
];

/** Up to three 3D fields side by side (Multi Field / Multisim tab), with the run comparison under them. */
export default class MultiFieldRenderer implements TabRenderer {
  private ROOT: HTMLElement;
  private GRID: HTMLElement;
  private COMPARE: HTMLElement;
  private cells: { element: HTMLElement; label: HTMLElement; empty: HTMLElement; renderer: Field3dRenderer }[] = [];
  private restoreCache: unknown[] = [];
  private compareKey = "";
  private valueCells: HTMLElement[] = [];

  constructor(root: HTMLElement) {
    this.ROOT = root;
    this.GRID = document.createElement("div");
    this.GRID.className = "multifield-grid";
    this.COMPARE = document.createElement("div");
    this.COMPARE.className = "multisim-compare";
    this.COMPARE.hidden = true;
    root.append(this.GRID, this.COMPARE);
  }

  saveState(): unknown {
    return { cameras: this.cells.map((cell) => cell.renderer.saveState()) };
  }

  restoreState(state: unknown): void {
    const cameras = (state as { cameras?: unknown[] } | null)?.cameras;
    if (!Array.isArray(cameras)) return;
    this.restoreCache = cameras;
    this.cells.forEach((cell, i) => {
      if (i < cameras.length && cameras[i] !== null) cell.renderer.restoreState(cameras[i]);
    });
  }

  getAspectRatio(): number | null {
    return null;
  }

  private addCell() {
    const template = document.getElementById("renderer3");
    if (template === null) return;
    const element = document.createElement("div");
    element.className = "multifield-cell";
    const view = template.cloneNode(true) as HTMLElement;
    view.removeAttribute("id");
    view.className = "multifield-view";
    const label = document.createElement("div");
    label.className = "multifield-cell-label";
    const empty = document.createElement("div");
    empty.className = "multifield-empty";
    const emptyTitle = document.createElement("div");
    emptyTitle.className = "multifield-empty-title";
    emptyTitle.textContent = "No run here yet";
    const emptyText = document.createElement("div");
    emptyText.textContent =
      "Press “▶ Run autos…” to simulate up to 3 autos, or “Choose run…” to show runs you already have.";
    empty.append(emptyTitle, emptyText);
    element.append(view, label, empty);
    this.GRID.appendChild(element);
    const renderer = new Field3dRenderer(view);
    const index = this.cells.length;
    if (index < this.restoreCache.length && this.restoreCache[index] !== null) {
      renderer.restoreState(this.restoreCache[index]);
    }
    this.cells.push({ element, label, empty, renderer });
  }

  private removeCell() {
    const cell = this.cells.pop();
    if (cell === undefined) return;
    // Free the WebGL context now rather than waiting for garbage collection
    const canvas = cell.element.getElementsByTagName("canvas")[0];
    const gl = canvas?.getContext("webgl2") ?? canvas?.getContext("webgl");
    gl?.getExtension("WEBGL_lose_context")?.loseContext();
    cell.element.remove();
  }

  /** Builds the compare table for these runs (only when the set of runs changes). */
  private buildCompare(runs: MultisimRunView[]) {
    this.COMPARE.replaceChildren();
    this.valueCells = [];
    const table = document.createElement("table");
    table.className = "multisim-table";
    const head = table.createTHead().insertRow();
    head.appendChild(document.createElement("th"));
    runs.forEach((run, i) => {
      const th = document.createElement("th");
      th.style.borderBottomColor = run.color;
      const swatch = document.createElement("span");
      swatch.className = "multisim-swatch";
      swatch.style.background = run.color;
      th.append(swatch, String.fromCharCode(65 + i) + " · " + run.title);
      head.appendChild(th);
    });
    const body = table.createTBody();
    const addGroup = (title: string) => {
      const groupRow = body.insertRow();
      groupRow.className = "multisim-group";
      const cell = groupRow.insertCell();
      cell.colSpan = runs.length + 1;
      cell.textContent = title;
    };
    const addRow = (labelText: string) => {
      const tr = body.insertRow();
      const label = tr.insertCell();
      label.className = "multisim-label";
      label.textContent = labelText;
      runs.forEach(() => this.valueCells.push(tr.insertCell()));
    };
    for (const group of GROUPS) {
      addGroup(group.title);
      group.rows.forEach((row) => addRow(row.label));
    }
    if (runs.length > 1) {
      addGroup("Gap between robots now");
      addRow("Distance from A");
    }
    this.COMPARE.appendChild(table);
  }

  private renderCompare(runs: MultisimRunView[] | null | undefined) {
    const show = Array.isArray(runs) && runs.length > 0;
    this.COMPARE.hidden = !show;
    this.ROOT.classList.toggle("multisim-with-compare", show);
    if (!show || runs === null || runs === undefined) return;
    const key = runs.map((run) => run.title + "|" + run.color).join(";");
    if (key !== this.compareKey) {
      this.compareKey = key;
      this.buildCompare(runs);
    }

    const base = runs[0];
    let index = 0;
    const set = (text: string, className = "") => {
      const cell = this.valueCells[index++];
      if (cell === undefined) return;
      if (cell.textContent !== text) cell.textContent = text;
      if (cell.className !== className) cell.className = className;
    };
    for (const group of GROUPS) {
      for (const row of group.rows) {
        runs.forEach((run, i) => {
          let text = run.summary === null ? "—" : row.value(run);
          let className = "";
          if (i > 0 && row.diff !== undefined && run.summary !== null && base.summary !== null) {
            const a = row.diff(base);
            const b = row.diff(run);
            if (a !== null && b !== null) {
              const delta = b - a;
              const digits = row.digits ?? 1;
              if (Math.abs(delta) >= Math.pow(10, -digits) / 2) {
                text += "  (" + (delta > 0 ? "+" : "−") + Math.abs(delta).toFixed(digits) + (row.unit ?? "") + ")";
                if (row.better !== undefined) {
                  const good = row.better === "higher" ? delta > 0 : delta < 0;
                  className = good ? "multisim-better" : "multisim-worse";
                }
              }
            }
          }
          set(text, className);
        });
      }
    }
    if (runs.length > 1) {
      const origin = base.live?.position ?? null;
      runs.forEach((run, i) => {
        const p = run.live?.position ?? null;
        if (i === 0) set("—");
        else set(origin !== null && p !== null ? fmt(Math.hypot(p[0] - origin[0], p[1] - origin[1]), 2, " m") : "—");
      });
    }
  }

  render(command: MultiFieldRendererCommand): void {
    if (command === null || command === undefined || !Array.isArray(command.panes)) return;
    const count = command.panes.length;
    while (this.cells.length < count) this.addCell();
    while (this.cells.length > count) this.removeCell();
    this.GRID.style.gridTemplateColumns = "repeat(" + Math.max(1, count) + ", minmax(0, 1fr))";
    command.panes.forEach((pane, i) => {
      const cell = this.cells[i];
      if (cell === undefined) return;
      if (cell.label.textContent !== pane.title) cell.label.textContent = pane.title;
      const color = command.overlay ? "" : command.runs?.[i]?.color ?? "";
      if (cell.label.style.borderLeftColor !== color) cell.label.style.borderLeftColor = color;
      cell.empty.hidden = !pane.empty;
      cell.renderer.render(pane.command);
    });
    this.renderCompare(command.runs);
  }
}
