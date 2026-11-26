// Copyright (c) 2021-2026 Littleton Robotics & FTC Team 23511 Seattle Solvers
// http://github.com/Mechanical-Advantage
//
// Use of this source code is governed by a BSD
// license that can be found in the LICENSE file
// at the root directory of this project.

import { extractMergePrefix } from "../../shared/log/LogKeyUtils";
import { Field3dRendererCommand, Field3dRendererCommand_GhostObj } from "../../shared/renderers/Field3dRenderer";
import { MultiFieldRendererCommand, MultisimRunView } from "../../shared/renderers/MultiFieldRenderer";
import { createUUID } from "../../shared/util";
import { openAutoPicker } from "../autoPicker";
import { getMultisimLive, getMultisimSummary } from "../multisimStats";
import { openRunPicker } from "../runPicker";
import Field3dController from "./Field3dController";
import TabController from "./TabController";

/** At most this many fields in one Multi Field tab. */
export const MAX_FIELDS = 3;

/** Each run's color (pane label, compare panel column, ghost robot in the overlay). Run A is the team gold. */
export const RUN_COLORS = ["#f2ce00", "#38c6ff", "#ff5cd6"];

export type MultiFieldPaneState = { title: string; field3d: unknown };
export type MultiFieldState = { panes: MultiFieldPaneState[]; overlay?: boolean; showCompare?: boolean };

/**
 * Multi Field tab: up to three 3D fields side by side in one view, all on the same timeline. Each
 * pane is a full 3D Field (its own sources, field, robot model and camera), so it can show a
 * different run (e.g. /Log0 and /Log1 after Compare Runs or "Add New Log(s)") or a different season.
 */
export default class MultiFieldController implements TabController {
  UUID = createUUID();

  private PANES: HTMLElement;
  private ADD_BUTTON: HTMLButtonElement;
  private OVERLAY_BUTTON: HTMLButtonElement;
  private COMPARE_BUTTON: HTMLButtonElement;
  /** Multisim: all robots on one field (the other runs as colored ghosts). */
  private overlay = false;
  /** Multisim: the telemetry compare panel under the fields. */
  private showCompare = true;
  /** Each pane's log prefix (/Log0, "" ...), refreshed now and then. */
  private prefixes: (string | null)[] = [];
  private prefixAge = Infinity;
  private panes: {
    controller: Field3dController;
    element: HTMLElement;
    titleInput: HTMLInputElement;
    detailsOpen: boolean;
  }[] = [];

  constructor(root: HTMLElement) {
    root.classList.add("multifield-controls");
    const toolbar = document.createElement("div");
    toolbar.className = "multifield-toolbar";
    this.ADD_BUTTON = document.createElement("button");
    this.ADD_BUTTON.className = "multifield-button";
    this.ADD_BUTTON.textContent = "+ Add field";
    this.ADD_BUTTON.title = "Add another field (up to " + MAX_FIELDS + ")";
    this.ADD_BUTTON.addEventListener("click", () => this.addPane());
    const runAutos = document.createElement("button");
    runAutos.className = "multifield-button multifield-primary";
    runAutos.textContent = "▶ Run autos…";
    runAutos.title = "Pick up to 3 robot autos: the robot code sim runs them and they play here side by side";
    runAutos.addEventListener("click", () => openAutoPicker(this.UUID));
    const compare = document.createElement("button");
    compare.className = "multifield-button";
    compare.textContent = "Choose runs…";
    compare.title = "Tick up to 3 runs: this tab shows exactly those, one field each";
    compare.addEventListener("click", () => openRunPicker(this.UUID, 0));
    this.OVERLAY_BUTTON = document.createElement("button");
    this.OVERLAY_BUTTON.className = "multifield-button multifield-toggle";
    this.OVERLAY_BUTTON.textContent = "Overlay";
    this.OVERLAY_BUTTON.title = "Show every run's robot on one field (the other runs as colored ghosts)";
    this.OVERLAY_BUTTON.addEventListener("click", () => this.setOverlay(!this.overlay));
    this.COMPARE_BUTTON = document.createElement("button");
    this.COMPARE_BUTTON.className = "multifield-button multifield-toggle";
    this.COMPARE_BUTTON.textContent = "Compare";
    this.COMPARE_BUTTON.title = "Show or hide the telemetry comparison under the fields";
    this.COMPARE_BUTTON.addEventListener("click", () => this.setShowCompare(!this.showCompare));
    const hint = document.createElement("span");
    hint.className = "multifield-hint";
    hint.textContent = "“Run autos…” runs up to 3 autos and plays them side by side.";
    const help = document.createElement("button");
    help.className = "multifield-help";
    help.textContent = "?";
    help.title = "How to compare runs (opens the guide)";
    help.addEventListener("click", () => window.sendMainMessage("open-guide", "compare"));
    toolbar.append(runAutos, compare, this.ADD_BUTTON, this.OVERLAY_BUTTON, this.COMPARE_BUTTON, hint, help);
    this.PANES = document.createElement("div");
    this.PANES.className = "multifield-panes";
    root.append(toolbar, this.PANES);
    this.addPane();
    this.setOverlay(false);
    this.setShowCompare(true);
  }

  private setOverlay(overlay: boolean) {
    this.overlay = overlay;
    this.OVERLAY_BUTTON.classList.toggle("active", overlay);
  }

  private setShowCompare(show: boolean) {
    this.showCompare = show;
    this.COMPARE_BUTTON.classList.toggle("active", show);
  }

  /** Adds a field pane (no-op at the limit). */
  addPane(title?: string, field3dState?: unknown) {
    if (this.panes.length >= MAX_FIELDS) return;
    const template = document.getElementById("controller3");
    if (template === null) return;
    const controls = template.cloneNode(true) as HTMLElement;
    controls.removeAttribute("id");
    controls.classList.add("multifield-pane-controls");

    const element = document.createElement("div");
    element.className = "multifield-pane";
    const header = document.createElement("div");
    header.className = "multifield-pane-header";
    const titleInput = document.createElement("input");
    titleInput.className = "multifield-pane-title";
    titleInput.value = title ?? "Field " + (this.panes.length + 1);
    titleInput.title = "Name shown on this field";
    const choose = document.createElement("button");
    choose.className = "multifield-button multifield-choose";
    choose.textContent = "Choose run…";
    choose.title = "Pick one log for this field, or up to 3 logs to show them all side by side";
    const details = document.createElement("button");
    details.className = "multifield-details";
    details.textContent = "Details ▸";
    details.title = "Show what this field draws and which field model it uses";
    const remove = document.createElement("button");
    remove.className = "multifield-remove";
    remove.textContent = "✕";
    remove.title = "Remove this field";
    header.append(titleInput, choose, details, remove);
    element.append(header, controls);
    this.PANES.appendChild(element);

    const controller = new Field3dController(controls);
    if (field3dState !== undefined) controller.restoreState(field3dState);
    const pane = { controller, element, titleInput, detailsOpen: false };
    this.panes.push(pane);
    const showDetails = (open: boolean) => {
      pane.detailsOpen = open;
      controls.hidden = !open;
      details.textContent = open ? "Details ▾" : "Details ▸";
      if (open) window.tabs?.ensureControlsHeight(this.UUID, 260);
    };
    showDetails(false);
    details.addEventListener("click", () => showDetails(!pane.detailsOpen));
    choose.addEventListener("click", () => openRunPicker(this.UUID, this.panes.indexOf(pane)));
    remove.addEventListener("click", () => this.removePane(this.panes.indexOf(pane)));
    this.updateButtons();
  }

  private removePane(index: number) {
    if (index < 0 || this.panes.length <= 1) return;
    this.panes[index].element.remove();
    this.panes.splice(index, 1);
    this.prefixAge = Infinity;
    this.updateButtons();
  }

  private updateButtons() {
    this.ADD_BUTTON.disabled = this.panes.length >= MAX_FIELDS;
    this.PANES.style.gridTemplateColumns = "repeat(" + this.panes.length + ", minmax(0, 1fr))";
    this.panes.forEach((pane, i) => {
      (pane.element.getElementsByClassName("multifield-remove")[0] as HTMLButtonElement).disabled =
        this.panes.length <= 1;
      pane.titleInput.style.borderLeft = "3px solid " + RUN_COLORS[i % RUN_COLORS.length];
    });
    if (this.OVERLAY_BUTTON !== undefined) this.OVERLAY_BUTTON.disabled = this.panes.length < 2;
  }

  saveState(): MultiFieldState {
    return {
      panes: this.panes.map((pane) => ({ title: pane.titleInput.value, field3d: pane.controller.saveState() })),
      overlay: this.overlay,
      showCompare: this.showCompare
    };
  }

  restoreState(state: unknown): void {
    const panes = (state as MultiFieldState | null)?.panes;
    if (!Array.isArray(panes) || panes.length === 0) return;
    this.panes.forEach((pane) => pane.element.remove());
    this.panes = [];
    panes.slice(0, MAX_FIELDS).forEach((pane) => this.addPane(pane.title, pane.field3d));
    const saved = state as MultiFieldState;
    this.setOverlay(saved.overlay === true && this.panes.length > 1);
    this.setShowCompare(saved.showCompare !== false);
    this.prefixAge = Infinity;
  }

  refresh(): void {
    this.panes.forEach((pane) => pane.controller.refresh());
  }

  newAssets(): void {
    this.panes.forEach((pane) => pane.controller.newAssets());
  }

  getActiveFields(): string[] {
    return this.panes.flatMap((pane) => pane.controller.getActiveFields());
  }

  showTimeline(): boolean {
    return true;
  }

  /** Each pane's log prefix, from its sources' keys (null: nothing assigned). Refreshed every ~half second. */
  private getPrefixes(): (string | null)[] {
    this.prefixAge++;
    if (this.prefixAge < 30 && this.prefixes.length === this.panes.length) return this.prefixes;
    this.prefixAge = 0;
    this.prefixes = this.panes.map((pane) => {
      const sources = (pane.controller.saveState() as { sources?: { logKey: string }[] }).sources ?? [];
      return sources.length === 0 ? null : extractMergePrefix(sources[0].logKey);
    });
    return this.prefixes;
  }

  /** Scoring / timing / driving numbers for each pane's run, plus live values at the playhead. */
  private getRunViews(prefixes: (string | null)[]): MultisimRunView[] {
    const time = window.selection.getRenderTime();
    return this.panes.map((pane, i) => {
      const prefix = prefixes[i];
      const summary = prefix === null ? null : getMultisimSummary(prefix);
      const usable = prefix !== null && summary !== null && summary.isSim;
      return {
        title: pane.titleInput.value,
        color: RUN_COLORS[i % RUN_COLORS.length],
        summary: usable ? summary : null,
        live: usable && time !== null ? getMultisimLive(prefix, summary, time) : null
      };
    });
  }

  /** One field with every run's robot: run A as it is, the others as ghosts in their run colors. */
  private overlayCommand(commands: Field3dRendererCommand[]): Field3dRendererCommand {
    const base = commands[0];
    const objects = [...base.objects];
    const models = new Set(base.allRobotModels);
    // Objects already on run A's field in the same place (e.g. the resting HIVEs before any run loads)
    const onBase = new Set(
      base.objects.filter((object) => object.type === "robot").map((object) => object.model + JSON.stringify(object.poses))
    );
    commands.slice(1).forEach((command, i) => {
      command.objects.forEach((object) => {
        if (object.type !== "robot") return;
        if (onBase.has(object.model + JSON.stringify(object.poses))) return;
        const ghost: Field3dRendererCommand_GhostObj = {
          ...object,
          type: "ghost",
          color: RUN_COLORS[(i + 1) % RUN_COLORS.length]
        };
        objects.push(ghost);
        models.add(object.model);
      });
    });
    return { ...base, objects, allRobotModels: [...models] };
  }

  getCommand(): MultiFieldRendererCommand {
    const panes = this.panes.map((pane) => ({
      title: pane.titleInput.value,
      empty: ((pane.controller.saveState() as { sources?: unknown[] }).sources ?? []).length === 0,
      command: pane.controller.getCommand()
    }));
    const prefixes = this.getPrefixes();
    const runs = this.showCompare ? this.getRunViews(prefixes) : null;
    if (this.overlay && panes.length > 1) {
      return {
        panes: [
          {
            title: "Overlay · " + panes.map((pane) => pane.title).join(" + "),
            empty: panes.every((pane) => pane.empty),
            command: this.overlayCommand(panes.map((pane) => pane.command))
          }
        ],
        overlay: true,
        runs
      };
    }
    return { panes, overlay: false, runs };
  }
}
