import type { SomeCompanionConfigField } from "@companion-module/base";

/**
 * Module configuration — server URL and integration key.
 */
export interface EasyPrompterConfig {
  /** The base URL of the EasyPrompter instance */
  serverUrl: string;
  /** Integration key for remote control authentication */
  apiKey: string;
}

export function getConfigFields(): SomeCompanionConfigField[] {
  return [
    {
      type: "textinput",
      id: "serverUrl",
      label: "Server URL",
      width: 8,
      default: "https://app.easyprompter.com",
    },
    {
      type: "textinput",
      id: "apiKey",
      label: "Integration Key",
      width: 12,
    },
  ];
}
