(() => {
  "use strict";

  const CONTENT_SCRIPT_MARKER = "__persistentClickerContentScript";

  if (globalThis[CONTENT_SCRIPT_MARKER]) {
    return;
  }

  globalThis[CONTENT_SCRIPT_MARKER] = true;

  const MESSAGE = Object.freeze({
    CLAIM_CLICK: "claim-click",
    DESCRIBE_PAGE: "describe-page",
    ENTER_PICK_MODE: "enter-pick-mode",
    GET_STATE: "get-state",
    PAGE_STATE: "page-state",
    REPORT_STATUS: "report-status",
    SELECT_CONTEXT_TARGET: "select-context-target",
    SELECT_TARGET: "select-target",
    VALIDATE_SELECTOR: "validate-selector"
  });

  const STATE_STATUS = Object.freeze({
    WAITING: "waiting",
    ERROR: "error"
  });

  const ACTIONABLE_SELECTOR = [
    "button",
    "a[href]",
    "input:not([type=\"hidden\"])",
    "select",
    "textarea",
    "[role=\"button\"]",
    "[role=\"link\"]",
    "[onclick]"
  ].join(",");
  const STABLE_ATTRIBUTES = Object.freeze([
    "data-testid",
    "data-test",
    "data-cy",
    "aria-label",
    "name",
    "title"
  ]);
  const MAX_TIMEOUT_MS = 2_147_483_647;
  const TARGET_RETRY_MS = 750;
  const TOAST_DURATION_MS = 2_400;
  const PICK_HIGHLIGHT_ID = "persistent-clicker-highlight";
  const PICK_PROMPT_ID = "persistent-clicker-prompt";
  const TOAST_ID = "persistent-clicker-toast";

  let tabState = null;
  let timerId = null;
  let lastContextTarget = null;
  let lastStatusReport = null;
  let pickMode = null;
  let toastTimerId = null;

  function errorMessage(error) {
    return error instanceof Error ? error.message : String(error);
  }

  async function sendMessage(message) {
    const response = await chrome.runtime.sendMessage(message);

    if (!response?.ok) {
      throw new Error(response?.error || "Persistent Clicker did not respond");
    }

    return response;
  }

  function queryUnique(selector) {
    try {
      const matches = document.querySelectorAll(selector);
      return matches.length === 1 ? matches[0] : null;
    } catch {
      return null;
    }
  }

  function escapeCssString(value) {
    return value
      .replace(/\\/g, "\\\\")
      .replace(/\"/g, "\\\"")
      .replace(/\n/g, "\\a ")
      .replace(/\r/g, "\\d ")
      .replace(/\f/g, "\\c ");
  }

  function structuralSegment(element) {
    const tagName = element.localName;
    const parent = element.parentElement;

    if (!parent) {
      return tagName;
    }

    const siblings = [...parent.children].filter(
      (sibling) => sibling.localName === tagName
    );

    if (siblings.length === 1) {
      return tagName;
    }

    return `${tagName}:nth-of-type(${siblings.indexOf(element) + 1})`;
  }

  function selectorFor(element) {
    if (element.id) {
      const idSelector = `#${CSS.escape(element.id)}`;

      if (queryUnique(idSelector) === element) {
        return idSelector;
      }
    }

    for (const attribute of STABLE_ATTRIBUTES) {
      const value = element.getAttribute(attribute)?.trim();

      if (!value || value.length > 160) {
        continue;
      }

      const candidate = `${element.localName}[${attribute}=\"${escapeCssString(value)}\"]`;

      if (queryUnique(candidate) === element) {
        return candidate;
      }
    }

    const segments = [];
    let current = element;

    while (current && current.nodeType === Node.ELEMENT_NODE) {
      if (current.id) {
        const idSelector = `#${CSS.escape(current.id)}`;

        if (queryUnique(idSelector) === current) {
          segments.unshift(idSelector);
          return segments.join(" > ");
        }
      }

      segments.unshift(structuralSegment(current));
      const candidate = segments.join(" > ");

      if (queryUnique(candidate) === element) {
        return candidate;
      }

      current = current.parentElement;
    }

    return segments.join(" > ");
  }

  function closestActionable(element) {
    return element.closest(ACTIONABLE_SELECTOR) || element;
  }

  function elementFromEvent(event) {
    return event.composedPath().find((candidate) => candidate instanceof Element)
      || (event.target instanceof Element ? event.target : null);
  }

  function labelFor(element) {
    const label = element.getAttribute("aria-label")
      || element.getAttribute("title")
      || ("value" in element && typeof element.value === "string" ? element.value : "")
      || element.textContent
      || element.localName;

    return label.replace(/\s+/g, " ").trim().slice(0, 80) || element.localName;
  }

  function describeTarget(element) {
    if (!(element instanceof Element)) {
      throw new TypeError("Choose an element on the page");
    }

    const actionable = closestActionable(element);
    return {
      selector: selectorFor(actionable),
      label: labelFor(actionable)
    };
  }

  function findTarget(selector) {
    try {
      return document.querySelector(selector);
    } catch {
      return null;
    }
  }

  function isReadyToClick(element) {
    if (!(element instanceof Element)
        || !element.isConnected
        || element.matches(":disabled")
        || element.getAttribute("aria-disabled") === "true") {
      return false;
    }

    const style = getComputedStyle(element);
    const rect = element.getBoundingClientRect();
    return style.display !== "none"
      && style.visibility !== "hidden"
      && Number.parseFloat(style.opacity) !== 0
      && rect.width > 0
      && rect.height > 0;
  }

  function clearTimer() {
    if (timerId !== null) {
      clearTimeout(timerId);
      timerId = null;
    }
  }

  function scheduleFromState() {
    clearTimer();

    if (!tabState?.running || !Number.isFinite(tabState.nextRunAt)) {
      return;
    }

    const overdue = tabState.nextRunAt <= Date.now();
    const retrying = overdue && tabState.status === STATE_STATUS.WAITING;
    const delay = retrying
      ? TARGET_RETRY_MS
      : Math.max(0, tabState.nextRunAt - Date.now());

    timerId = setTimeout(runDueClick, Math.min(delay, MAX_TIMEOUT_MS));
  }

  function scheduleTargetRetry() {
    clearTimer();
    timerId = setTimeout(runDueClick, TARGET_RETRY_MS);
  }

  function applyState(state) {
    tabState = state;
    lastStatusReport = `${state.status}:${state.statusDetail || ""}`;
    scheduleFromState();
  }

  async function reportStatus(status, detail) {
    if (!tabState?.running || !tabState.target) {
      return;
    }

    const reportKey = `${status}:${detail || ""}`;

    if (reportKey === lastStatusReport) {
      return;
    }

    lastStatusReport = reportKey;

    try {
      const response = await sendMessage({
        type: MESSAGE.REPORT_STATUS,
        selector: tabState.target.selector,
        status,
        detail
      });
      tabState = response.state;
    } catch {
      lastStatusReport = null;
    }
  }

  function dispatchClick(element) {
    if (typeof element.click === "function") {
      element.click();
      return;
    }

    element.dispatchEvent(new MouseEvent("click", {
      bubbles: true,
      cancelable: true,
      composed: true,
      view: window
    }));
  }

  async function runDueClick() {
    timerId = null;

    if (!tabState?.running || !tabState.target) {
      return;
    }

    if (Date.now() < tabState.nextRunAt) {
      scheduleFromState();
      return;
    }

    const selector = tabState.target.selector;
    const element = findTarget(selector);

    if (!isReadyToClick(element)) {
      const detail = element
        ? "Target is hidden or disabled"
        : "Target not found on this page";
      await reportStatus(STATE_STATUS.WAITING, detail);
      scheduleTargetRetry();
      return;
    }

    const expectedNextRunAt = tabState.nextRunAt;

    try {
      const response = await sendMessage({
        type: MESSAGE.CLAIM_CLICK,
        selector,
        nextRunAt: expectedNextRunAt
      });

      tabState = response.state;

      if (!response.authorized) {
        scheduleFromState();
        return;
      }

      const currentElement = findTarget(selector);

      if (!isReadyToClick(currentElement)) {
        await reportStatus(STATE_STATUS.ERROR, "Target changed before the click could run");
        scheduleFromState();
        return;
      }

      dispatchClick(currentElement);
      scheduleFromState();
    } catch (error) {
      await reportStatus(STATE_STATUS.ERROR, errorMessage(error));
      scheduleFromState();
    }
  }

  function removeToast() {
    if (toastTimerId !== null) {
      clearTimeout(toastTimerId);
      toastTimerId = null;
    }

    document.getElementById(TOAST_ID)?.remove();
  }

  function showToast(message, tone = "success") {
    removeToast();
    const toast = document.createElement("div");
    toast.id = TOAST_ID;
    toast.dataset.tone = tone;
    toast.textContent = message;
    document.documentElement.append(toast);
    toastTimerId = setTimeout(removeToast, TOAST_DURATION_MS);
  }

  function positionHighlight(element) {
    if (!pickMode) {
      return;
    }

    const target = closestActionable(element);
    const rect = target.getBoundingClientRect();
    pickMode.target = target;
    pickMode.highlight.style.setProperty("left", `${rect.left}px`, "important");
    pickMode.highlight.style.setProperty("top", `${rect.top}px`, "important");
    pickMode.highlight.style.setProperty("width", `${rect.width}px`, "important");
    pickMode.highlight.style.setProperty("height", `${rect.height}px`, "important");
  }

  function leavePickMode() {
    if (!pickMode) {
      return;
    }

    document.removeEventListener("mousemove", pickMode.onMouseMove, true);
    document.removeEventListener("click", pickMode.onClick, true);
    document.removeEventListener("keydown", pickMode.onKeyDown, true);
    window.removeEventListener("resize", pickMode.onViewportChange);
    window.removeEventListener("scroll", pickMode.onViewportChange, true);
    pickMode.highlight.remove();
    pickMode.prompt.remove();
    document.documentElement.classList.remove("persistent-clicker-picking");
    pickMode = null;
  }

  async function saveTarget(target, { openPopup = false } = {}) {
    const response = await sendMessage({
      type: MESSAGE.SELECT_TARGET,
      target,
      openPopup
    });
    applyState(response.state);
    return response;
  }

  function enterPickMode() {
    leavePickMode();

    const highlight = document.createElement("div");
    const prompt = document.createElement("div");
    highlight.id = PICK_HIGHLIGHT_ID;
    prompt.id = PICK_PROMPT_ID;
    prompt.textContent = "Choose what to click  |  Esc to cancel";
    document.documentElement.append(highlight, prompt);
    document.documentElement.classList.add("persistent-clicker-picking");

    const onMouseMove = (event) => {
      const element = elementFromEvent(event);

      if (element) {
        positionHighlight(element);
      }
    };

    const onClick = (event) => {
      event.preventDefault();
      event.stopImmediatePropagation();
      const element = pickMode?.target || elementFromEvent(event);

      if (!element) {
        return;
      }

      const target = describeTarget(element);
      leavePickMode();
      void saveTarget(target)
        .then(() => showToast(`Selected: ${target.label}`))
        .catch((error) => showToast(errorMessage(error), "error"));
    };

    const onKeyDown = (event) => {
      if (event.key === "Escape") {
        event.preventDefault();
        leavePickMode();
        showToast("Selection canceled", "neutral");
      }
    };

    const onViewportChange = () => {
      if (pickMode?.target) {
        positionHighlight(pickMode.target);
      }
    };

    pickMode = {
      target: null,
      highlight,
      prompt,
      onMouseMove,
      onClick,
      onKeyDown,
      onViewportChange
    };

    document.addEventListener("mousemove", onMouseMove, true);
    document.addEventListener("click", onClick, true);
    document.addEventListener("keydown", onKeyDown, true);
    window.addEventListener("resize", onViewportChange);
    window.addEventListener("scroll", onViewportChange, true);
  }

  function validateSelector(selector) {
    try {
      const element = document.querySelector(selector);

      if (!element) {
        return { ok: false, error: "No element matches that selector on this page" };
      }

      return { ok: true, label: labelFor(element) };
    } catch {
      return { ok: false, error: "That CSS selector is not valid" };
    }
  }

  document.addEventListener("contextmenu", (event) => {
    const element = elementFromEvent(event);
    lastContextTarget = element ? describeTarget(element) : null;
  }, true);

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    switch (message?.type) {
      case MESSAGE.PAGE_STATE:
        applyState(message.state);
        sendResponse({ ok: true });
        return false;

      case MESSAGE.DESCRIBE_PAGE:
        sendResponse({
          ok: true,
          title: document.title.replace(/\s+/g, " ").trim().slice(0, 120)
        });
        return false;

      case MESSAGE.VALIDATE_SELECTOR:
        sendResponse(validateSelector(message.selector));
        return false;

      case MESSAGE.ENTER_PICK_MODE:
        enterPickMode();
        sendResponse({ ok: true });
        return false;

      case MESSAGE.SELECT_CONTEXT_TARGET: {
        if (!lastContextTarget) {
          sendResponse({ ok: false, error: "Right-click a control before selecting it" });
          return false;
        }

        const target = lastContextTarget;
        void saveTarget(target, { openPopup: true })
          .then((response) => {
            const message = response.popupOpened === false
              ? `Selected: ${target.label}. Open the extension to continue`
              : `Selected: ${target.label}`;
            showToast(message);
            sendResponse(response);
          })
          .catch((error) => sendResponse({ ok: false, error: errorMessage(error) }));
        return true;
      }

      default:
        return false;
    }
  });

  void sendMessage({ type: MESSAGE.GET_STATE })
    .then((response) => applyState(response.state))
    .catch(() => clearTimer());
})();
