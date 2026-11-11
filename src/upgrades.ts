import type { CompanionStaticUpgradeScript } from '@companion-module/base'
import type { EasyPrompterConfig } from './config.js'

/**
 * Module upgrade scripts.
 * Add entries here when a config/action/feedback schema changes between releases.
 * Each entry runs once per instance, in order, to migrate persisted data.
 */
const LEGACY_DEFAULT_SERVER_URL = 'https://app.easyprompter.com'
const DEFAULT_SERVER_URL = 'https://easyprompter.com'

const migrateLegacyDefaults: CompanionStaticUpgradeScript<EasyPrompterConfig> = (_context, props) => {
	const updatedConfig =
		props.config?.serverUrl === LEGACY_DEFAULT_SERVER_URL ? { ...props.config, serverUrl: DEFAULT_SERVER_URL } : null

	const updatedActions = props.actions
		.filter(
			(action) =>
				(action.actionId === 'fast_forward_start' || action.actionId === 'rewind_start') && 'rate' in action.options,
		)
		.map((action) => {
			const options = { ...action.options }
			delete options.rate
			return { ...action, options }
		})

	return {
		updatedConfig,
		updatedActions,
		updatedFeedbacks: [],
	}
}

export const UpgradeScripts: CompanionStaticUpgradeScript<EasyPrompterConfig>[] = [migrateLegacyDefaults]
