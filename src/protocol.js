export const MESSAGE = Object.freeze({
  CLAIM_CLICK: "claim-click",
  DESCRIBE_PAGE: "describe-page",
  ENTER_PICK_MODE: "enter-pick-mode",
  FOCUS_TAB: "focus-tab",
  GET_STATE: "get-state",
  LIST_TIMERS: "list-timers",
  OPEN_DASHBOARD: "open-dashboard",
  PAGE_STATE: "page-state",
  REPORT_STATUS: "report-status",
  SELECT_CONTEXT_TARGET: "select-context-target",
  SELECT_TARGET: "select-target",
  START: "start",
  STOP: "stop",
  VALIDATE_SELECTOR: "validate-selector"
});

export const CONTEXT_MENU_ID = "persistent-clicker-select-target";
export const DASHBOARD_CONTEXT_MENU_ID = "persistent-clicker-open-dashboard";

export const PAGE_URL_PATTERNS = Object.freeze([
  "http://*/*",
  "https://*/*",
  "file:///*"
]);
