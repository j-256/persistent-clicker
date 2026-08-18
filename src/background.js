import {
  CONTEXT_MENU_ID,
  DASHBOARD_CONTEXT_MENU_ID,
  MESSAGE,
  PAGE_URL_PATTERNS
} from "./protocol.js";
import { openPopupAfterSelection } from "./action-popup.js";
import {
  MAX_INTERVAL_MS,
  MIN_INTERVAL_MS,
  STATE_STATUS,
  TAB_STATE_KEY_PREFIX,
  claimDueClick,
  normalizeTabState,
  selectTarget,
  startTimer,
  stopTimer,
  tabStateKey,
  updateStatus
} from "./state.js";

const BADGE = Object.freeze({
  ERROR: "!",
  RUNNING: "ON",
  WAITING: "WAIT"
});

const BADGE_COLOR = Object.freeze({
  ERROR: "#b42318",
  RUNNING: "#5b4ee5",
  WAITING: "#b54708"
});

const DASHBOARD_PATH = "dashboard/dashboard.html";
const FALLBACK_TAB_TITLE = "Browser tab";
const CONTENT_ASSET = Object.freeze({
  CSS: "src/content.css",
  SCRIPT: "src/content.js"
});
const tabOperations = new Map();

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

function serializeTabOperation(tabId, operation) {
  const previous = tabOperations.get(tabId) || Promise.resolve();
  const current = previous.catch(() => undefined).then(operation);
  tabOperations.set(tabId, current);

  return current.finally(() => {
    if (tabOperations.get(tabId) === current) {
      tabOperations.delete(tabId);
    }
  });
}

function resolveTabId(message, sender) {
  const tabId = Number.isInteger(message.tabId) ? message.tabId : sender.tab?.id;

  if (!Number.isInteger(tabId) || tabId < 0) {
    throw new TypeError("A valid tab ID is required");
  }

  return tabId;
}

function assertPageSender(sender, tabId) {
  if (sender.tab?.id !== tabId || sender.frameId !== 0) {
    throw new Error("This message is only accepted from a top-level page");
  }
}

function assertInterval(intervalMs) {
  if (!Number.isFinite(intervalMs)
      || intervalMs < MIN_INTERVAL_MS
      || intervalMs > MAX_INTERVAL_MS) {
    throw new RangeError("Choose an interval from 1 second to 24 hours");
  }
}

async function readState(tabId) {
  const key = tabStateKey(tabId);
  const stored = await chrome.storage.session.get(key);
  return normalizeTabState(tabId, stored[key]);
}

async function readRunningTimers() {
  const stored = await chrome.storage.session.get(null);
  const timers = [];

  for (const [key, value] of Object.entries(stored)) {
    if (!key.startsWith(TAB_STATE_KEY_PREFIX)) {
      continue;
    }

    const tabId = Number(key.slice(TAB_STATE_KEY_PREFIX.length));

    if (!Number.isInteger(tabId) || tabStateKey(tabId) !== key) {
      continue;
    }

    const state = normalizeTabState(tabId, value);

    if (!state.running) {
      continue;
    }

    try {
      const tab = await chrome.tabs.get(tabId);
      let tabTitle = typeof tab.title === "string" && tab.title.trim()
        ? tab.title.trim()
        : FALLBACK_TAB_TITLE;

      if (tabTitle === FALLBACK_TAB_TITLE) {
        try {
          const page = await sendToPage(
            tabId,
            { type: MESSAGE.DESCRIBE_PAGE },
            { frameId: 0 }
          );
          tabTitle = typeof page?.title === "string" && page.title
            ? page.title
            : FALLBACK_TAB_TITLE;
        } catch {
          tabTitle = FALLBACK_TAB_TITLE;
        }
      }

      timers.push({ ...state, tabTitle });
    } catch {
      await chrome.storage.session.remove(key);
    }
  }

  return timers.sort((left, right) => {
    return (left.selectedAt ?? 0) - (right.selectedAt ?? 0);
  });
}

async function focusTab(tabId) {
  const tab = await chrome.tabs.get(tabId);
  await chrome.tabs.update(tabId, { active: true });

  if (Number.isInteger(tab.windowId)) {
    await chrome.windows.update(tab.windowId, { focused: true });
  }
}

async function openDashboard(capture = false) {
  const dashboardUrl = chrome.runtime.getURL(DASHBOARD_PATH);

  if (!capture) {
    const tabs = await chrome.tabs.query({});
    const existing = tabs.find((tab) => tab.url === dashboardUrl);

    if (Number.isInteger(existing?.id)) {
      await focusTab(existing.id);
      return existing.id;
    }
  }

  const tab = await chrome.tabs.create({
    url: capture ? `${dashboardUrl}?capture=1` : dashboardUrl
  });
  return tab.id;
}

async function writeState(state) {
  await chrome.storage.session.set({
    [tabStateKey(state.tabId)]: state
  });
  await updateBadge(state);
  return state;
}

async function updateBadge(state) {
  let text = "";
  let color = BADGE_COLOR.RUNNING;

  if (state.running && state.status === STATE_STATUS.WAITING) {
    text = BADGE.WAITING;
    color = BADGE_COLOR.WAITING;
  } else if (state.running && state.status === STATE_STATUS.ERROR) {
    text = BADGE.ERROR;
    color = BADGE_COLOR.ERROR;
  } else if (state.running) {
    text = BADGE.RUNNING;
  }

  const title = state.running
    ? `Persistent Clicker: running every ${state.intervalMs / 1_000} seconds`
    : state.target
      ? "Persistent Clicker: target ready"
      : "Persistent Clicker";

  await Promise.all([
    chrome.action.setBadgeText({ tabId: state.tabId, text }),
    chrome.action.setBadgeBackgroundColor({ tabId: state.tabId, color }),
    chrome.action.setTitle({ tabId: state.tabId, title })
  ]);
}

async function sendToPage(tabId, message, options) {
  try {
    return await chrome.tabs.sendMessage(tabId, message, options);
  } catch {
    throw new Error("Persistent Clicker cannot run on this page. Reload a regular web page and try again");
  }
}

async function injectPage(tabId) {
  const target = { tabId, frameIds: [0] };
  await chrome.scripting.insertCSS({
    target,
    files: [CONTENT_ASSET.CSS]
  });
  await chrome.scripting.executeScript({
    target,
    files: [CONTENT_ASSET.SCRIPT]
  });
}

async function sendToPageWithRecovery(
  tabId,
  message,
  options,
  recoveryMessage = message
) {
  try {
    return await sendToPage(tabId, message, options);
  } catch {
    try {
      await injectPage(tabId);
      return await sendToPage(tabId, recoveryMessage, options);
    } catch {
      throw new Error("Persistent Clicker cannot run on this page. Open a regular web page and try again");
    }
  }
}

async function broadcastState(state) {
  try {
    await chrome.tabs.sendMessage(state.tabId, {
      type: MESSAGE.PAGE_STATE,
      state
    });
  } catch {
    // Navigation can replace the receiving document between storage and delivery
  }
}

async function saveAndBroadcast(state) {
  await writeState(state);
  await broadcastState(state);
  return state;
}

async function handleContextSelection(info, tab) {
  if (!Number.isInteger(tab?.id)) {
    return;
  }

  const frameId = info.frameId ?? 0;

  if (frameId !== 0) {
    await Promise.all([
      chrome.action.setBadgeText({ tabId: tab.id, text: BADGE.ERROR }),
      chrome.action.setBadgeBackgroundColor({
        tabId: tab.id,
        color: BADGE_COLOR.ERROR
      }),
      chrome.action.setTitle({
        tabId: tab.id,
        title: "Persistent Clicker only selects controls in the top-level page"
      })
    ]);
    return;
  }

  try {
    await sendToPageWithRecovery(
      tab.id,
      { type: MESSAGE.SELECT_CONTEXT_TARGET },
      { frameId: 0 },
      { type: MESSAGE.ENTER_PICK_MODE }
    );
  } catch {
    await chrome.action.setBadgeText({ tabId: tab.id, text: BADGE.ERROR });
    await chrome.action.setBadgeBackgroundColor({
      tabId: tab.id,
      color: BADGE_COLOR.ERROR
    });
  }
}

async function handleTabMessage(message, sender, tabId) {
  switch (message.type) {
    case MESSAGE.GET_STATE:
      return { ok: true, state: await readState(tabId) };

    case MESSAGE.FOCUS_TAB:
      await focusTab(tabId);
      return { ok: true };

    case MESSAGE.SELECT_TARGET: {
      assertPageSender(sender, tabId);
      const state = selectTarget(await readState(tabId), message.target);
      const response = { ok: true, state: await saveAndBroadcast(state) };

      if (message.openPopup === true) {
        response.popupOpened = await openPopupAfterSelection(
          chrome.action,
          sender.tab,
          response
        );
      }

      return response;
    }

    case MESSAGE.ENTER_PICK_MODE:
      return sendToPageWithRecovery(tabId, { type: MESSAGE.ENTER_PICK_MODE });

    case MESSAGE.START: {
      const selector = typeof message.selector === "string"
        ? message.selector.trim()
        : "";
      assertInterval(message.intervalMs);

      if (!selector) {
        throw new TypeError("Enter or select a CSS selector first");
      }

      const validation = await sendToPageWithRecovery(tabId, {
        type: MESSAGE.VALIDATE_SELECTOR,
        selector
      });

      if (!validation?.ok) {
        throw new Error(validation?.error || "No element matches that selector on this page");
      }

      const state = startTimer(
        await readState(tabId),
        {
          selector,
          label: validation.label,
          intervalMs: message.intervalMs
        }
      );
      return { ok: true, state: await saveAndBroadcast(state) };
    }

    case MESSAGE.STOP: {
      const state = stopTimer(await readState(tabId));
      return { ok: true, state: await saveAndBroadcast(state) };
    }

    case MESSAGE.CLAIM_CLICK: {
      assertPageSender(sender, tabId);
      const result = claimDueClick(await readState(tabId), {
        selector: message.selector,
        nextRunAt: message.nextRunAt
      });

      if (!result.authorized) {
        return { ok: true, authorized: false, state: result.state };
      }

      return {
        ok: true,
        authorized: true,
        state: await saveAndBroadcast(result.state)
      };
    }

    case MESSAGE.REPORT_STATUS: {
      assertPageSender(sender, tabId);
      const current = await readState(tabId);

      if (!current.running || current.target?.selector !== message.selector) {
        return { ok: true, state: current };
      }

      const state = updateStatus(current, message.status, message.detail);
      return {
        ok: true,
        state: state === current ? current : await saveAndBroadcast(state)
      };
    }

    default:
      throw new Error(`Unknown message type: ${message.type}`);
  }
}

async function handleMessage(message, sender) {
  if (!message || typeof message.type !== "string") {
    throw new TypeError("A message type is required");
  }

  if (message.type === MESSAGE.LIST_TIMERS) {
    return { ok: true, timers: await readRunningTimers() };
  }

  if (message.type === MESSAGE.OPEN_DASHBOARD) {
    return {
      ok: true,
      tabId: await openDashboard(message.capture === true)
    };
  }

  const tabId = resolveTabId(message, sender);
  return serializeTabOperation(
    tabId,
    () => handleTabMessage(message, sender, tabId)
  );
}

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create(
      {
        id: CONTEXT_MENU_ID,
        title: "Select for Persistent Clicker",
        contexts: ["all"],
        documentUrlPatterns: [...PAGE_URL_PATTERNS]
      },
      () => void chrome.runtime.lastError
    );
    chrome.contextMenus.create(
      {
        id: DASHBOARD_CONTEXT_MENU_ID,
        title: "Open timer dashboard",
        contexts: ["action"]
      },
      () => void chrome.runtime.lastError
    );
  });
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId === DASHBOARD_CONTEXT_MENU_ID) {
    void openDashboard().catch(() => undefined);
  } else if (info.menuItemId === CONTEXT_MENU_ID) {
    void handleContextSelection(info, tab);
  }
});

chrome.tabs.onRemoved.addListener((tabId) => {
  void serializeTabOperation(
    tabId,
    () => chrome.storage.session.remove(tabStateKey(tabId))
  ).catch(() => undefined);
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  void handleMessage(message, sender)
    .then(sendResponse)
    .catch((error) => sendResponse({ ok: false, error: errorMessage(error) }));
  return true;
});
