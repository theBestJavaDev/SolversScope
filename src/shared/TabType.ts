// Copyright (c) 2021-2026 Littleton Robotics
// http://github.com/Mechanical-Advantage
//
// Use of this source code is governed by a BSD
// license that can be found in the LICENSE file
// at the root directory of this project.

import { Distribution, DISTRIBUTION } from "./buildConstants";

enum TabType {
  Documentation,
  LineGraph,
  Field2d,
  Field3d,
  Table,
  Console,
  Statistics,
  Video,
  Joysticks,
  Swerve,
  Mechanism,
  Points,
  Metadata,
  ShotLab,
  DriveSim,
  Telemetry,
  AutoCheck,
  MultiField
}

export default TabType;

export function getAllTabTypes(): TabType[] {
  return Object.values(TabType).filter((tabType) => typeof tabType === "number") as TabType[];
}

/** SolversScope's own tabs (hidden from the New Tab menus in plain mode). */
export const SOLVERS_TAB_TYPES = [
  TabType.ShotLab,
  TabType.DriveSim,
  TabType.Telemetry,
  TabType.AutoCheck,
  TabType.MultiField
];

/** Tab types offered in the New Tab menus (everything but Documentation; plain mode drops SolversScope's tabs). */
export function getNewTabTypes(plainMode: boolean): TabType[] {
  return getAllTabTypes()
    .slice(1)
    .filter((tabType) => !plainMode || !SOLVERS_TAB_TYPES.includes(tabType));
}

export const LITE_COMPATIBLE_TABS =
  DISTRIBUTION === Distribution.Lite
    ? [
        TabType.Documentation,
        TabType.LineGraph,
        TabType.Field2d,
        TabType.Field3d,
        TabType.Table,
        TabType.Console,
        TabType.Statistics,
        TabType.Joysticks,
        TabType.Swerve,
        TabType.Mechanism,
        TabType.Points,
        TabType.Metadata
      ]
    : // Lite DS
      [TabType.LineGraph, TabType.Table, TabType.Console, TabType.Statistics, TabType.Joysticks];

export function getDefaultTabTitle(type: TabType): string {
  switch (type) {
    case TabType.Documentation:
      return "";
    case TabType.LineGraph:
      return "Line Graph";
    case TabType.Field2d:
      return "2D Field";
    case TabType.Field3d:
      return "3D Field";
    case TabType.Table:
      return "Table";
    case TabType.Console:
      return "Console";
    case TabType.Statistics:
      return "Statistics";
    case TabType.Video:
      return "Video";
    case TabType.Joysticks:
      return "Joysticks";
    case TabType.Swerve:
      return "Swerve";
    case TabType.Mechanism:
      return "Mechanism";
    case TabType.Points:
      return "Points";
    case TabType.Metadata:
      return "Metadata";
    case TabType.ShotLab:
      return "Shot Lab";
    case TabType.DriveSim:
      return "Drive Sim";
    case TabType.Telemetry:
      return "Telemetry";
    case TabType.AutoCheck:
      return "Auto Check";
    case TabType.MultiField:
      return "Multisim";
    default:
      return "";
  }
}

export function getTabIcon(type: TabType): string {
  switch (type) {
    case TabType.Documentation:
      return "📖";
    case TabType.LineGraph:
      return "📉";
    case TabType.Field2d:
      return "🗺";
    case TabType.Field3d:
      return "👀";
    case TabType.Table:
      return "🔢";
    case TabType.Console:
      return "💬";
    case TabType.Statistics:
      return "📊";
    case TabType.Video:
      return "🎬";
    case TabType.Joysticks:
      return "🎮";
    case TabType.Swerve:
      return "🦀";
    case TabType.Mechanism:
      return "⚙️";
    case TabType.Points:
      return "📍";
    case TabType.Metadata:
      return "🔍";
    case TabType.ShotLab:
      return "🎯";
    case TabType.DriveSim:
      return "🕹️";
    case TabType.Telemetry:
      return "📟";
    case TabType.AutoCheck:
      return "✅";
    case TabType.MultiField:
      return "🧩";
    default:
      return "";
  }
}

export function getTabAccelerator(type: TabType): string {
  if (type === TabType.Documentation) return "";
  return (
    "Alt+" +
    (() => {
      switch (type) {
        case TabType.LineGraph:
          return "G";
        case TabType.Field2d:
          return "2";
        case TabType.Field3d:
          return "3";
        case TabType.Table:
          return "T";
        case TabType.Console:
          return "C";
        case TabType.Statistics:
          return "S";
        case TabType.Video:
          return "V";
        case TabType.Joysticks:
          return "J";
        case TabType.Swerve:
          return "D";
        case TabType.Mechanism:
          return "M";
        case TabType.Points:
          return "P";
        case TabType.Metadata:
          return "I";
        case TabType.ShotLab:
          return "L";
        case TabType.DriveSim:
          return "K";
        case TabType.Telemetry:
          return "E";
        case TabType.AutoCheck:
          return "U";
        case TabType.MultiField:
          return "N";
        default:
          return "";
      }
    })()
  );
}
