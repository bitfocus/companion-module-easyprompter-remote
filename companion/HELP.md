# EasyPrompter — Companion Module

Control your EasyPrompter teleprompter directly from Bitfocus Companion. Includes transport controls, speed and display adjustments, script loading, MIDI shuttle/jog support, real-time variables, and ready-made presets.

---

## Setup

1. Add an **EasyPrompter** connection in Companion
2. Enter your **Server URL** (default: `https://easyprompter.com`). Self-hosted users should enter their own server address.
3. Enter your **Integration Key** — find it in EasyPrompter → Settings → Integrations
4. The connection status indicator turns green when connected

---

## Usage

Once connected, the module provides actions, feedbacks, variables, and presets that you can browse in Companion's UI.

- **Actions** — Transport controls (play/pause, reset, markers), speed adjustments, display settings (font size, line height, margin, blackout), script loading, and MIDI-style shuttle/jog controls.
- **Feedbacks** — Boolean feedbacks that change button appearance based on playback state, connection status, blackout, and script loading state.
- **Variables** — Real-time values you can embed in button labels using `$(easyprompter-remote:variableName)` syntax (speed, elapsed/remaining time, progress, script title, etc.).
- **Presets** — Drag-and-drop button presets organized into Transport, Speed, Info/Timers, Encoders, and Scripts categories.

---

## Troubleshooting

- **Status shows "Connecting"** — Check that the Server URL is correct and reachable
- **Status shows "Waiting"** — Connected but no teleprompter session is active; open a script in EasyPrompter
- **Actions don't work** — Ensure a teleprompter session is active (status must be green/connected)
- **Script button stays orange** — Loading timed out after 8 seconds; check your connection and try again
- **Empty script dropdown** — Ensure you have scripts in your EasyPrompter account and that the integration key has access
- **"Integration key rejected"** — The key may have been revoked or the plan doesn't support integrations; check EasyPrompter → Settings → Integrations
