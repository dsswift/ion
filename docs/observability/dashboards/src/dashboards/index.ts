// Recipe registry.
//
// The ordered list of every dashboard recipe. generate.ts and check.ts both walk
// this list. Every committed dashboard JSON under the provisioning tree MUST
// have a recipe here — the check byte-diffs the full set, so an un-migrated
// dashboard would be flagged as an orphan.

import type { Dashboard } from '../dashboard.ts';
import { extensionsDashboard } from './extensions.ts';
import { costDashboard } from './cost.ts';
import { overviewDashboard } from './overview.ts';
import { intelligenceDashboard } from './intelligence.ts';
import { errorsHealthDashboard } from './errors-health.ts';
import { liveLogsDashboard } from './live-logs.ts';
import { forensicsDashboard } from './forensics.ts';
import { qualityDashboard } from './quality.ts';
import { wireLatencyDashboard } from './wire-latency.ts';
import { controlRoomDashboard } from './control-room.ts';
import { cookbookDashboard } from './cookbook.ts';
import { trustDashboard } from './trust.ts';
import { usersDashboard } from './users.ts';
import { fleetDashboard } from './fleet.ts';

export type Recipe = () => Dashboard;

export const RECIPES: readonly Recipe[] = [
  overviewDashboard,
  costDashboard,
  extensionsDashboard,
  intelligenceDashboard,
  errorsHealthDashboard,
  liveLogsDashboard,
  forensicsDashboard,
  qualityDashboard,
  wireLatencyDashboard,
  controlRoomDashboard,
  cookbookDashboard,
  trustDashboard,
  usersDashboard,
  fleetDashboard,
];
