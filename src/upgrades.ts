import type { CompanionStaticUpgradeScript } from '@companion-module/base'
import type { EasyPrompterConfig } from './config.js'

/**
 * Module upgrade scripts.
 * Add entries here when a config/action/feedback schema changes between releases.
 * Each entry runs once per instance, in order, to migrate persisted data.
 */
export const UpgradeScripts: CompanionStaticUpgradeScript<EasyPrompterConfig>[] = []
