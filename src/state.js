export const DEFAULT_INTERVAL_MS = 30_000;
export const MIN_INTERVAL_MS = 1_000;
export const MAX_INTERVAL_MS = 86_400_000;
export const TAB_STATE_VERSION = 1;
export const TAB_STATE_KEY_PREFIX = "tab:";

export const STATE_STATUS = Object.freeze({
  IDLE: "idle",
  READY: "ready",
  SCHEDULED: "scheduled",
  WAITING: "waiting",
  ERROR: "error"
});

const VALID_STATUSES = new Set(Object.values(STATE_STATUS));
const MAX_LABEL_LENGTH = 80;

function assertTabId(tabId) {
  if (!Number.isInteger(tabId) || tabId < 0) {
    throw new TypeError("A valid tab ID is required");
  }
}

function evolve(state, patch) {
  return {
    ...state,
    ...patch,
    revision: state.revision + 1
  };
}

function cleanSelector(value) {
  return typeof value === "string" ? value.trim() : "";
}

function cleanLabel(value, fallback) {
  const normalized = typeof value === "string"
    ? value.replace(/\s+/g, " ").trim()
    : "";

  return (normalized || fallback).slice(0, MAX_LABEL_LENGTH);
}

export function tabStateKey(tabId) {
  assertTabId(tabId);
  return `${TAB_STATE_KEY_PREFIX}${tabId}`;
}

export function normalizeIntervalMs(value) {
  const interval = Number(value);

  if (!Number.isFinite(interval)) {
    return DEFAULT_INTERVAL_MS;
  }

  return Math.min(
    MAX_INTERVAL_MS,
    Math.max(MIN_INTERVAL_MS, Math.round(interval))
  );
}

export function createTabState(tabId) {
  assertTabId(tabId);

  return {
    version: TAB_STATE_VERSION,
    tabId,
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
  };
}

export function normalizeTabState(tabId, value) {
  const fallback = createTabState(tabId);

  if (!value || typeof value !== "object" || value.version !== TAB_STATE_VERSION) {
    return fallback;
  }

  const selector = cleanSelector(value.target?.selector);
  const target = selector
    ? {
        selector,
        label: cleanLabel(value.target?.label, selector)
      }
    : null;
  const running = Boolean(value.running && target);
  const nextRunAt = running && Number.isFinite(value.nextRunAt)
    ? value.nextRunAt
    : null;
  const status = VALID_STATUSES.has(value.status)
    ? value.status
    : target
      ? STATE_STATUS.READY
      : STATE_STATUS.IDLE;

  return {
    ...fallback,
    target,
    intervalMs: normalizeIntervalMs(value.intervalMs),
    running: Boolean(running && nextRunAt),
    nextRunAt,
    clickCount: Number.isInteger(value.clickCount) && value.clickCount >= 0
      ? value.clickCount
      : 0,
    lastClickedAt: Number.isFinite(value.lastClickedAt)
      ? value.lastClickedAt
      : null,
    selectedAt: Number.isFinite(value.selectedAt) ? value.selectedAt : null,
    status: running && nextRunAt ? status : target ? STATE_STATUS.READY : STATE_STATUS.IDLE,
    statusDetail: typeof value.statusDetail === "string" ? value.statusDetail : null,
    revision: Number.isInteger(value.revision) && value.revision >= 0
      ? value.revision
      : 0
  };
}

export function selectTarget(state, target, now = Date.now()) {
  const selector = cleanSelector(target?.selector);

  if (!selector) {
    throw new TypeError("A CSS selector is required");
  }

  return evolve(state, {
    target: {
      selector,
      label: cleanLabel(target?.label, selector)
    },
    running: false,
    nextRunAt: null,
    clickCount: 0,
    lastClickedAt: null,
    selectedAt: now,
    status: STATE_STATUS.READY,
    statusDetail: null
  });
}

export function startTimer(state, options, now = Date.now()) {
  const selector = cleanSelector(options?.selector);

  if (!selector) {
    throw new TypeError("A CSS selector is required");
  }

  const sameTarget = selector === state.target?.selector;
  const intervalMs = normalizeIntervalMs(options?.intervalMs);

  return evolve(state, {
    target: {
      selector,
      label: cleanLabel(options?.label, sameTarget ? state.target.label : selector)
    },
    intervalMs,
    running: true,
    nextRunAt: now + intervalMs,
    clickCount: sameTarget ? state.clickCount : 0,
    lastClickedAt: sameTarget ? state.lastClickedAt : null,
    selectedAt: sameTarget ? state.selectedAt : now,
    status: STATE_STATUS.SCHEDULED,
    statusDetail: null
  });
}

export function stopTimer(state) {
  return evolve(state, {
    running: false,
    nextRunAt: null,
    status: state.target ? STATE_STATUS.READY : STATE_STATUS.IDLE,
    statusDetail: null
  });
}

export function updateStatus(state, status, detail = null) {
  if (!VALID_STATUSES.has(status)) {
    throw new TypeError("Unknown page status");
  }

  const statusDetail = typeof detail === "string" && detail.trim()
    ? detail.trim()
    : null;

  if (state.status === status && state.statusDetail === statusDetail) {
    return state;
  }

  return evolve(state, { status, statusDetail });
}

export function claimDueClick(state, expected, now = Date.now()) {
  const matchesSchedule = state.running
    && state.target?.selector === expected?.selector
    && state.nextRunAt === expected?.nextRunAt;

  if (!matchesSchedule || now < state.nextRunAt) {
    return { authorized: false, state };
  }

  return {
    authorized: true,
    state: evolve(state, {
      nextRunAt: now + state.intervalMs,
      clickCount: state.clickCount + 1,
      lastClickedAt: now,
      status: STATE_STATUS.SCHEDULED,
      statusDetail: null
    })
  };
}
