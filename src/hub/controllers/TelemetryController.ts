// Copyright (c) 2021-2026 Littleton Robotics & FTC Team 23511 Seattle Solvers
// http://github.com/Mechanical-Advantage
//
// Use of this source code is governed by a BSD
// license that can be found in the LICENSE file
// at the root directory of this project.

import { recorder } from "../cinematic/Recorder";
import LoggableType from "../../shared/log/LoggableType";
import { SHOT_LAB_LOG_PREFIX } from "../../shared/physics/ShotLab";
import { TelemetryMetric, TelemetryRendererCommand } from "../../shared/renderers/TelemetryRenderer";
import { createUUID } from "../../shared/util";
import { autoCheckMarkdown, getLatestAutoCheck } from "../autoCheckStore";
import { TELEMETRY_LINES_KEY } from "../dataSources/ftcdashboard/FTCDashboardSource";
import { buildTelemetryReport } from "../telemetryReport";
import { DRIVE_SIM_LOG_PREFIX } from "./DriveSimController";
import TabController from "./TabController";

type SourceId = "auto" | "ftc" | "robot" | "drive" | "shotlab" | "all";

const SOURCE_LABELS: Record<SourceId, string> = {
  auto: "Automatic",
  ftc: "FTC Dashboard telemetry",
  robot: "Robot code (RealOutputs)",
  drive: "Drive Sim",
  shotlab: "Shot Lab",
  all: "Everything in the log"
};

const MAX_METRICS = 48;
const HISTORY_POINTS = 80;
const STATUS_PREFIX = "/_Status/";
const ROBOT_PREFIX = "RealOutputs/";
const ROBOT_LEG_KEY = "RealOutputs/Auto/leg";
const ROBOT_OPMODE_KEY = "RealMetadata/OpMode";
/** Root tables AdvantageKit / PsiKit robot logs write (never FTC Dashboard telemetry). */
const ROBOT_TABLES =
  /^(Real|Replay)(Outputs|Metadata)\/|^(SystemStats|DriverStation|PowerDistribution|Timestamp|AdvantageKit|PsiKit)(\/|$)/;
/** Robot-code keys that are drawings/poses, not telemetry (struct parts, field and mechanism views). */
const ROBOT_SKIP = /(^RealOutputs\/Field\/|\/Mechanisms\/|\/translation\/|\/rotation\/|\/length$)/;

type State = { source: SourceId; filter: string; windowSec: number };

/**
 * Driver Station-style telemetry view: FTC Dashboard telemetry lines (or simulator output) at the
 * current timeline time, plus a live card with sparkline + stats for every numeric field.
 */
export default class TelemetryController implements TabController {
  UUID = createUUID();

  private SOURCE: HTMLSelectElement;
  private FILTER: HTMLInputElement;
  private WINDOW: HTMLSelectElement;
  private RECORD: HTMLButtonElement;
  private DOWNLOAD: HTMLButtonElement;
  private REC_STATUS: HTMLElement;
  /** Report window: set by Record / Stop. */
  private record: { start: number | null; end: number | null; recording: boolean } = {
    start: null,
    end: null,
    recording: false
  };
  private state: State = { source: "auto", filter: "", windowSec: 10 };

  constructor(root: HTMLElement) {
    this.SOURCE = root.getElementsByClassName("telemetry-source")[0] as HTMLSelectElement;
    this.FILTER = root.getElementsByClassName("telemetry-filter")[0] as HTMLInputElement;
    this.WINDOW = root.getElementsByClassName("telemetry-window")[0] as HTMLSelectElement;
    (Object.keys(SOURCE_LABELS) as SourceId[]).forEach((id) => {
      const option = document.createElement("option");
      option.value = id;
      option.innerText = SOURCE_LABELS[id];
      this.SOURCE.appendChild(option);
    });
    this.SOURCE.addEventListener("change", () => (this.state.source = this.SOURCE.value as SourceId));
    this.FILTER.addEventListener("input", () => (this.state.filter = this.FILTER.value));
    this.WINDOW.addEventListener("change", () => (this.state.windowSec = Number(this.WINDOW.value)));
    this.RECORD = root.getElementsByClassName("telemetry-record")[0] as HTMLButtonElement;
    this.DOWNLOAD = root.getElementsByClassName("telemetry-download")[0] as HTMLButtonElement;
    this.REC_STATUS = root.getElementsByClassName("telemetry-rec-status")[0] as HTMLElement;
    this.RECORD.addEventListener("click", () => this.toggleRecord());
    this.DOWNLOAD.addEventListener("click", () => this.downloadReport());
    this.syncInputs();
    this.updateRecordUi();
  }

  // -------------------------------------------------------------------------------------------
  // Recording + Markdown report
  // -------------------------------------------------------------------------------------------

  /** The newest time with data: the live time when connected, else the timeline's time or the log end. */
  private now(): number {
    return (
      window.selection.getCurrentLiveTime() ?? window.selection.getRenderTime() ?? window.log.getTimestampRange()[1]
    );
  }

  private toggleRecord() {
    // Shared with the cinematic command server (record_start / record_stop)
    if (this.record.recording) recorder.stop();
    else recorder.start();
    this.updateRecordUi();
  }

  private updateRecordUi() {
    this.record = recorder.get();
    const r = this.record;
    this.RECORD.innerText = r.recording ? "■ Stop" : "● Record";
    this.RECORD.classList.toggle("recording", r.recording);
    let status = "Report: whole log";
    if (r.recording && r.start !== null) {
      status = "Recording · " + Math.max(0, this.now() - r.start).toFixed(1) + " s";
    } else if (r.start !== null && r.end !== null) {
      status = "Report: recorded " + (r.end - r.start).toFixed(1) + " s";
    }
    if (this.REC_STATUS.textContent !== status) this.REC_STATUS.textContent = status;
  }

  /** Builds the Markdown report for the recorded window (or the whole log) and asks where to save it. */
  private downloadReport() {
    const keys = window.log.getFieldKeys();
    if (keys.length === 0) {
      window.sendMainMessage("error", {
        title: "Nothing to report",
        content: "Open a log, connect to the robot, or record a sim run first."
      });
      return;
    }
    const range = window.log.getTimestampRange();
    const recorded = this.record.start !== null;
    const start = recorded ? this.record.start! : range[0];
    const end = this.record.recording ? this.now() : recorded && this.record.end !== null ? this.record.end : range[1];
    const source = this.resolveSource(keys);
    const finalCommand = this.buildCommand(end, false);

    // OpMode / states seen in the window (FTC Dashboard OpMode state, or the robot code's auto legs)
    let opMode: string | null = finalCommand.header.opMode;
    const stateKey = source === "robot" ? ROBOT_LEG_KEY : STATUS_PREFIX + "activeOpModeStatus";
    const states: string[] = [];
    const stateSet =
      window.log.getType(stateKey) === LoggableType.String ? window.log.getString(stateKey, start, end) : undefined;
    stateSet?.values.forEach((v, i) => {
      if (stateSet.timestamps[i] <= end && v.length > 0 && states[states.length - 1] !== v) states.push(v);
    });
    if (source === "robot" && opMode === null) opMode = "Robot code";

    // Battery, from whichever source has it
    let battery: { start: number; min: number; end: number } | null = null;
    for (const key of [STATUS_PREFIX + "batteryVoltage", DRIVE_SIM_LOG_PREFIX + "/BatteryVolts"]) {
      if (window.log.getType(key) !== LoggableType.Number) continue;
      const set = window.log.getNumber(key, start, end);
      const values = set?.values.filter((v) => v > 0) ?? [];
      if (values.length === 0) continue;
      battery = { start: values[0], min: Math.min(...values), end: values[values.length - 1] };
      break;
    }

    // Window title is "<log> — SolversScope"; keep just the file name
    const title = (document.title.split(" — ")[0].split(/[\\/]/).pop() ?? "").trim();
    const logName = title.length > 0 && !title.startsWith("SolversScope") ? title : "Live session";
    let content = buildTelemetryReport({
      logName,
      sourceLabel: SOURCE_LABELS[source],
      fields: this.selectFields(keys, source),
      start,
      end,
      windowKind: recorded ? "recorded" : "full log",
      finalLines: finalCommand.lines.map((l) => ({ label: l.label, value: l.value })),
      freeLines: finalCommand.freeLines,
      opMode,
      states,
      battery
    });
    const autoCheck = getLatestAutoCheck();
    if (autoCheck !== null && source === "robot") content += "\n" + autoCheckMarkdown(autoCheck);
    const stamp = new Date().toISOString().slice(0, 16).replace("T", " ").replace(":", "-");
    const base = logName.replace(/\.[a-z0-9]+$/i, "").replace(/[\\/:*?"<>|]+/g, "_");
    window.sendMainMessage("export-telemetry-report", {
      fileName: "Telemetry " + base + " " + stamp + ".md",
      content
    });
  }

  private syncInputs() {
    this.SOURCE.value = this.state.source;
    this.FILTER.value = this.state.filter;
    this.WINDOW.value = this.state.windowSec.toString();
  }

  // -------------------------------------------------------------------------------------------
  // Field selection
  // -------------------------------------------------------------------------------------------

  private isFtcKey(key: string): boolean {
    // FTC Dashboard telemetry.addData() values are logged at the root without a leading slash.
    // Robot-code logs (AdvantageKit / PsiKit) also use slash-less root tables; those are not telemetry
    // lines ("RealOutputs/..." is the "robot" source)
    return !key.startsWith("/") && key !== "RUNNING" && !ROBOT_TABLES.test(key);
  }

  private resolveSource(keys: string[]): Exclude<SourceId, "auto"> {
    if (this.state.source !== "auto") return this.state.source;
    if (keys.some((k) => this.isFtcKey(k))) return "ftc";
    if (keys.some((k) => k.startsWith(ROBOT_PREFIX))) return "robot";
    if (keys.some((k) => k.startsWith(DRIVE_SIM_LOG_PREFIX + "/"))) return "drive";
    if (keys.some((k) => k.startsWith(SHOT_LAB_LOG_PREFIX + "/"))) return "shotlab";
    return "all";
  }

  private selectFields(keys: string[], source: Exclude<SourceId, "auto">): { key: string; label: string }[] {
    const valueTypes = [LoggableType.Number, LoggableType.Boolean, LoggableType.String];
    let prefix = "";
    let match: (key: string) => boolean;
    switch (source) {
      case "ftc":
        match = (k) => this.isFtcKey(k);
        break;
      case "robot":
        prefix = ROBOT_PREFIX;
        match = (k) => k.startsWith(ROBOT_PREFIX) && !ROBOT_SKIP.test(k);
        break;
      case "drive":
        prefix = DRIVE_SIM_LOG_PREFIX + "/";
        match = (k) => k.startsWith(prefix);
        break;
      case "shotlab":
        prefix = SHOT_LAB_LOG_PREFIX + "/";
        match = (k) => k.startsWith(prefix);
        break;
      case "all":
        match = (k) => !k.startsWith("/_Config") && !k.startsWith(STATUS_PREFIX) && k !== "RUNNING";
        break;
    }
    const filter = this.state.filter.trim().toLowerCase();
    return keys
      .filter((k) => match(k) && k !== TELEMETRY_LINES_KEY)
      .filter((k) => valueTypes.includes(window.log.getType(k) as LoggableType))
      .map((k) => ({ key: k, label: prefix.length > 0 ? k.slice(prefix.length) : k.replace(/^\//, "") }))
      .filter((f) => filter.length === 0 || f.label.toLowerCase().includes(filter));
  }

  // -------------------------------------------------------------------------------------------
  // Value helpers
  // -------------------------------------------------------------------------------------------

  private valueAt(key: string, t: number): any {
    const type = window.log.getType(key);
    let set: { timestamps: number[]; values: any[] } | undefined;
    if (type === LoggableType.Number) set = window.log.getNumber(key, t, t);
    else if (type === LoggableType.Boolean) set = window.log.getBoolean(key, t, t);
    else if (type === LoggableType.String) set = window.log.getString(key, t, t);
    if (set === undefined || set.values.length === 0 || set.timestamps[0] > t) return null;
    return set.values[0];
  }

  /** Step-sampled history over [t - window, t]. */
  private history(key: string, t: number, numeric: boolean): any[] {
    const start = t - this.state.windowSec;
    const set = numeric ? window.log.getNumber(key, start, t) : window.log.getBoolean(key, start, t);
    if (set === undefined || set.values.length === 0) return [];
    const out: any[] = [];
    let j = 0;
    for (let i = 0; i < HISTORY_POINTS; i++) {
      const ts = start + (i / (HISTORY_POINTS - 1)) * (t - start);
      while (j + 1 < set.timestamps.length && set.timestamps[j + 1] <= ts) j++;
      if (set.timestamps[j] <= ts) out.push(set.values[j]);
    }
    return out;
  }

  // -------------------------------------------------------------------------------------------
  // TabController
  // -------------------------------------------------------------------------------------------

  saveState(): unknown {
    return this.state;
  }

  restoreState(state: unknown): void {
    if (typeof state !== "object" || state === null) return;
    const s = state as Partial<State>;
    if (s.source && s.source in SOURCE_LABELS) this.state.source = s.source;
    if (typeof s.filter === "string") this.state.filter = s.filter;
    if (typeof s.windowSec === "number" && s.windowSec > 0) this.state.windowSec = s.windowSec;
    this.syncInputs();
  }

  refresh(): void {}

  newAssets(): void {}

  getActiveFields(): string[] {
    // Every top-level table (matched as key or key + "/"), so all telemetry loads, including
    // robot-code logs whose keys have no leading slash ("RealOutputs/...")
    const roots = new Set<string>([""]);
    for (const key of window.log.getFieldKeys()) {
      const parts = key.split("/");
      roots.add(key.startsWith("/") ? "/" + parts[1] : parts[0]);
    }
    return [...roots];
  }

  showTimeline(): boolean {
    return true;
  }

  getCommand(): TelemetryRendererCommand {
    if (this.record.recording) this.updateRecordUi();
    const range = window.log.getTimestampRange();
    return this.buildCommand(window.selection.getRenderTime() ?? range[1], true);
  }

  /** The Driver Station view at time t (metrics + sparklines only when drawing). */
  private buildCommand(t: number, withMetrics: boolean): TelemetryRendererCommand {
    const keys = window.log.getFieldKeys();
    const header: TelemetryRendererCommand["header"] = {
      title: "",
      opMode: null,
      state: null,
      battery: null,
      warning: null,
      error: null,
      time: null
    };
    const empty = (text: string): TelemetryRendererCommand => ({
      header,
      lines: [],
      freeLines: [],
      metrics: [],
      empty: text
    });
    if (keys.length === 0) {
      return empty(
        "No data yet. Connect to the robot with FTC Dashboard running (File → Connect to Robot), " +
          "open a log, or record a run in the Drive Sim tab."
      );
    }

    const source = this.resolveSource(keys);
    header.title = SOURCE_LABELS[source];
    header.time = t;

    // Header: FTC Dashboard status, or the simulator's own name
    if (source === "ftc" || source === "all") {
      const str = (k: string) => {
        const v = this.valueAt(STATUS_PREFIX + k, t);
        return typeof v === "string" && v.length > 0 ? v : null;
      };
      const opMode = str("activeOpMode");
      header.opMode = opMode === "$Stop$Robot$" ? "No OpMode" : opMode;
      header.state = str("activeOpModeStatus");
      const battery = this.valueAt(STATUS_PREFIX + "batteryVoltage", t);
      header.battery = typeof battery === "number" && battery > 0 ? battery : null;
      header.warning = str("warningMessage");
      header.error = str("errorMessage");
    } else if (source === "robot") {
      const leg = this.valueAt(ROBOT_LEG_KEY, t);
      const opModeName = this.valueAt(ROBOT_OPMODE_KEY, t);
      header.opMode = typeof opModeName === "string" && opModeName.length > 0 ? opModeName : "Robot code";
      header.state = typeof leg === "string" && leg.length > 0 ? leg : "SIM";
    } else {
      header.opMode = source === "drive" ? "Drive Sim" : "Shot Lab";
      header.state = "SIM";
      const battery = this.valueAt(DRIVE_SIM_LOG_PREFIX + "/BatteryVolts", t);
      header.battery = source === "drive" && typeof battery === "number" ? battery : null;
    }

    const fields = this.selectFields(keys, source);
    if (fields.length === 0) {
      return {
        ...empty(
          this.state.filter.trim().length > 0
            ? 'No fields match "' + this.state.filter.trim() + '".'
            : "Nothing from " + SOURCE_LABELS[source] + " in this log."
        ),
        header
      };
    }

    const lines: TelemetryRendererCommand["lines"] = [];
    const metrics: TelemetryMetric[] = [];
    for (const field of fields) {
      const value = this.valueAt(field.key, t);
      if (value === null) continue;
      if (typeof value === "number") {
        lines.push({ label: field.label, value: formatLineNumber(value), kind: "number" });
        if (withMetrics && metrics.length < MAX_METRICS) {
          const history = this.history(field.key, t, true).filter((v) => typeof v === "number" && isFinite(v));
          const finite = history.length > 0 ? history : [value];
          metrics.push({
            kind: "number",
            key: field.key,
            label: field.label,
            value,
            history,
            min: Math.min(...finite),
            max: Math.max(...finite),
            mean: finite.reduce((a, b) => a + b, 0) / finite.length
          });
        }
      } else if (typeof value === "boolean") {
        lines.push({ label: field.label, value: value ? "true" : "false", kind: "boolean" });
        if (withMetrics && metrics.length < MAX_METRICS) {
          const history = this.history(field.key, t, false);
          metrics.push({
            kind: "boolean",
            key: field.key,
            label: field.label,
            value,
            trueFraction: history.length > 0 ? history.filter((v) => v === true).length / history.length : value ? 1 : 0
          });
        }
      } else {
        lines.push({ label: field.label, value: String(value), kind: "string" });
      }
    }

    const free = this.valueAt(TELEMETRY_LINES_KEY, t);
    const freeLines = source === "ftc" && typeof free === "string" ? free.split("\n") : [];

    return { header, lines, freeLines, metrics, empty: null };
  }
}

function formatLineNumber(value: number): string {
  if (!isFinite(value)) return String(value);
  if (Number.isInteger(value)) return value.toString();
  return Number(value.toFixed(4)).toString();
}
