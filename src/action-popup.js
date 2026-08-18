export async function openPopupAfterSelection(action, tab, response) {
  if (!response?.ok || !response.state?.target) {
    return false;
  }

  const options = Number.isInteger(tab?.windowId)
    ? { windowId: tab.windowId }
    : undefined;

  try {
    await action.openPopup(options);
    return true;
  } catch {
    return false;
  }
}
