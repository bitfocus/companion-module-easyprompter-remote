import type { CompanionActionDefinitions } from "@companion-module/base";
import type { EasyPrompterModule } from "./index.js";
import { MIN_SPEED, MAX_SPEED, SCRIPT_FEEDBACKS } from "./constants.js";

const DEFAULT_SPEED_STEP = 5;


export function getActionDefinitions(
  instance: EasyPrompterModule
): CompanionActionDefinitions {
  return {
    play_pause: {
      name: "Play / Pause",
      options: [],
      callback: () => {
        instance.sendAction({ type: "play_pause" });
      },
    },

    reset: {
      name: "Reset to Start",
      options: [],
      callback: () => {
        instance.sendAction({ type: "reset" });
      },
    },

    next_marker: {
      name: "Next Marker",
      options: [],
      callback: () => {
        instance.sendAction({ type: "next_marker" });
      },
    },

    prev_marker: {
      name: "Previous Marker",
      options: [],
      callback: () => {
        instance.sendAction({ type: "prev_marker" });
      },
    },

    speed_up: {
      name: "Speed Up",
      options: [
        {
          type: "number",
          label: "Step",
          id: "step",
          default: DEFAULT_SPEED_STEP,
          min: 1,
          max: 50,
        },
      ],
      callback: (action) => {
        const step = (action.options.step as number) ?? DEFAULT_SPEED_STEP;
        instance.queueSpeedChange(step);
      },
    },

    speed_down: {
      name: "Speed Down",
      options: [
        {
          type: "number",
          label: "Step",
          id: "step",
          default: DEFAULT_SPEED_STEP,
          min: 1,
          max: 50,
        },
      ],
      callback: (action) => {
        const step = (action.options.step as number) ?? DEFAULT_SPEED_STEP;
        instance.queueSpeedChange(-step);
      },
    },

    set_speed: {
      name: "Set Speed",
      options: [
        {
          type: "number",
          label: "Speed",
          id: "speed",
          default: 150,
          min: MIN_SPEED,
          max: MAX_SPEED,
        },
      ],
      callback: (action) => {
        const speed = Math.max(MIN_SPEED, Math.min(MAX_SPEED, action.options.speed as number));
        instance.sendAction({ type: "set_speed", speedWpm: speed });
      },
    },

    fast_forward_start: {
      name: "Fast Forward (Hold)",
      options: [
        {
          type: "number",
          label: "Rate (0.1 – 1.0)",
          id: "rate",
          default: 1.0,
          min: 0.1,
          max: 1.0,
          step: 0.1,
        },
      ],
      callback: (action) => {
        const rate = (action.options.rate as number) ?? 1.0;
        instance.sendAction({ type: "fast_forward_start", displacement: rate });
      },
    },

    fast_forward_stop: {
      name: "Fast Forward Release",
      options: [],
      callback: () => {
        instance.sendAction({ type: "fast_forward_stop" });
      },
    },

    rewind_start: {
      name: "Rewind (Hold)",
      options: [
        {
          type: "number",
          label: "Rate (0.1 – 1.0)",
          id: "rate",
          default: 1.0,
          min: 0.1,
          max: 1.0,
          step: 0.1,
        },
      ],
      callback: (action) => {
        const rate = (action.options.rate as number) ?? 1.0;
        instance.sendAction({ type: "rewind_start", displacement: rate });
      },
    },

    rewind_stop: {
      name: "Rewind Release",
      options: [],
      callback: () => {
        instance.sendAction({ type: "rewind_stop" });
      },
    },

    shuttle_set: {
      name: "Shuttle Set",
      description: "Set shuttle displacement for continuous scrolling. Use with MIDI controllers or T-bar faders.",
      options: [
        {
          type: "number",
          label: "Displacement (-1.0 to 1.0)",
          id: "displacement",
          default: 0.5,
          min: -1.0,
          max: 1.0,
          step: 0.1,
        },
      ],
      callback: (action) => {
        const displacement = Math.max(-1.0, Math.min(1.0, action.options.displacement as number));
        instance.sendAction({ type: "shuttle_set", displacement });
      },
    },

    shuttle_release: {
      name: "Shuttle Release",
      description: "Release shuttle control, restoring previous playback state.",
      options: [],
      callback: () => {
        instance.sendAction({ type: "shuttle_release" });
      },
    },

    jog_tick: {
      name: "Jog Tick",
      description: "Scroll one step forward or backward. Use with jog wheels or rotary encoders.",
      options: [
        {
          type: "dropdown",
          label: "Direction",
          id: "direction",
          default: "1",
          choices: [
            { id: "1", label: "Forward (down)" },
            { id: "-1", label: "Backward (up)" },
          ],
        },
        {
          type: "number",
          label: "Magnitude (1–5)",
          id: "magnitude",
          default: 1,
          min: 1,
          max: 5,
        },
      ],
      callback: (action) => {
        const direction = (action.options.direction as string) === "-1" ? -1 : 1;
        const magnitude = Math.max(1, Math.min(5, (action.options.magnitude as number) ?? 1));
        instance.sendAction({ type: "jog_tick", direction, magnitude });
      },
    },

    font_size_up: {
      name: "Font Size Up",
      description: "Increase font size by a configurable step (pixels).",
      options: [
        {
          type: "number",
          label: "Step (px)",
          id: "step",
          default: 2,
          min: 1,
          max: 20,
        },
      ],
      callback: (action) => {
        const step = (action.options.step as number) ?? 2;
        instance.sendAction({ type: "font_size_step", delta: step });
      },
    },

    font_size_down: {
      name: "Font Size Down",
      description: "Decrease font size by a configurable step (pixels).",
      options: [
        {
          type: "number",
          label: "Step (px)",
          id: "step",
          default: 2,
          min: 1,
          max: 20,
        },
      ],
      callback: (action) => {
        const step = (action.options.step as number) ?? 2;
        instance.sendAction({ type: "font_size_step", delta: -step });
      },
    },

    line_height_up: {
      name: "Line Height Up",
      description: "Increase line height by a configurable step (percent).",
      options: [
        {
          type: "number",
          label: "Step (%)",
          id: "step",
          default: 10,
          min: 1,
          max: 50,
        },
      ],
      callback: (action) => {
        const step = (action.options.step as number) ?? 10;
        instance.sendAction({ type: "line_height_step", delta: step });
      },
    },

    line_height_down: {
      name: "Line Height Down",
      description: "Decrease line height by a configurable step (percent).",
      options: [
        {
          type: "number",
          label: "Step (%)",
          id: "step",
          default: 10,
          min: 1,
          max: 50,
        },
      ],
      callback: (action) => {
        const step = (action.options.step as number) ?? 10;
        instance.sendAction({ type: "line_height_step", delta: -step });
      },
    },

    blackout_toggle: {
      name: "Blackout Toggle",
      description: "Toggle display blackout — blanks the teleprompter screen.",
      options: [],
      callback: () => {
        instance.sendAction({ type: "blackout_toggle" });
      },
    },

    margin_up: {
      name: "Margin Up",
      description: "Increase screen margin by a configurable step (percent).",
      options: [
        {
          type: "number",
          label: "Step (%)",
          id: "step",
          default: 5,
          min: 1,
          max: 30,
        },
      ],
      callback: (action) => {
        const step = (action.options.step as number) ?? 5;
        instance.sendAction({ type: "margin_step", delta: step });
      },
    },

    margin_down: {
      name: "Margin Down",
      description: "Decrease screen margin by a configurable step (percent).",
      options: [
        {
          type: "number",
          label: "Step (%)",
          id: "step",
          default: 5,
          min: 1,
          max: 30,
        },
      ],
      callback: (action) => {
        const step = (action.options.step as number) ?? 5;
        instance.sendAction({ type: "margin_step", delta: -step });
      },
    },

    load_script: {
      name: "Load Script",
      description: "Switch the teleprompter to a specific script. Set the button text to the script name in the style editor above.",
      options: [
        {
          type: "dropdown",
          label: "Script",
          id: "scriptId",
          default: "",
          choices: [
            { id: "", label: "— Select a script —" },
            ...instance.cachedScripts,
          ],
          tooltip: "Select a script to load.",
        },
      ],
      callback: (action) => {
        const scriptId = (action.options.scriptId as string)?.trim();
        if (!scriptId) return;
        instance.startScriptLoad(scriptId);
      },
      subscribe: (action) => {
        const scriptId = (action.options.scriptId as string)?.trim();
        if (scriptId) {
          instance.subscribedScripts.set(action.controlId, scriptId);
          instance.checkFeedbacks(...SCRIPT_FEEDBACKS);
        }
      },
      unsubscribe: (action) => {
        instance.subscribedScripts.delete(action.controlId);
      },
      optionsToMonitorForSubscribe: ["scriptId"],
    },
  };
}
