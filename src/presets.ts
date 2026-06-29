import {
  combineRgb,
  type CompanionPresetDefinitions,
  type CompanionPresetSection,
} from "@companion-module/base";
import { ICONS } from "./icons.js";
import { FEEDBACK } from "./constants.js";

export function getPresetSections(): CompanionPresetSection[] {
  return [
    {
      id: "transport",
      name: "Transport",
      definitions: ["play_pause", "reset", "fast_forward", "rewind", "next_marker", "prev_marker", "blackout_toggle"],
    },
    {
      id: "speed",
      name: "Speed",
      definitions: ["speed_display", "speed_up", "speed_down"],
    },
    {
      id: "info",
      name: "Info & Timers",
      definitions: ["connection_status", "script_title_display", "progress_display", "elapsed_time", "remaining_time", "font_size_display", "line_height_display", "margin_display"],
    },
    {
      id: "encoders",
      name: "Encoders / Knobs",
      definitions: ["speed_knob", "jog_wheel", "font_size_knob", "line_height_knob", "margin_knob"],
    },
    {
      id: "scripts",
      name: "Scripts",
      definitions: ["load_script"],
    },
  ];
}

export function getPresetDefinitions(): CompanionPresetDefinitions {
  // ── Color palette ──
  const white = combineRgb(255, 255, 255);
  const black = combineRgb(0, 0, 0);
  const cyan = combineRgb(0, 229, 255);
  const green = combineRgb(0, 204, 0);
  const darkGreen = combineRgb(0, 40, 0);
  const blue = combineRgb(0, 60, 160);
  const purple = combineRgb(60, 0, 100);

  return {
    // --- Transport ---
    play_pause: {
      type: "simple",
      name: "Play / Pause",
      style: {
        text: "",
        size: 14,
        color: white,
        bgcolor: black,
        show_topbar: false,
        png64: ICONS.play,
      },
      steps: [
        {
          down: [{ actionId: "play_pause", options: {} }],
          up: [],
        },
      ],
      feedbacks: [
        {
          feedbackId: FEEDBACK.IS_PLAYING,
          options: {},
          style: {
            bgcolor: green,
            color: black,
            png64: ICONS.pause,
          },
        },
      ],
    },

    reset: {
      type: "simple",
      name: "Reset to Start",
      style: {
        text: "",
        size: 14,
        color: white,
        bgcolor: black,
        show_topbar: false,
        png64: ICONS.reset,
      },
      steps: [
        {
          down: [{ actionId: "reset", options: {} }],
          up: [],
        },
      ],
      feedbacks: [],
    },

    next_marker: {
      type: "simple",
      name: "Next Marker",
      style: {
        text: "",
        size: 14,
        color: white,
        bgcolor: black,
        show_topbar: false,
        png64: ICONS.skip_forward,
      },
      steps: [
        {
          down: [{ actionId: "next_marker", options: {} }],
          up: [],
        },
      ],
      feedbacks: [],
    },

    prev_marker: {
      type: "simple",
      name: "Previous Marker",
      style: {
        text: "",
        size: 14,
        color: white,
        bgcolor: black,
        show_topbar: false,
        png64: ICONS.skip_back,
      },
      steps: [
        {
          down: [{ actionId: "prev_marker", options: {} }],
          up: [],
        },
      ],
      feedbacks: [],
    },

    // --- Shuttle (hold to activate, release to stop) ---
    fast_forward: {
      type: "simple",
      name: "Fast Forward (Hold)",
      style: {
        text: "",
        size: 14,
        color: white,
        bgcolor: black,
        show_topbar: false,
        png64: ICONS.fast_forward,
      },
      steps: [
        {
          down: [{ actionId: "fast_forward_start", options: { rate: 1.0 } }],
          up: [{ actionId: "fast_forward_stop", options: {} }],
        },
      ],
      feedbacks: [],
    },

    rewind: {
      type: "simple",
      name: "Rewind (Hold)",
      style: {
        text: "",
        size: 14,
        color: white,
        bgcolor: black,
        show_topbar: false,
        png64: ICONS.rewind,
      },
      steps: [
        {
          down: [{ actionId: "rewind_start", options: { rate: 1.0 } }],
          up: [{ actionId: "rewind_stop", options: {} }],
        },
      ],
      feedbacks: [],
    },

    // --- Speed ---
    speed_display: {
      type: "simple",
      name: "Speed Display",
      style: {
        text: "SPEED\\n$(easyprompter:speed)",
        size: 14,
        color: white,
        bgcolor: blue,
        show_topbar: false,
        png64: ICONS.gauge,
        alignment: "center:bottom",
      },
      steps: [],
      feedbacks: [],
    },

    speed_up: {
      type: "simple",
      name: "Speed Up",
      style: {
        text: "Faster",
        size: 14,
        color: white,
        bgcolor: black,
        show_topbar: false,
        png64: ICONS.gauge_small,
        alignment: "center:bottom",
      },
      steps: [
        {
          down: [{ actionId: "speed_up", options: { step: 5 } }],
          up: [],
        },
      ],
      feedbacks: [],
    },

    speed_down: {
      type: "simple",
      name: "Speed Down",
      style: {
        text: "Slower",
        size: 14,
        color: white,
        bgcolor: black,
        show_topbar: false,
        png64: ICONS.gauge_small_flip,
        alignment: "center:bottom",
      },
      steps: [
        {
          down: [{ actionId: "speed_down", options: { step: 5 } }],
          up: [],
        },
      ],
      feedbacks: [],
    },

    // --- Timer ---
    elapsed_time: {
      type: "simple",
      name: "Elapsed Time",
      style: {
        text: "+$(easyprompter:elapsed)",
        size: 18,
        color: cyan,
        bgcolor: black,
        show_topbar: false,
        png64: ICONS.logo_top,
        alignment: "center:center",
      },
      steps: [],
      feedbacks: [],
    },

    remaining_time: {
      type: "simple",
      name: "Remaining Time",
      style: {
        text: "−$(easyprompter:remaining)",
        size: 18,
        color: cyan,
        bgcolor: black,
        show_topbar: false,
        png64: ICONS.logo_top,
        alignment: "center:center",
      },
      steps: [],
      feedbacks: [],
    },

    // --- Status ---
    connection_status: {
      type: "simple",
      name: "Connection Status",
      style: {
        text: "$(easyprompter:status)",
        size: 14,
        color: white,
        bgcolor: black,
        show_topbar: false,
        png64: ICONS.radio,
        alignment: "center:bottom",
      },
      steps: [],
      feedbacks: [
        {
          feedbackId: FEEDBACK.IS_CONNECTED,
          options: {},
          style: {
            bgcolor: combineRgb(0, 100, 200),
          },
        },
        {
          feedbackId: FEEDBACK.IS_WAITING,
          options: {},
          style: {
            bgcolor: combineRgb(200, 200, 0),
            color: black,
          },
        },
      ],
    },

    // --- Encoders / Knobs ---
    speed_knob: {
      type: "simple",
      name: "Speed Knob",
      style: {
        text: "SPEED\\n$(easyprompter:speed)",
        size: 14,
        color: white,
        bgcolor: blue,
        show_topbar: false,
        png64: ICONS.gauge,
        alignment: "center:bottom",
      },
      steps: [
        {
          down: [{ actionId: "play_pause", options: {} }],
          up: [],
          rotate_left: [{ actionId: "speed_down", options: { step: 5 } }],
          rotate_right: [{ actionId: "speed_up", options: { step: 5 } }],
        },
      ],
      feedbacks: [
        {
          feedbackId: FEEDBACK.IS_PLAYING,
          options: {},
          style: {
            bgcolor: darkGreen,
            color: green,
          },
        },
      ],
    },

    jog_wheel: {
      type: "simple",
      name: "Jog Wheel",
      style: {
        text: "JOG\\n$(easyprompter:status)",
        size: 14,
        color: white,
        bgcolor: purple,
        show_topbar: false,
        png64: ICONS.rotate_cw,
        alignment: "center:bottom",
      },
      steps: [
        {
          down: [{ actionId: "play_pause", options: {} }],
          up: [],
          rotate_left: [{ actionId: "jog_tick", options: { direction: "-1", magnitude: 1 } }],
          rotate_right: [{ actionId: "jog_tick", options: { direction: "1", magnitude: 1 } }],
        },
      ],
      feedbacks: [],
    },

    font_size_knob: {
      type: "simple",
      name: "Font Size Knob",
      style: {
        text: "FONT\\n$(easyprompter:font_size)px",
        size: 14,
        color: white,
        bgcolor: purple,
        show_topbar: false,
        png64: ICONS.a_large_small,
        alignment: "center:bottom",
      },
      steps: [
        {
          down: [],
          up: [],
          rotate_left: [{ actionId: "font_size_down", options: { step: 2 } }],
          rotate_right: [{ actionId: "font_size_up", options: { step: 2 } }],
        },
      ],
      feedbacks: [],
    },

    line_height_knob: {
      type: "simple",
      name: "Line Height Knob",
      style: {
        text: "LINE\\n$(easyprompter:line_height)%",
        size: 14,
        color: white,
        bgcolor: purple,
        show_topbar: false,
        png64: ICONS.list_chevrons,
        alignment: "center:bottom",
      },
      steps: [
        {
          down: [],
          up: [],
          rotate_left: [{ actionId: "line_height_down", options: { step: 10 } }],
          rotate_right: [{ actionId: "line_height_up", options: { step: 10 } }],
        },
      ],
      feedbacks: [],
    },

    margin_knob: {
      type: "simple",
      name: "Margin Knob",
      style: {
        text: "MARGIN\\n$(easyprompter:screen_margin)%",
        size: 14,
        color: white,
        bgcolor: purple,
        show_topbar: false,
        png64: ICONS.align_h_space,
        alignment: "center:bottom",
      },
      steps: [
        {
          down: [],
          up: [],
          rotate_left: [{ actionId: "margin_down", options: { step: 5 } }],
          rotate_right: [{ actionId: "margin_up", options: { step: 5 } }],
        },
      ],
      feedbacks: [],
    },

    // --- Info ---
    script_title_display: {
      type: "simple",
      name: "Current Script Title",
      style: {
        text: "$(easyprompter:script_title)",
        size: "auto",
        color: white,
        bgcolor: black,
        show_topbar: false,
      },
      steps: [],
      feedbacks: [],
    },

    progress_display: {
      type: "simple",
      name: "Progress",
      style: {
        text: "$(easyprompter:progress)%",
        size: 24,
        color: cyan,
        bgcolor: black,
        show_topbar: false,
        png64: ICONS.logo_top,
        alignment: "center:center",
      },
      steps: [],
      feedbacks: [],
    },

    font_size_display: {
      type: "simple",
      name: "Font Size Display",
      style: {
        text: "FONT\\n$(easyprompter:font_size)px",
        size: 14,
        color: white,
        bgcolor: blue,
        show_topbar: false,
        png64: ICONS.a_large_small,
        alignment: "center:bottom",
      },
      steps: [],
      feedbacks: [],
    },

    line_height_display: {
      type: "simple",
      name: "Line Height Display",
      style: {
        text: "LINE HT\\n$(easyprompter:line_height)%",
        size: 14,
        color: white,
        bgcolor: blue,
        show_topbar: false,
        png64: ICONS.list_chevrons,
        alignment: "center:bottom",
      },
      steps: [],
      feedbacks: [],
    },

    margin_display: {
      type: "simple",
      name: "Margin Display",
      style: {
        text: "MARGIN\\n$(easyprompter:screen_margin)%",
        size: 14,
        color: white,
        bgcolor: blue,
        show_topbar: false,
        png64: ICONS.align_h_space,
        alignment: "center:bottom",
      },
      steps: [],
      feedbacks: [],
    },

    // --- Blackout ---
    blackout_toggle: {
      type: "simple",
      name: "Blackout",
      style: {
        text: "",
        size: 14,
        color: white,
        bgcolor: black,
        show_topbar: false,
        png64: ICONS.eye,
      },
      steps: [
        {
          down: [{ actionId: "blackout_toggle", options: {} }],
          up: [],
        },
      ],
      feedbacks: [
        {
          feedbackId: FEEDBACK.IS_BLACKOUT,
          options: {},
          style: {
            bgcolor: combineRgb(204, 0, 0),
            color: white,
            png64: ICONS.eye_off,
          },
        },
      ],
    },

    // --- Scripts ---
    load_script: {
      type: "simple",
      name: "Load Script",
      style: {
        text: "LOAD SCRIPT",
        size: 14,
        color: combineRgb(255, 255, 255),
        bgcolor: combineRgb(30, 30, 30),
        png64: ICONS.bar_teal,
        pngalignment: "center:top",
        show_topbar: false,
      },
      steps: [
        {
          down: [{ actionId: "load_script", options: { scriptId: "" } }],
          up: [],
        },
      ],
      feedbacks: [
        {
          feedbackId: FEEDBACK.IS_ACTIVE_SCRIPT,
          options: {},
          style: {
            png64: ICONS.bar_green,
            pngalignment: "center:top",
          },
        },
        {
          feedbackId: FEEDBACK.IS_LOADING_SCRIPT,
          options: {},
          style: {
            png64: ICONS.bar_orange,
            pngalignment: "center:top",
          },
        },
        {
          feedbackId: FEEDBACK.IS_FAILED_SCRIPT,
          options: {},
          style: {
            png64: ICONS.bar_red,
            pngalignment: "center:top",
          },
        },
      ],
    },
  };
}
