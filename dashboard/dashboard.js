import { MESSAGE } from "../src/protocol.js";
import { STATE_STATUS, TAB_STATE_KEY_PREFIX } from "../src/state.js";

const COUNTDOWN_REFRESH_MS = 250;
const MILLISECONDS_PER_SECOND = 1_000;
const SECONDS_PER_MINUTE = 60;
const MINUTES_PER_HOUR = 60;
const isCapture = new URLSearchParams(location.search).get("capture") === "1";

const elements = Object.freeze({
  emptyState: document.querySelector("#empty-state"),
  errorMessage: document.querySelector("#error-message"),
  list: document.querySelector("#timer-list"),
  template: document.querySelector("#timer-template"),
  timerCount: document.querySelector("#timer-count")
});

let refreshPending = false;

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

async function request(type, details = {}) {
  const response = await chrome.runtime.sendMessage({ type, ...details });

  if (!response?.ok) {
    throw new Error(response?.error || "Persistent Clicker did not respond");
  }

  return response;
}

function formatDuration(intervalMs) {
  const seconds = intervalMs / MILLISECONDS_PER_SECOND;

  if (seconds < SECONDS_PER_MINUTE) {
    const value = Number.isInteger(seconds) ? String(seconds) : seconds.toFixed(1);
    return `${value} ${seconds === 1 ? "second" : "seconds"}`;
  }

  const minutes = seconds / SECONDS_PER_MINUTE;

  if (minutes < MINUTES_PER_HOUR) {
    const value = Number.isInteger(minutes) ? String(minutes) : minutes.toFixed(1);
    return `${value} ${minutes === 1 ? "minute" : "minutes"}`;
  }

  const hours = minutes / MINUTES_PER_HOUR;
  const value = Number.isInteger(hours) ? String(hours) : hours.toFixed(1);
  return `${value} ${hours === 1 ? "hour" : "hours"}`;
}

function formatCountdown(nextRunAt) {
  const remainingMs = Math.max(0, nextRunAt - Date.now());
  const seconds = remainingMs / MILLISECONDS_PER_SECOND;

  if (seconds < 10) {
    return `in ${seconds.toFixed(1)}s`;
  }

  if (seconds < SECONDS_PER_MINUTE) {
    return `in ${Math.ceil(seconds)}s`;
  }

  const minutes = Math.floor(seconds / SECONDS_PER_MINUTE);
  const remainingSeconds = Math.ceil(seconds % SECONDS_PER_MINUTE);
  return `in ${minutes}m ${remainingSeconds}s`;
}

function statusPresentation(timer) {
  if (timer.status === STATE_STATUS.WAITING) {
    return { label: "Waiting", tone: "warning" };
  }

  if (timer.status === STATE_STATUS.ERROR) {
    return { label: "Attention", tone: "error" };
  }

  return { label: "Running", tone: "running" };
}

function updateCountdowns() {
  for (const nextClick of elements.list.querySelectorAll("[data-next-click]")) {
    const nextRunAt = Number(nextClick.dataset.nextRunAt);
    const intervalMs = Number(nextClick.dataset.intervalMs);
    nextClick.textContent = isCapture
      ? `in ${(intervalMs / MILLISECONDS_PER_SECOND).toFixed(1)}s`
      : formatCountdown(nextRunAt);
  }
}

function createTimerItem(timer) {
  const fragment = elements.template.content.cloneNode(true);
  const item = fragment.querySelector(".timer");
  const presentation = statusPresentation(timer);
  const status = item.querySelector("[data-status]");
  const detail = item.querySelector("[data-status-detail]");
  const nextClick = item.querySelector("[data-next-click]");

  item.dataset.tabId = String(timer.tabId);
  item.querySelector("[data-tab-title]").textContent = timer.tabTitle;
  item.querySelector("[data-target-label]").textContent = timer.target.label;
  item.querySelector("[data-selector]").textContent = timer.target.selector;
  item.querySelector("[data-status-label]").textContent = presentation.label;
  item.querySelector("[data-interval]").textContent = formatDuration(timer.intervalMs);
  item.querySelector("[data-click-count]").textContent = String(timer.clickCount);
  status.dataset.tone = presentation.tone;
  nextClick.dataset.nextRunAt = String(timer.nextRunAt);
  nextClick.dataset.intervalMs = String(timer.intervalMs);

  if (timer.statusDetail) {
    detail.textContent = timer.statusDetail;
    detail.hidden = false;
  }

  return fragment;
}

function render(timers) {
  elements.list.replaceChildren(...timers.map(createTimerItem));
  elements.emptyState.hidden = timers.length !== 0;
  elements.timerCount.textContent = timers.length === 1
    ? "1 running"
    : `${timers.length} running`;
  elements.errorMessage.hidden = true;
  document.documentElement.dataset.ready = "true";
  updateCountdowns();
}

function showError(message) {
  elements.errorMessage.textContent = message;
  elements.errorMessage.hidden = false;
}

async function refreshTimers() {
  refreshPending = false;

  try {
    const response = await request(MESSAGE.LIST_TIMERS);
    render(response.timers);
  } catch (error) {
    showError(errorMessage(error));
    elements.timerCount.textContent = "Unavailable";
    document.documentElement.dataset.ready = "true";
  }
}

function scheduleRefresh() {
  if (refreshPending) {
    return;
  }

  refreshPending = true;
  queueMicrotask(() => void refreshTimers());
}

elements.list.addEventListener("click", async (event) => {
  const button = event.target.closest("button[data-action]");
  const item = button?.closest(".timer");
  const tabId = Number(item?.dataset.tabId);

  if (!button || !Number.isInteger(tabId)) {
    return;
  }

  button.disabled = true;
  elements.errorMessage.hidden = true;

  try {
    const type = button.dataset.action === "stop"
      ? MESSAGE.STOP
      : MESSAGE.FOCUS_TAB;
    await request(type, { tabId });

    if (type === MESSAGE.STOP) {
      await refreshTimers();
    }
  } catch (error) {
    showError(errorMessage(error));
    button.disabled = false;
  }
});

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName === "session"
      && Object.keys(changes).some((key) => key.startsWith(TAB_STATE_KEY_PREFIX))) {
    scheduleRefresh();
  }
});

setInterval(updateCountdowns, COUNTDOWN_REFRESH_MS);
void refreshTimers();
