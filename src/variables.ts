import type { CompanionVariableDefinitions } from "@companion-module/base";

export function getVariableDefinitions(): CompanionVariableDefinitions {
  return {
    speed: { name: "Current Speed" },
    status: { name: "Connection Status" },
    elapsed: { name: "Elapsed Time" },
    remaining: { name: "Remaining Time" },
    progress: { name: "Progress (%)" },
    is_playing: { name: "Playing State" },
    font_size: { name: "Font Size (px)" },
    line_height: { name: "Line Height (%)" },
    script_title: { name: "Current Script Title" },
    script_id: { name: "Script ID" },
    blackout: { name: "Blackout State" },
    screen_margin: { name: "Screen Margin (%)" },
  };
}
