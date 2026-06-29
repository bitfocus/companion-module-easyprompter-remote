# companion-module-easyprompter-remote

Companion module for controlling [EasyPrompter](https://easyprompter.com) — a professional web-based teleprompter.

## Features

- Transport controls (play/pause, reset, markers, fast forward, rewind)
- Speed adjustment (step, set, knob)
- Display settings (font size, line height, margin, blackout)
- Script loading with status feedback
- MIDI shuttle/jog support
- Real-time variables (speed, timers, progress, status)
- 25 drag-and-drop presets

## Setup

See the **HELP.md** in the `companion/` directory for full setup instructions and usage documentation.

## Development

```bash
yarn install
yarn build
```

To watch for changes during development:

```bash
yarn dev
```

To create a distributable package:

```bash
yarn package
```
