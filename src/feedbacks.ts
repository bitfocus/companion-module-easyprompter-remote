import { combineRgb, type CompanionFeedbackDefinitions } from "@companion-module/base";
import type { EasyPrompterModule } from "./index.js";
import { ICONS } from "./icons.js";
import { FEEDBACK } from "./constants.js";

export function getFeedbackDefinitions(
  instance: EasyPrompterModule
): CompanionFeedbackDefinitions {
  return {
    [FEEDBACK.IS_PLAYING]: {
      type: "boolean",
      name: "Prompter is Playing",
      description: "Changes button style when the teleprompter is playing",
      defaultStyle: {
        bgcolor: combineRgb(0, 204, 0),
        color: combineRgb(0, 0, 0),
      },
      options: [],
      callback: () => {
        return instance.isPlaying;
      },
    },

    [FEEDBACK.IS_CONNECTED]: {
      type: "boolean",
      name: "Connected to Server",
      description: "Changes button style when connected and session is active",
      defaultStyle: {
        bgcolor: combineRgb(0, 100, 200),
        color: combineRgb(255, 255, 255),
      },
      options: [],
      callback: () => {
        return instance.connectionState === "active";
      },
    },

    [FEEDBACK.IS_WAITING]: {
      type: "boolean",
      name: "Waiting for Session",
      description:
        "Changes button style when connected but no session is active",
      defaultStyle: {
        bgcolor: combineRgb(200, 200, 0),
        color: combineRgb(0, 0, 0),
      },
      options: [],
      callback: () => {
        return instance.connectionState === "waiting";
      },
    },

    [FEEDBACK.IS_BLACKOUT]: {
      type: "boolean",
      name: "Blackout Active",
      description: "Changes button style when the display is blacked out",
      defaultStyle: {
        bgcolor: combineRgb(204, 0, 0),
        color: combineRgb(255, 255, 255),
      },
      options: [],
      callback: () => {
        return instance.isBlackout;
      },
    },

    [FEEDBACK.IS_ACTIVE_SCRIPT]: {
      type: "boolean",
      name: "Script is Active",
      description: "Shows green bar when this button's configured script is the currently loaded one",
      defaultStyle: {
        png64: ICONS.bar_green,
        pngalignment: "center:top",
      },
      options: [],
      callback: (feedback) => {
        const scriptId = instance.subscribedScripts.get(feedback.controlId);
        return !!(scriptId && scriptId === instance.currentScriptId);
      },
    },

    [FEEDBACK.IS_LOADING_SCRIPT]: {
      type: "boolean",
      name: "Script is Loading",
      description: "Shows orange bar while this button's configured script is being loaded",
      defaultStyle: {
        png64: ICONS.bar_orange,
        pngalignment: "center:top",
        text: "⏳",
      },
      options: [],
      callback: (feedback) => {
        const scriptId = instance.subscribedScripts.get(feedback.controlId);
        return !!(scriptId && scriptId === instance.loadingScriptId);
      },
    },

    [FEEDBACK.IS_FAILED_SCRIPT]: {
      type: "boolean",
      name: "Script Load Failed",
      description: "Shows red bar when this button's configured script fails to load (timeout)",
      defaultStyle: {
        png64: ICONS.bar_red,
        pngalignment: "center:top",
        text: "✕",
      },
      options: [],
      callback: (feedback) => {
        const scriptId = instance.subscribedScripts.get(feedback.controlId);
        return !!(scriptId && scriptId === instance.failedScriptId);
      },
    },
  };
}
