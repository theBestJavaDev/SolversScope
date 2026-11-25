// Copyright (c) 2021-2026 Littleton Robotics & FTC Team 23511 Seattle Solvers
// http://github.com/Mechanical-Advantage
//
// Use of this source code is governed by a BSD
// license that can be found in the LICENSE file
// at the root directory of this project.

import { TabsState } from "../shared/HubState";
import LoggableType from "../shared/log/LoggableType";
import TabType, { SOLVERS_TAB_TYPES } from "../shared/TabType";
import { createUUID } from "../shared/util";
import { applyFlowerAnimation } from "./flowerAnim";

/**
 * Opening a BioBuzz SimLoop log (the robot repo's `simAuto` / sim tests) with no field views set up
 * shows only an empty field, which looks like the run did nothing. When such a log loads and no
 * field or graph tab has anything assigned, this adds the team's sim layout (www/layouts/biobuzz-sim.json,
 * a copy of the robot repo's sim/advantagescope/layout.json): 3D + 2D field with the robot, POLLEN in
 * flight, HIVE tips and shot arcs, plus the mechanism and graph tabs. Then it plays the run from START.
 * Tabs the user configured, and the SolversScope tools, are kept. In plain AdvantageScope mode
 * (View menu) no Auto Check tab is added.
 */

/** Present in every BioBuzz SimLoop RLOG (the true robot pose for the field views). */
const SIM_ROBOT_KEY = "RealOutputs/Field/Robot";
const LEG_KEY = "RealOutputs/Auto/leg";
export const SIM_LAYOUT_URL = "layouts/biobuzz-sim.json";

let lastHandledLog: string | null = null;

/** Tab types that are empty views until fields are assigned. */
const VIEW_TYPES = [TabType.LineGraph, TabType.Field2d, TabType.Field3d, TabType.Mechanism];

function isUnconfiguredView(tab: TabsState["tabs"][number]): boolean {
  if (!VIEW_TYPES.includes(tab.type)) return false;
  const controller = tab.controller as Record<string, unknown> | null;
  if (controller === null || typeof controller !== "object") return true;
  const lists = ["sources", "leftSources", "rightSources", "discreteSources"]
    .map((key) => controller[key])
    .filter((value): value is unknown[] => Array.isArray(value));
  return lists.every((list) => list.length === 0);
}

/** The sim layout's 3D field: the 2026-2027 field without its fixed HIVE bars and staged balls. */
export const TIPPING_FIELD_ID = "FTC:BioBuzz Sim Field";
const HIVE_SOURCE_KEY = "RealOutputs/Field/HiveRed";
/** HIVE pose sources and the robot models (made by make_field_model.py) that draw them; a missing one draws nothing. */
const HIVE_MODELS: Record<string, string> = {
  "RealOutputs/Field/HiveRed": "BioBuzz HIVE Red",
  "RealOutputs/Field/HiveBlue": "BioBuzz HIVE Blue"
};

/**
 * Puts the HIVE model names back on the HIVE pose sources. Older builds swapped in the robot CAD when
 * the HIVE models were missing or loaded late (a robot drawn inside each HIVE), and that was saved.
 */
function restoreHiveModels() {
  const state = window.tabs.saveState();
  let changed = false;
  for (const tab of state.tabs) {
    if (tab.type !== TabType.Field3d) continue;
    const controller = tab.controller as { sources?: { logKey: string; options?: Record<string, string> }[] } | null;
    if (controller === null || !Array.isArray(controller.sources)) continue;
    for (const source of controller.sources) {
      const model = HIVE_MODELS[source.logKey];
      if (model !== undefined && source.options !== undefined && source.options.model !== model) {
        source.options.model = model;
        changed = true;
      }
    }
  }
  if (changed) window.tabs.restoreState(state);
}

/**
 * Saved 3D tabs can still point at `/SolversSim/Anim/<name>` sources (HIVE tips, POLLEN, NECTAR) that an older
 * build wrote into the log. When this log has no such key the source draws nothing (the HIVEs vanish), so point it
 * back at the log's own `RealOutputs/Field/<name>`.
 */
const STALE_ANIM_PREFIX = "/SolversSim/Anim/";
/** NECTAR is its own game piece (red / blue, 3.6 in); older saved tabs drew it with the POLLEN model. */
const NECTAR_VARIANTS: Record<string, string> = {
  "RealOutputs/Field/NectarRed": "Nectar (Red)",
  "RealOutputs/Field/NectarBlue": "Nectar (Blue)"
};
function restoreRealSources() {
  const keys = new Set(window.log.getFieldKeys());
  const state = window.tabs.saveState();
  let changed = false;
  for (const tab of state.tabs) {
    if (tab.type !== TabType.Field3d) continue;
    const controller = tab.controller as {
      sources?: { logKey: string; options?: Record<string, string> }[];
      game?: string;
    } | null;
    if (controller === null || !Array.isArray(controller.sources)) continue;
    const field = (window.assets?.field3ds ?? []).find((f) => f.id === controller.game);
    for (const source of controller.sources) {
      if (source.logKey.startsWith(STALE_ANIM_PREFIX) && !keys.has(source.logKey)) {
        const real = "RealOutputs/Field/" + source.logKey.slice(STALE_ANIM_PREFIX.length);
        if (keys.has(real)) {
          source.logKey = real;
          changed = true;
        }
      }
      const variant = NECTAR_VARIANTS[source.logKey];
      if (
        variant !== undefined &&
        source.options !== undefined &&
        source.options.variant !== variant &&
        (field === undefined || field.gamePieces.some((piece) => piece.name === variant))
      ) {
        source.options.variant = variant;
        changed = true;
      }
    }
  }
  if (changed) window.tabs.restoreState(state);
}

/** Auto Check's random match: missed shots (as POLLEN) and their red trails (AutoCheckController.MATCH_MISSES_KEY). */
const MATCH_MISSES_KEY = "/SolversSim/AutoCheck/Match/Misses";
const MATCH_TRAIL_KEYS = [0, 1, 2, 3].map((i) => "/SolversSim/AutoCheck/Match/Trail" + i);

/** Adds the random match's missed shots to the sim 3D views (once), so misses show on the field. */
function addMatchMissesSource() {
  const state = window.tabs.saveState();
  let changed = false;
  for (const tab of state.tabs) {
    if (tab.type !== TabType.Field3d) continue;
    const controller = tab.controller as { sources?: Record<string, unknown>[] } | null;
    if (controller === null || !Array.isArray(controller.sources)) continue;
    if (!controller.sources.some((source) => source.logKey === HIVE_SOURCE_KEY)) continue;
    if (controller.sources.some((source) => source.logKey === MATCH_MISSES_KEY)) continue;
    controller.sources.push({
      type: "gamePiece",
      logKey: MATCH_MISSES_KEY,
      logType: "Translation3d[]",
      visible: true,
      options: { variant: "Pollen" }
    });
    for (const key of MATCH_TRAIL_KEYS) {
      controller.sources.push({
        type: "trajectory",
        logKey: key,
        logType: "Translation3d[]",
        visible: true,
        options: { color: "#ff3b30", size: "bold" }
      });
    }
    changed = true;
  }
  if (changed) window.tabs.restoreState(state);
}

/** Robot pose sources the team's CAD draws (true pose + belief ghost). */
const ROBOT_SOURCE_KEYS = [SIM_ROBOT_KEY, "RealOutputs/Field/RobotBelief"];
/** Bundled / downloaded stock robots: fine, but not the team's robot. */
const GENERIC_ROBOT_PATH = /Robot_FTCSimpleDriveBase|Robot_FRCKitBot|[\\/]lite[\\/]static[\\/]bundledAssets[\\/]/;
export const TEAM_CAD = "BioBuzz CAD";
let askedForCad = false;
let robotCheckPending = false;

/** Called when the asset list arrives: a sim log that opened first still gets the team CAD. */
export function retryRobotModelCheck() {
  if (robotCheckPending && !window.preferences?.plainMode) checkRobotModel();
}

/** Sets the robot model on the 3D tabs' robot + ghost sources for this sim log. */
export function useRobotModel(model: string) {
  const state = window.tabs.saveState();
  let changed = false;
  for (const tab of state.tabs) {
    if (tab.type !== TabType.Field3d) continue;
    const controller = tab.controller as { sources?: { logKey: string; options?: Record<string, string> }[] } | null;
    if (controller === null || !Array.isArray(controller.sources)) continue;
    for (const source of controller.sources) {
      if (ROBOT_SOURCE_KEYS.includes(source.logKey) && source.options !== undefined && source.options.model !== model) {
        source.options.model = model;
        changed = true;
      }
    }
  }
  if (changed) window.tabs.restoreState(state);
}

/**
 * The sim robot should be drawn with a team CAD. If it is on a generic or missing model, switch to an
 * installed team CAD (BioBuzz CAD first); with none installed, ask once per session for one (main
 * process, robotCad.ts). Keeping the default robot is fine: the view still works.
 */
function checkRobotModel() {
  const robots = window.assets?.robots;
  if (robots === undefined) {
    robotCheckPending = true; // assets not here yet: retried from `retryRobotModelCheck`
    return;
  }
  robotCheckPending = false;
  const isTeamCad = (name: string | undefined) => {
    const robot = robots.find((r) => r.name === name);
    return (
      robot !== undefined &&
      robot.isFTC &&
      !GENERIC_ROBOT_PATH.test(robot.path) &&
      !Object.values(HIVE_MODELS).includes(robot.name)
    );
  };
  let current: string | undefined = undefined;
  for (const tab of window.tabs.saveState().tabs) {
    if (tab.type !== TabType.Field3d) continue;
    const controller = tab.controller as { sources?: { logKey: string; options?: Record<string, string> }[] } | null;
    const source = controller?.sources?.find((s) => s.logKey === SIM_ROBOT_KEY);
    if (source !== undefined) current = source.options?.model;
  }
  if (current === undefined || isTeamCad(current)) return;
  const teamCads = robots.filter((r) => isTeamCad(r.name)).map((r) => r.name);
  if (teamCads.length > 0) {
    useRobotModel(teamCads.includes(TEAM_CAD) ? TEAM_CAD : teamCads[0]);
  } else if (!askedForCad && !window.preferences?.skipRobotCadPrompt) {
    askedForCad = true;
    window.sendMainMessage("prompt-robot-cad");
  }
}

/** Plain AdvantageScope mode: closes SolversScope's own tabs (Shot Lab, Drive Sim, Telemetry, Auto Check). */
export function removeSolversTabs() {
  const state = window.tabs.saveState();
  const selected = state.tabs[state.selected];
  const tabs = state.tabs.filter((tab) => !SOLVERS_TAB_TYPES.includes(tab.type));
  if (tabs.length === state.tabs.length) return;
  const index = tabs.indexOf(selected);
  window.tabs.restoreState({ selected: index >= 0 ? index : 0, tabs: tabs });
}

/**
 * 3D tabs that draw the sim's HIVEs should sit on the tipping field (made by the robot repo's
 * make_field_model.py). The stock field has the HIVE bars fixed in place and staged balls of its own,
 * so tips would not show and balls would be doubled. A restore can land on the stock field when the
 * field list was not loaded yet, so this checks every time a sim log opens. No-op if the tipping
 * field is not installed on this computer.
 */
function useTippingField() {
  if (!(window.assets?.field3ds ?? []).some((field) => field.id === TIPPING_FIELD_ID)) return;
  const state = window.tabs.saveState();
  let changed = false;
  for (const tab of state.tabs) {
    if (tab.type !== TabType.Field3d) continue;
    const controller = tab.controller as { sources?: { logKey: string }[]; game?: string } | null;
    if (controller === null || !Array.isArray(controller.sources)) continue;
    if (!controller.sources.some((source) => source.logKey === HIVE_SOURCE_KEY)) continue;
    if (controller.game !== TIPPING_FIELD_ID) {
      controller.game = TIPPING_FIELD_ID;
      changed = true;
    }
  }
  if (changed) window.tabs.restoreState(state);
}

/** Puts an Auto Check tab next to the sim views (once), so every sim log gets its shots checked. */
function addAutoCheckTab() {
  const state = window.tabs.saveState();
  if (state.tabs.some((tab) => tab.type === TabType.AutoCheck)) return;
  state.tabs.push({
    type: TabType.AutoCheck,
    title: "",
    controller: null,
    controllerUUID: createUUID(),
    renderer: null,
    controlsHeight: 0
  } as TabsState["tabs"][number]);
  window.tabs.restoreState(state);
}

/** When the run starts: the auto's START (after INIT), else the start of the log. */
function startTime(): number {
  const range = window.log.getTimestampRange();
  if (window.log.getType(LEG_KEY) === LoggableType.String) {
    const legs = window.log.getString(LEG_KEY, -Infinity, Infinity);
    if (legs !== undefined) {
      const index = legs.values.findIndex((value) => value === "START");
      if (index >= 0) return legs.timestamps[index];
    }
  }
  return range[0];
}

/**
 * Called when a log finishes its initial decode. Applies the sim layout if this is a BioBuzz sim
 * log and nothing is set up to show it, then plays from START.
 *
 * @param logName name of the opened log, so each log is only handled once
 */
export async function maybeApplySimLayout(logName: string): Promise<void> {
  if (logName === lastHandledLog) return;
  if (!window.log.getFieldKeys().includes(SIM_ROBOT_KEY)) return;
  lastHandledLog = logName;

  const current = window.tabs.saveState();
  const fieldTabs = current.tabs.filter((tab) => tab.type === TabType.Field2d || tab.type === TabType.Field3d);
  const alreadySetUp = fieldTabs.some((tab) => !isUnconfiguredView(tab));

  if (!alreadySetUp) {
    let layout: { hubs?: { state?: { tabs?: TabsState } }[] };
    try {
      const response = await fetch(SIM_LAYOUT_URL);
      layout = await response.json();
    } catch (error) {
      console.error("Could not load the BioBuzz sim layout", error);
      return;
    }
    const simTabs = layout.hubs?.[0]?.state?.tabs;
    if (simTabs === undefined) return;

    // Keep the user's tools and configured tabs; drop only empty views. The layout's own
    // documentation tab is skipped when one already exists.
    const kept = current.tabs.filter((tab) => !isUnconfiguredView(tab));
    const hasDocs = kept.some((tab) => tab.type === TabType.Documentation);
    const added = simTabs.tabs.filter((tab) => !(hasDocs && tab.type === TabType.Documentation));
    const merged: TabsState = {
      selected: 0,
      tabs: [...kept, ...added]
    };
    const field3d = merged.tabs.findIndex((tab, i) => i >= kept.length && tab.type === TabType.Field3d);
    merged.selected = field3d >= 0 ? field3d : kept.length;
    window.tabs.restoreState(merged);
  }

  useTippingField();
  restoreRealSources();
  restoreHiveModels();
  if (!window.preferences?.plainMode) {
    // POLLEN rolls down a FLOWER and into the robot when the pollinator takes it, instead of vanishing and reappearing
    try {
      applyFlowerAnimation();
    } catch (error) {
      console.error("FLOWER pickup animation failed", error);
    }
  }
  if (window.preferences?.plainMode) {
    removeSolversTabs();
  } else {
    addAutoCheckTab();
    addMatchMissesSource();
    checkRobotModel();
  }

  // Nothing is drawn until a time is selected: play the run from START
  window.selection.setSelectedTime(startTime());
  window.selection.play();
}
