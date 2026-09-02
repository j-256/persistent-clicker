# Repository instructions

## Read first

Read `README.md`, `PRIVACY.md`, and `store-assets/listing.md` before changing behavior, permissions, storage, or packaging. Persistent Clicker's single purpose is to click one explicitly selected control on a user-selected interval in each tab, including across navigation. Its session-only, local-only data handling is a product and store-review contract.

Keep the README, privacy policy, store listing, manifest permission justifications, and implementation synchronized whenever user-visible behavior or data handling changes.

## Product, permission, and privacy boundaries

- Preserve explicit user control: selection alone pauses the existing schedule, and clicking begins only after the user starts or restarts it. Do not broaden the extension into arbitrary script execution, page automation, background discovery, or cross-tab targeting.
- Keep selectors, bounded labels, schedule state, status, and click history in `chrome.storage.session`, keyed by tab ID. Read a tab title only to identify a running timer in the local dashboard. Do not move this data to local or sync storage.
- Do not add accounts, telemetry, analytics, advertising, external services, or runtime network requests. Page data, selectors, tab titles, schedules, and usage details must remain inside the browser.
- Preserve the minimal manifest surface: `contextMenus`, `scripting`, and `storage`, with host access limited to HTTP, HTTPS, and user-enabled file pages. The content script and recovery injection remain top-level only; do not expand into frames, internal browser pages, or additional schemes without an explicit product decision and matching privacy, listing, validation, and test changes.
- Treat page titles, labels, selectors, status details, and errors as untrusted text. Render them with `textContent`, template cloning, or equivalent escaping, never `innerHTML` or executable markup.

## State and message protocol

- The background service worker owns canonical state. Keep state versioned and normalized at the storage boundary so malformed or stale values fall back safely instead of becoming running schedules.
- Serialize state-changing operations per tab. Selection, start, stop, click claims, status reports, tab removal, and dashboard actions must not race each other through read-modify-write cycles.
- Keep state-changing content-script messages bound to the sender's tab and top-level frame. Do not trust a caller-supplied tab ID for page-originated selection, click claims, or status reports.
- `src/protocol.js` is the shared protocol for extension pages and the background worker. `src/content.js` is a non-module manifest content script and duplicates its message names and relevant status values; update both sides together and exercise the complete message flow.
- Preserve one schedule per tab. Selecting a new target stops and resets the prior schedule; stopping retains the selected target and click history so the user can resume deliberately.
- Keep reinjection recovery limited to the declared content script and stylesheet in frame zero. The global content-script marker must continue to make repeated injection idempotent.

## Scheduling and click safety

- Use the stored absolute `nextRunAt` and a single content-script timeout. Do not replace this with a page-local interval or make the service worker's lifetime responsible for timer cadence.
- Before every DOM click, claim the exact selector and expected due time from the background worker. The worker must persist the advanced schedule and click count before authorizing the page to dispatch the click; stale, early, or duplicate claims must remain unauthorized.
- Keep late clicks anchored to the original cadence while skipping missed intervals. Never replay accumulated clicks after a suspended tab, navigation, hidden target, or delayed process wake-up.
- A missing, disconnected, hidden, or disabled target stays in a non-clicking waiting state and is retried without claiming a click. Re-query and re-check readiness after authorization before dispatching.
- Preserve normal element activation through `element.click()` with the existing event fallback. Do not synthesize broader pointer, keyboard, form, or navigation behavior that the user did not select.

## Selection and interface behavior

- Generate selectors from a unique ID or stable attribute when possible, then fall back to a unique structural path. Keep labels normalized and bounded; do not persist surrounding page content.
- Context-menu and visual-picker selection apply to the nearest actionable control in the top-level page. Picker listeners, highlights, and prompts must be removed when selection finishes or is canceled, and picker toasts must remove themselves after their bounded display period.
- Validate an edited selector against the target page before starting. Invalid or unmatched selectors must not create a running schedule.
- Context-menu selection may ask Chrome to open the action popup, but a popup failure must not discard the saved selection. Keep the manifest's minimum Chrome version aligned with the API floor enforced by validation.
- Keep popup and dashboard polling from overwriting fields the user is actively editing, and keep all dashboard stop and focus actions scoped to the timer's tab ID.

## Packaging and generated artifacts

- `scripts/package-files.mjs` is the authoritative allowlist for the Chrome Web Store archive. Add a runtime file there deliberately; do not package tests, fixtures, screenshots, store copy, development scripts, `node_modules`, or other repository content.
- Preserve deterministic package timestamps and exact archive membership, with `manifest.json` at the archive root. `dist/` is generated and ignored.
- Keep the extension free of runtime npm dependencies and remote assets. Development dependencies support testing and packaging only.
- Keep `package.json` and `manifest.json` versions identical. Use the version synchronization script through the guarded release workflow rather than editing only one file for a release.

## Verification and releases

- Use `npm ci` in a fresh checkout or worktree, and run `npm test` for repository changes. It covers unit behavior, manifest and permission policy, packaged-file requirements, documentation paths, asset dimensions, and JavaScript syntax.
- Install the version-matched test browser with `npm run browser:install` when needed. Run `npm run verify` for source-extension behavior changes, especially selection, reload recovery, timing, dashboard control, or extension lifecycle changes.
- Run `npm run release:check` for packaging or release-ready changes. It creates the deterministic archive and exercises the extracted package in an isolated temporary Chrome profile.
- Use only the local deterministic fixture in browser tests and screenshots. `npm run screenshots` is a headed capture workflow that also records Chrome's native context menu; refresh the related documentation and store assets when visible behavior changes.
- Use `npm version` only for an explicitly requested release. It requires a clean synchronized `main`, runs the release check, synchronizes the manifest, creates the version commit and tag, and pushes both refs; it is not a harmless version-edit or verification command.
