# BimClub room control

The dashboard is a Thai-first operational interface for **ห้องประชุม BimClub**. It uses Express, semantic HTML, local CSS and plain JavaScript. No frontend framework or new UI dependency is introduced.

## Visual system

| Role | Token |
| --- | --- |
| Canvas | `#F7F7F5` |
| Surface | `#FFFFFF` |
| Ink | `#171717` |
| Supporting text | `#62625C` |
| Divider | `#DFDFD9` |
| Primary / active | `#A3131A` |
| Pressed / accent text | `#711015` |
| Connected | `#226B45` |
| Waiting | `#85500C` |

Keep the existing Prompt font. Heading 36px desktop / 28px mobile, section headings 22px / 20px, control text 14–16px. Small secondary diagnostic text is 12–13px. Buttons have at least a 44px hit height. Use 8px control radii, 12px section radii, thin dividers and no gradients. Focus is a visible 3px burgundy outline; reduced motion removes transitions.

## Layout and meaning

1. Identity and Thai date/time.
2. Independent MQTT broker and ESP32 device status. Broker connectivity alone never means the device is online. Retained reports are cached, not live.
3. AC controls beside room readings and Engi. On smaller screens the sections stack in reading order.
4. Server-side ON/OFF schedules, once or daily, with Thai time. Editing appears inline; technical destinations are expandable. Deletion uses an inline second step.
5. A single chart combines actual temperature, target and server forecast. Missing live values display `—`; no example data is inserted into the real dashboard.
6. Collapsed work history. CiRA shows the latest evidence at four steps (received, validated, handed to MQTT output, and actually displayed in this browser) before the existing page events. The diagnostic list uses the same dividers and semantic status colors; it stacks on narrow screens. Credits use the three original supplied logos unchanged. `object-fit:contain` preserves their full marks.

Main layout breakpoints are 1050, 800 and 540px, verified at 1440, 1024, 768 and 390px. Touch controls, visible keyboard focus, native form labels, status text and color all contribute to usability. The schedule notes explicitly require the server to remain running.

## Reference and intentional differences

The internal Image Gen concept is a visual reference, not a runtime asset. The implementation preserves its warm canvas, burgundy active controls, white two-column control surface, two independent connection readings, downstream schedule section, single merged chart and footer credits. The actual interface uses current device data or empty states instead of the concept's sample values. Schedules are individual ON or OFF records rather than a paired row, allowing independent dates and daily repetition. Existing temperature presets, local voice feedback and truthful device-report limits remain available. Exact original credit logos replace the concept's text-only placeholders.

## Files and cleanup

- `public/index.html`: semantic layout.
- `public/css/dashboard.css`: presentation and responsive rules.
- `public/js/dashboard.js`: existing transport/voice/forecast presentation extracted from inline source, with demo controls and generated demo readings removed.
- `public/js/ac-schedules.js`: schedule form/list and server status.
- `public/css/cira-logs.css` and `public/js/cira-logs.js`: scoped logs layout, recent browser observations, and read-only Node-RED log polling while expanded and visible. The browser displays capture-time expiry independently of bridge availability.
- `AC_SCHEDULES.md`: scheduler persistence, connection and failure behavior.

Removed the unused `node_red_manual_fast_flow.json` and four `.DS_Store` metadata files. Active CiRA bridge, model metadata, TFLite regression path, Whisper, audio replies and tests are retained because source or tests still use them. Temporary QA scripts and screenshots live outside the project.

## Validation record

- Automated suite: **147 tests passed**, covering local voice, CiRA, forecast and scheduler, including an isolated MQTT wire test. No physical AC commands were issued during QA.
- Chrome screenshots: 1440, 1036 (concept native width), 1024, 768 and 390px; no horizontal overflow, all credit images loaded, all visible buttons at least 44px high. Keyboard focus and reduced motion were checked.
- Schedule interactions: once/daily, add/edit, pause/enable, delete confirmation, past dates, different browser timezone, destination mismatch and failed save. Browser writes used mocked API responses only.
- Voice regression: real Silero and local Whisper received an “เอ็นจี้” test audio stream, played the reply and waited for a command; microphone denial and retry also passed. Hardware publishing was blocked.
- Measured contrast: white on burgundy 7.88:1; muted text on white 6.14:1; muted text on canvas 5.72:1. This is a token measurement, not a claim of a full accessibility audit.
- In-app browser attachment timed out, so browser verification used the installed Playwright/Chrome tooling. Temporary evidence is outside the repository.

### Fidelity review

| Comparison | Concept | Render and decision |
| --- | --- | --- |
| Background and surfaces | Warm neutral canvas, white panels | Matches exact tokens; no blue gradient or glass effect remains |
| Identity | Quiet wordmark, large Thai room title, burgundy rule | Same hierarchy; title reduced to 36px for an operational laptop view |
| Connection region | MQTT and ESP32 side by side | Separate truthful states, stacked on mobile; never inferred from the other status |
| Main control surface | Thermostat left, readings/Engi right | Same composition; temperature presets and device-report detail preserve existing functionality |
| Controls | Burgundy active state, outlined inactive controls | Same family with accessible native buttons; temporary requested values remain identified |
| Scheduling | Full-width section with add and form | Same placement; real empty state and individual ON/OFF records replace the illustrative paired sample |
| Forecast | One chart with dark observations and burgundy future line | Same composition and palette; shows computed times and explains uncertainty |
| Credits | SOE / IT / BimClub footer | Original supplied images replace text placeholders without cropping their marks |
