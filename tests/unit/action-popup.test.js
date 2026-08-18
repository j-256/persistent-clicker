import assert from "node:assert/strict";
import test from "node:test";
import { openPopupAfterSelection } from "../../src/action-popup.js";

const TAB = Object.freeze({ id: 42, windowId: 7 });
const SELECTED_RESPONSE = Object.freeze({
  ok: true,
  state: Object.freeze({
    target: Object.freeze({ selector: "#reload-page", label: "Reload page" })
  })
});

test("opens the action popup after a context-menu target is selected", async () => {
  const calls = [];
  const action = {
    async openPopup(options) {
      calls.push(options);
    }
  };

  assert.equal(
    await openPopupAfterSelection(action, TAB, SELECTED_RESPONSE),
    true
  );
  assert.deepEqual(calls, [{ windowId: TAB.windowId }]);
});

test("leaves the popup closed when selection falls back to pick mode", async () => {
  const action = {
    async openPopup() {
      assert.fail("openPopup must not run without a selected target");
    }
  };

  assert.equal(
    await openPopupAfterSelection(action, TAB, { ok: true }),
    false
  );
});

test("preserves a successful selection when Chrome cannot open the popup", async () => {
  const action = {
    async openPopup() {
      throw new Error("Popup unavailable");
    }
  };

  assert.equal(
    await openPopupAfterSelection(action, TAB, SELECTED_RESPONSE),
    false
  );
});
