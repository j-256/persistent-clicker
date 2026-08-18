# Chrome Web Store listing

## Name

Persistent Clicker

## Summary

Clicks one selected control on a per-tab interval that survives navigation.

## Detailed description

Persistent Clicker keeps clicking the control you choose, even when each click reloads the page or navigates the tab.

Right-click a button or control and choose "Select for Persistent Clicker" to select it and open the controls popup, or use the popup's visual picker. Set an interval, start the schedule, and leave the tab open. The extension waits for the same selector after each navigation and resumes the cadence without replaying missed clicks.

Use the open-timers dashboard to review every running schedule, return to its tab, or stop it immediately. Schedules remain local to the browser session and disappear when the tab or browser closes.

Persistent Clicker has no accounts, analytics, advertising, or external service. It sends no page data anywhere.

## Single purpose

Automatically click one user-selected control in a browser tab at a user-selected interval, including after that tab reloads or navigates.

## Permission justifications

- `contextMenus`: Adds the command that selects the right-clicked control and the toolbar command that opens the timer dashboard.
- `scripting`: Reconnects the extension to a page that was already open when the extension was installed or reloaded.
- `storage`: Keeps the selector and schedule in session-only storage while the tab and browser remain open.
- HTTP, HTTPS, and file host access: Finds and clicks the selected control after page reloads and navigation. Local file access still requires the user's separate Chrome setting.

## Privacy disclosure

The extension processes website content locally to identify and click the selected control. It stores the selected selector and label, interval, status, next scheduled time, and click count in Chrome session storage. It reads a running tab's title for display in the local dashboard. It does not transmit, sell, or share this data, and no data leaves the browser.

Use `PRIVACY.md` as the privacy policy linked from the Chrome Web Store dashboard.

## Reviewer test instructions

1. Open a regular HTTP or HTTPS page containing a button or link.
2. Right-click that control and choose "Select for Persistent Clicker".
3. Confirm the extension popup opens with that control selected, enter a short interval, and choose "Start clicking".
4. Confirm the control is clicked on schedule. If it navigates, confirm the schedule waits for the same selector and resumes.
5. Choose "View open timers", then use "Show tab" and "Stop timer" to verify dashboard controls.

No account, credential, purchase, or external service is required.
