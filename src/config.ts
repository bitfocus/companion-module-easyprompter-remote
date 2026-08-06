import type { SomeCompanionConfigField } from '@companion-module/base'

/**
 * Module configuration — server URL (config store).
 * Using `type` (not `interface`) so it satisfies the JsonObject constraint.
 */
export type EasyPrompterConfig = {
	/** The base URL of the EasyPrompter instance */
	serverUrl: string
}

/**
 * Module secrets — integration key (secrets store).
 * Fields using `secret-text` type are stored here, not in config.
 */
export type EasyPrompterSecrets = {
	/** Integration key for remote control authentication */
	apiKey: string
}

export function getConfigFields(): SomeCompanionConfigField[] {
	return [
		{
			type: 'textinput',
			id: 'serverUrl',
			label: 'Server URL',
			width: 8,
			default: 'https://easyprompter.com',
		},
		{
			type: 'secret-text',
			id: 'apiKey',
			label: 'Integration Key',
			width: 12,
		},
	]
}
