import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_INTERVAL_MS,
  STATE_STATUS,
  TAB_STATE_KEY_PREFIX,
  claimDueClick,
  createTabState,
  normalizeTabState,
  selectTarget,
  startTimer,
  stopTimer,
  tabStateKey,
  updateStatus
} from "../../src/state.js";

const TAB_ID = 42;
const SELECTED_AT = 1_000;
const STARTED_AT = 2_000;
const TARGET = Object.freeze({
  selector: "#reload-page",
  label: "Reload page"
});

test("creates isolated session state for a tab", () => {
  assert.deepEqual(createTabState(TAB_ID), {
    version: 1,
    tabId: TAB_ID,
    target: null,
    intervalMs: DEFAULT_INTERVAL_MS,
    running: false,
    nextRunAt: null,
    clickCount: 0,
    lastClickedAt: null,
    selectedAt: null,
    status: STATE_STATUS.IDLE,
    statusDetail: null,
    revision: 0
  });
  assert.equal(TAB_STATE_KEY_PREFIX, "tab:");
  assert.equal(tabStateKey(TAB_ID), "tab:42");
});

test("selecting a target pauses and resets its schedule", () => {
  const running = startTimer(
    selectTarget(createTabState(TAB_ID), TARGET, SELECTED_AT),
    { ...TARGET, intervalMs: 5_000 },
    STARTED_AT
  );
  const selected = selectTarget(running, {
    selector: "button.next",
    label: "Next"
  }, 3_000);

  assert.equal(selected.running, false);
  assert.equal(selected.nextRunAt, null);
  assert.equal(selected.clickCount, 0);
  assert.equal(selected.target.selector, "button.next");
  assert.equal(selected.status, STATE_STATUS.READY);
  assert.equal(selected.selectedAt, 3_000);
});

test("starting schedules the first click one interval from now", () => {
  const selected = selectTarget(createTabState(TAB_ID), TARGET, SELECTED_AT);
  const running = startTimer(selected, {
    ...TARGET,
    intervalMs: 2_500
  }, STARTED_AT);

  assert.equal(running.running, true);
  assert.equal(running.intervalMs, 2_500);
  assert.equal(running.nextRunAt, 4_500);
  assert.equal(running.status, STATE_STATUS.SCHEDULED);
});

test("only the matching due schedule can claim a click", () => {
  const running = startTimer(
    selectTarget(createTabState(TAB_ID), TARGET, SELECTED_AT),
    { ...TARGET, intervalMs: 1_000 },
    STARTED_AT
  );

  const early = claimDueClick(running, {
    selector: TARGET.selector,
    nextRunAt: 3_000
  }, 2_999);
  assert.equal(early.authorized, false);

  const stale = claimDueClick(running, {
    selector: TARGET.selector,
    nextRunAt: 9_999
  }, 3_000);
  assert.equal(stale.authorized, false);

  const due = claimDueClick(running, {
    selector: TARGET.selector,
    nextRunAt: 3_000
  }, 3_100);
  assert.equal(due.authorized, true);
  assert.equal(due.state.clickCount, 1);
  assert.equal(due.state.lastClickedAt, 3_100);
  assert.equal(due.state.nextRunAt, 4_000);
});

test("late clicks keep cadence without replaying missed intervals", () => {
  const running = startTimer(
    selectTarget(createTabState(TAB_ID), TARGET, SELECTED_AT),
    { ...TARGET, intervalMs: 1_000 },
    STARTED_AT
  );

  const due = claimDueClick(running, {
    selector: TARGET.selector,
    nextRunAt: 3_000
  }, 5_100);

  assert.equal(due.authorized, true);
  assert.equal(due.state.clickCount, 1);
  assert.equal(due.state.lastClickedAt, 5_100);
  assert.equal(due.state.nextRunAt, 6_000);
});

test("stopping preserves the target and click history", () => {
  const running = startTimer(
    selectTarget(createTabState(TAB_ID), TARGET, SELECTED_AT),
    { ...TARGET, intervalMs: 1_000 },
    STARTED_AT
  );
  const claimed = claimDueClick(running, {
    selector: TARGET.selector,
    nextRunAt: 3_000
  }, 3_000).state;
  const stopped = stopTimer(claimed);

  assert.equal(stopped.running, false);
  assert.equal(stopped.nextRunAt, null);
  assert.equal(stopped.target.selector, TARGET.selector);
  assert.equal(stopped.clickCount, 1);
  assert.equal(stopped.status, STATE_STATUS.READY);
});

test("normalization rejects malformed persisted schedules", () => {
  const normalized = normalizeTabState(TAB_ID, {
    version: 1,
    target: { selector: "  #reload-page  ", label: "  Reload   page  " },
    intervalMs: -100,
    running: true,
    nextRunAt: "soon",
    clickCount: -4,
    status: "unknown",
    revision: -1
  });

  assert.equal(normalized.target.selector, TARGET.selector);
  assert.equal(normalized.target.label, TARGET.label);
  assert.equal(normalized.intervalMs, 1_000);
  assert.equal(normalized.running, false);
  assert.equal(normalized.nextRunAt, null);
  assert.equal(normalized.clickCount, 0);
  assert.equal(normalized.status, STATE_STATUS.READY);
  assert.equal(normalized.revision, 0);
});

test("duplicate status reports do not create a new revision", () => {
  const state = startTimer(
    selectTarget(createTabState(TAB_ID), TARGET, SELECTED_AT),
    { ...TARGET, intervalMs: 1_000 },
    STARTED_AT
  );
  const waiting = updateStatus(
    state,
    STATE_STATUS.WAITING,
    "Target not found on this page"
  );

  assert.equal(waiting.revision, state.revision + 1);
  assert.equal(
    updateStatus(waiting, STATE_STATUS.WAITING, "Target not found on this page"),
    waiting
  );
});
