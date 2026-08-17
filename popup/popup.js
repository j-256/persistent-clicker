import { MESSAGE } from "../src/protocol.js";
import {
  DEFAULT_INTERVAL_MS,
  MAX_INTERVAL_MS,
  MIN_INTERVAL_MS,
  STATE_STATUS
} from "../src/state.js";

const POLL_INTERVAL_MS = 750;
const MILLISECONDS_PER_SECOND = 1_000;
const params = new URLSearchParams(location.search);
const previewTabId = Number.parseInt(params.get("tab") || "", 10);
const isPreview = Number.isInteger(previewTabId);
const isCapture = params.get("capture") === "1";

const elements = Object.freeze({
  clickCount: document.querySelector("#click-count"),
  dashboardButton: document.querySelector("#dashboard-button"),
  form: document.querySelector("#timer-form"),
  interval: document.querySelector("#interval-input"),
  message: document.querySelector("#message"),
  nextClick: document.querySelector("#next-click"),
  pickButton: document.querySelector("#pick-button"),
  selector: document.querySelector("#selector-input"),
  startButton: document.querySelector("#start-button"),
  status: document.querySelector("#status"),
  statusLabel: document.querySelector("#status-label"),
  stopButton: document.querySelector("#stop-button"),
  targetLabel: document.querySelector("#target-label"),
  targetSummary: document.querySelector("#target-summary")
});

let tabId = null;
let tabState = null;
let pollTimerId = null;
let selectorDirty = false;
let intervalDirty = false;

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

async function request(type, details = {}) {
  const response = await chrome.runtime.sendMessage({
    type,
    tabId,
    ...details
  });

  if (!response?.ok) {
    throw new Error(response?.error || "Persistent Clicker did not respond");
  }

  return response;
}

async function resolveTabId() {
  if (isPreview) {
    return previewTabId;
  }

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

  if (!Number.isInteger(tab?.id)) {
    throw new Error("Open Persistent Clicker from a browser tab");
  }

  return tab.id;
}

function formatCountdown(nextRunAt) {
  if (!Number.isFinite(nextRunAt)) {
    return "Not scheduled";
  }

  const remainingMs = Math.max(0, nextRunAt - Date.now());
  const seconds = remainingMs / MILLISECONDS_PER_SECOND;

  if (seconds < 10) {
    return `in ${seconds.toFixed(1)}s`;
  }

  if (seconds < 60) {
    return `in ${Math.ceil(seconds)}s`;
  }

  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = Math.ceil(seconds % 60);
  return `in ${minutes}m ${remainingSeconds}s`;
}

function statusPresentation(state) {
  if (!state) {
    return { label: "Loading", tone: "idle" };
  }

  if (state.running && state.status === STATE_STATUS.WAITING) {
    return { label: "Waiting", tone: "warning" };
  }

  if (state.running && state.status === STATE_STATUS.ERROR) {
    return { label: "Attention", tone: "error" };
  }

  if (state.running) {
    return { label: "Running", tone: "running" };
  }

  if (state.target) {
    return { label: "Ready", tone: "ready" };
  }

  return { label: "No target", tone: "idle" };
}

function showError(message) {
  elements.message.textContent = message;
  elements.message.hidden = false;
}

function clearError() {
  elements.message.textContent = "";
  elements.message.hidden = true;
}

function setBusy(busy) {
  elements.pickButton.disabled = busy;
  elements.startButton.disabled = busy;
  elements.stopButton.disabled = busy || !tabState?.running;
}

function render(state, options = {}) {
  const previousSelector = tabState?.target?.selector || "";
  tabState = state;
  const presentation = statusPresentation(state);
  const nextSelector = state.target?.selector || "";

  elements.status.dataset.tone = presentation.tone;
  elements.statusLabel.textContent = presentation.label;
  elements.targetSummary.hidden = !state.target;
  elements.targetLabel.textContent = state.target?.label || "";
  elements.nextClick.textContent = state.running
    ? isCapture
      ? `in ${(state.intervalMs / MILLISECONDS_PER_SECOND).toFixed(1)}s`
      : formatCountdown(state.nextRunAt)
    : "Not scheduled";
  elements.clickCount.textContent = String(state.clickCount);
  elements.stopButton.disabled = !state.running;
  elements.startButton.textContent = state.running ? "Restart timer" : "Start clicking";

  if (options.forceFields || nextSelector !== previousSelector || !selectorDirty) {
    elements.selector.value = nextSelector;
    selectorDirty = false;
  }

  if (options.forceFields || !intervalDirty) {
    elements.interval.value = String(state.intervalMs / MILLISECONDS_PER_SECOND);
    intervalDirty = false;
  }

  if (state.statusDetail && state.running) {
    showError(state.statusDetail);
  } else if (!options.keepError) {
    clearError();
  }
}

async function refreshState(options = {}) {
  const response = await request(MESSAGE.GET_STATE);
  render(response.state, options);
}

function schedulePoll() {
  clearTimeout(pollTimerId);
  pollTimerId = setTimeout(async () => {
    try {
      await refreshState({ keepError: true });
    } catch {
      if (tabState?.running) {
        elements.nextClick.textContent = formatCountdown(tabState.nextRunAt);
      }
    } finally {
      schedulePoll();
    }
  }, POLL_INTERVAL_MS);
}

elements.selector.addEventListener("input", () => {
  selectorDirty = true;
});

elements.interval.addEventListener("input", () => {
  intervalDirty = true;
});

elements.pickButton.addEventListener("click", async () => {
  clearError();
  setBusy(true);

  try {
    await request(MESSAGE.ENTER_PICK_MODE);

    if (!isPreview) {
      window.close();
    }
  } catch (error) {
    showError(errorMessage(error));
  } finally {
    setBusy(false);
  }
});

elements.form.addEventListener("submit", async (event) => {
  event.preventDefault();
  clearError();

  const selector = elements.selector.value.trim();
  const intervalMs = Number(elements.interval.value) * MILLISECONDS_PER_SECOND;

  if (!selector) {
    showError("Select a control or enter its CSS selector");
    elements.selector.focus();
    return;
  }

  if (!Number.isFinite(intervalMs)
      || intervalMs < MIN_INTERVAL_MS
      || intervalMs > MAX_INTERVAL_MS) {
    showError("Choose an interval from 1 second to 24 hours");
    elements.interval.focus();
    return;
  }

  setBusy(true);

  try {
    const response = await request(MESSAGE.START, { selector, intervalMs });
    selectorDirty = false;
    intervalDirty = false;
    render(response.state, { forceFields: true });
  } catch (error) {
    showError(errorMessage(error));
  } finally {
    setBusy(false);
  }
});

elements.stopButton.addEventListener("click", async () => {
  clearError();
  setBusy(true);

  try {
    const response = await request(MESSAGE.STOP);
    render(response.state);
  } catch (error) {
    showError(errorMessage(error));
  } finally {
    setBusy(false);
  }
});

elements.dashboardButton.addEventListener("click", async () => {
  clearError();
  elements.dashboardButton.disabled = true;

  try {
    await request(MESSAGE.OPEN_DASHBOARD, { capture: isCapture });

    if (!isPreview) {
      window.close();
    }
  } catch (error) {
    showError(errorMessage(error));
  } finally {
    elements.dashboardButton.disabled = false;
  }
});

window.addEventListener("pagehide", () => clearTimeout(pollTimerId));

void (async () => {
  try {
    tabId = await resolveTabId();
    await refreshState({ forceFields: true });
    schedulePoll();
  } catch (error) {
    const fallback = {
      target: null,
      intervalMs: DEFAULT_INTERVAL_MS,
      running: false,
      nextRunAt: null,
      clickCount: 0,
      status: STATE_STATUS.IDLE,
      statusDetail: null
    };
    render(fallback, { forceFields: true, keepError: true });
    showError(errorMessage(error));
    setBusy(true);
  }
})();
