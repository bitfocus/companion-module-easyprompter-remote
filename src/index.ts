import { InstanceBase, InstanceStatus, type SomeCompanionConfigField } from '@companion-module/base'

import {
	EasyPrompterConnection,
	type ConnectionState,
	type Logger,
	type PrompterState,
	type RemoteControlAction,
	type ScriptInfo,
	type SettingsData,
	type TimerData,
} from './remote-client/index.js'

import { type EasyPrompterConfig, type EasyPrompterSecrets, getConfigFields } from './config.js'
import { getActionDefinitions } from './actions.js'
import { getFeedbackDefinitions } from './feedbacks.js'
import { getVariableDefinitions } from './variables.js'
import { getPresetDefinitions, getPresetSections } from './presets.js'
import { MIN_SPEED, MAX_SPEED, SCRIPT_FEEDBACKS } from './constants.js'
import { UpgradeScripts } from './upgrades.js'

/** Internal merged config for convenience (config + secrets). */
interface MergedConfig {
	serverUrl: string
	apiKey: string
}

/**
 * EasyPrompter Companion module.
 * Connects to an EasyPrompter instance via the shared remote-client library
 * and exposes transport controls, speed adjustment, markers, and timer display.
 *
 * H2: Config and secrets are typed through the init/configUpdated signatures
 * using EasyPrompterConfig and EasyPrompterSecrets. The v2 InstanceBase
 * generic is only needed when you want compile-time enforcement of
 * action/feedback IDs in checkFeedbacks(), which we handle with the
 * FEEDBACK/SCRIPT_FEEDBACKS constants.
 */
export class EasyPrompterModule extends InstanceBase {
	private connection: EasyPrompterConnection | null = null
	private config: MergedConfig = { serverUrl: '', apiKey: '' }
	private unsubscribers: (() => void)[] = []

	/** Cached scripts for load_script dropdown */
	cachedScripts: { id: string; label: string }[] = []

	// --- Public state for actions/feedbacks to read ---

	/** Current connection state */
	connectionState: ConnectionState = 'disconnected'
	/** Whether the prompter is currently playing */
	isPlaying = false
	/** Current scroll speed */
	currentSpeed = 150
	/** Whether display is blacked out */
	isBlackout = false
	/** Currently loaded script ID */
	currentScriptId = ''
	/** Currently loaded script title (from server) */
	currentScriptTitle = ''
	/** Script ID currently being loaded (for loading feedback) */
	loadingScriptId = ''
	/** Script ID that failed to load (for failed feedback) */
	failedScriptId = ''
	/** Map of controlId → scriptId for buttons with load_script action */
	subscribedScripts = new Map<string, string>()
	private _loadingTimeout: ReturnType<typeof setTimeout> | null = null
	private _failedTimeout: ReturnType<typeof setTimeout> | null = null

	// --- Speed debounce state ---
	private _speedDelta = 0
	private _speedDebounceTimer: ReturnType<typeof setTimeout> | null = null
	private static readonly SPEED_DEBOUNCE_MS = 80

	// --- Timer sync state ---
	private _displayedElapsed = '00:00'
	private _displayedRemaining = '00:00'
	private _pendingElapsed = '00:00'
	private _pendingRemaining = '00:00'
	private _pendingProgress = '0'
	private _timerSyncTimer: ReturnType<typeof setTimeout> | null = null

	// --- H1: refreshScripts abort/epoch/debounce ---
	private _refreshAbort: AbortController | null = null
	private _configEpoch = 0
	private _scriptsChangedDebounce: ReturnType<typeof setTimeout> | null = null
	/** Track consecutive refresh failures for L8 */
	private _refreshFailures = 0

	// --- Lifecycle ---

	async init(config: EasyPrompterConfig, _isFirstInit: boolean, secrets?: EasyPrompterSecrets): Promise<void> {
		// M6: Only use supplied values, fall back to empty string
		this.config = {
			serverUrl: config?.serverUrl ?? '',
			apiKey: typeof secrets?.apiKey === 'string' ? secrets.apiKey : '',
		}
		this._configEpoch++

		// Set up definitions
		this.setActionDefinitions(getActionDefinitions(this))
		this.setFeedbackDefinitions(getFeedbackDefinitions(this))
		this.setVariableDefinitions(getVariableDefinitions())
		this.setPresetDefinitions(getPresetSections(), getPresetDefinitions())

		// Set initial variable values
		this.setVariableValues({
			speed: '—',
			status: 'Offline',
			elapsed: '00:00',
			remaining: '00:00',
			progress: '0',
			is_playing: 'Paused',
			font_size: '—',
			line_height: '—',
			script_title: '—',
			script_id: '',
			blackout: 'OFF',
			screen_margin: '—',
		})

		// #15: Warn about plaintext key transmission over HTTP
		if (this.config.serverUrl && this.config.serverUrl.startsWith('http://')) {
			this.log('warn', 'Server URL uses HTTP — integration key will be sent in plaintext. Use HTTPS for production.')
		}

		// Connect if configured
		if (this.config.serverUrl && this.config.apiKey) {
			this.connect()
		} else {
			this.updateStatus(InstanceStatus.BadConfig, 'Missing server URL or integration key')
		}
	}

	async configUpdated(config: EasyPrompterConfig, secrets?: EasyPrompterSecrets): Promise<void> {
		// M6: Only overwrite apiKey when a new value is actually supplied
		this.config = {
			serverUrl: config?.serverUrl ?? '',
			apiKey: typeof secrets?.apiKey === 'string' ? secrets.apiKey : this.config.apiKey,
		}
		this._configEpoch++
		this.disconnect()

		if (this.config.serverUrl && this.config.apiKey) {
			this.connect()
		} else {
			this.updateStatus(InstanceStatus.BadConfig, 'Missing server URL or integration key')
		}
	}

	async destroy(): Promise<void> {
		this.subscribedScripts.clear()
		this.disconnect()
	}

	getConfigFields(): SomeCompanionConfigField[] {
		return getConfigFields()
	}

	// --- Public methods for actions ---

	/**
	 * Send a remote control action to the connected EasyPrompter instance.
	 * Called by action callbacks.
	 */
	sendAction(action: RemoteControlAction): void {
		if (!this.connection || this.connectionState !== 'active') {
			this.log('warn', `Cannot send "${action.type}" — not connected`)
			return
		}
		this.connection.sendRemoteControl(action)
	}

	/**
	 * Start loading a script — enters loading state with timeout and failed fallback.
	 */
	startScriptLoad(scriptId: string): void {
		// Already loaded — just refresh feedbacks to show green.
		// Title fallback: only when ID is unresolved AND exactly one script matches
		// (avoids false positives when two scripts share the same title).
		const titleMatches = this.currentScriptTitle
			? this.cachedScripts.filter((s) => s.label === this.currentScriptTitle)
			: []
		const isAlreadyLoaded =
			scriptId === this.currentScriptId ||
			(!this.currentScriptId && titleMatches.length === 1 && titleMatches[0].id === scriptId)

		if (isAlreadyLoaded) {
			this.log('debug', `[LoadScript] Script "${scriptId}" is already loaded — returning success`)
			this.currentScriptId = scriptId
			this.checkFeedbacks(...SCRIPT_FEEDBACKS)
			return
		}

		this.sendAction({ type: 'switch_script', scriptId })

		// Enter loading state
		this.loadingScriptId = scriptId
		this.failedScriptId = ''
		if (this._failedTimeout) {
			clearTimeout(this._failedTimeout)
			this._failedTimeout = null
		}
		this.checkFeedbacks('is_loading_script', 'is_failed_script')

		// Timeout: show failed after 8s
		if (this._loadingTimeout) clearTimeout(this._loadingTimeout)
		this._loadingTimeout = setTimeout(() => {
			if (this.loadingScriptId === scriptId) {
				this.loadingScriptId = ''
				this.failedScriptId = scriptId
				this.checkFeedbacks('is_loading_script', 'is_failed_script')

				// Auto-clear failed after 5s
				this._failedTimeout = setTimeout(() => {
					this.failedScriptId = ''
					this.checkFeedbacks('is_failed_script')
				}, 5000)
			}
		}, 8000)
	}

	private clearLoadingState(): void {
		this.loadingScriptId = ''
		this.failedScriptId = ''
		if (this._loadingTimeout) {
			clearTimeout(this._loadingTimeout)
			this._loadingTimeout = null
		}
		if (this._failedTimeout) {
			clearTimeout(this._failedTimeout)
			this._failedTimeout = null
		}
	}

	/**
	 * Queue a speed change delta. Rapid calls are batched into a single
	 * `set_speed` after a short debounce window.
	 */
	queueSpeedChange(delta: number): void {
		this._speedDelta += delta
		if (this._speedDebounceTimer) {
			clearTimeout(this._speedDebounceTimer)
		}
		this._speedDebounceTimer = setTimeout(() => {
			this._speedDebounceTimer = null
			const d = this._speedDelta
			this._speedDelta = 0
			if (d === 0) return
			const newSpeed = Math.max(MIN_SPEED, Math.min(MAX_SPEED, this.currentSpeed + d))
			this.sendAction({ type: 'set_speed', speedWpm: newSpeed })
		}, EasyPrompterModule.SPEED_DEBOUNCE_MS)
	}

	// --- Private connection management ---

	private connect(): void {
		// Guard against connect() while already connected
		if (this.connection) {
			this.disconnect()
		}

		// Create the connection with Companion's logger
		const logger: Logger = {
			info: (msg) => this.log('info', msg),
			warn: (msg) => this.log('warn', msg),
			error: (msg) => this.log('error', msg),
			debug: (msg) => this.log('debug', msg),
		}

		this.log('info', `Connecting to ${this.config.serverUrl}`)

		this.connection = new EasyPrompterConnection(this.config.serverUrl, this.config.apiKey, logger)

		// Subscribe to connection state changes
		this.unsubscribers.push(
			this.connection.onConnectionStateChange((state: ConnectionState, reason?: string) => {
				this.connectionState = state
				this.updateCompanionStatus(state, reason)
				this.updateStatusVariable(state)
				this.checkFeedbacks('is_connected', 'is_waiting')

				// M4: Reset prompter state when leaving active
				if (state !== 'active') {
					this.resetPrompterState()
				}

				// L2: Refresh scripts on transition to waiting/active (covers reconnects)
				if (state === 'waiting' || state === 'active') {
					void this.refreshScripts()
				}
			}),
		)

		// L1: Set Connecting status AFTER subscription wiring to avoid being immediately overwritten
		this.updateStatus(InstanceStatus.Connecting)

		// Subscribe to prompter state changes
		this.unsubscribers.push(
			this.connection.onStateChange((state: PrompterState) => {
				this.isPlaying = state.isPlaying
				this.currentSpeed = state.speed

				this.setVariableValues({
					speed: String(Math.round(state.speed)),
					is_playing: state.isPlaying ? 'Playing' : 'Paused',
				})

				this.checkFeedbacks('is_playing')
			}),
		)

		// Subscribe to timer updates.
		// Timer strings update at 4Hz from the operator's position pings.
		// Elapsed and remaining cross second boundaries on different pings,
		// causing visual desync (one updates 250ms before the other).
		// Fix: buffer the latest values and only push to Companion variables
		// when BOTH have changed since the last displayed pair.
		this.unsubscribers.push(
			this.connection.onTimerChange((data: TimerData) => {
				const [elapsed, remaining] = EasyPrompterModule.compactTimerPair(
					data.elapsed ?? '00:00',
					data.remaining ?? '00:00',
				)

				// Always update progress immediately (it changes smoothly)
				const progress = data.progress != null ? String(Math.round(data.progress)) : '0'

				const elapsedChanged = elapsed !== this._displayedElapsed
				const remainingChanged = remaining !== this._displayedRemaining

				if (elapsedChanged && remainingChanged) {
					// Both changed — cancel any pending sync timer and push immediately
					if (this._timerSyncTimer) {
						clearTimeout(this._timerSyncTimer)
						this._timerSyncTimer = null
					}
					this._displayedElapsed = elapsed
					this._displayedRemaining = remaining
					this.setVariableValues({ elapsed, remaining, progress })
				} else if (elapsedChanged || remainingChanged) {
					// Only one changed — buffer latest values and wait up to 600ms
					// for the other to catch up on the next ping.
					// elapsed uses floor (ticks at .000) and remaining uses round
					// (ticks at .500), so they're always ~500ms apart.
					this._pendingElapsed = elapsed
					this._pendingRemaining = remaining
					this._pendingProgress = progress
					if (!this._timerSyncTimer) {
						this._timerSyncTimer = setTimeout(() => {
							this._timerSyncTimer = null
							this._displayedElapsed = this._pendingElapsed
							this._displayedRemaining = this._pendingRemaining
							this.setVariableValues({
								elapsed: this._pendingElapsed,
								remaining: this._pendingRemaining,
								progress: this._pendingProgress,
							})
						}, 600)
					}
				} else {
					// Neither changed — just update progress
					this.setVariableValues({ progress })
				}
			}),
		)
		// Subscribe to display settings changes (font size, line height, blackout)
		this.unsubscribers.push(
			this.connection.onSettingsChange((data: SettingsData) => {
				const vars: Record<string, string> = {}
				if (data.fontSize !== undefined) vars.font_size = String(Math.round(data.fontSize))
				if (data.lineHeight !== undefined) vars.line_height = String(Math.round(data.lineHeight))
				if (data.screenMargin !== undefined) vars.screen_margin = String(Math.round(data.screenMargin))
				if (data.blackout !== undefined) {
					this.isBlackout = data.blackout
					vars.blackout = data.blackout ? 'ON' : 'OFF'
					this.checkFeedbacks('is_blackout')
				}
				if (Object.keys(vars).length > 0) {
					this.setVariableValues(vars)
				}
			}),
		)

		// Subscribe to script info changes
		this.unsubscribers.push(
			this.connection.onScriptInfoChange((data: ScriptInfo) => {
				this.log('debug', `Script info received: ${JSON.stringify(data)}`)
				if (data.scriptTitle !== undefined) {
					this.currentScriptTitle = data.scriptTitle || ''
					this.setVariableValues({ script_title: data.scriptTitle || '—' })
				}

				// Server may only send scriptTitle without scriptId.
				// Resolve scriptId from cachedScripts when missing.
				let resolvedScriptId = data.scriptId ?? ''
				if (!resolvedScriptId && data.scriptTitle) {
					const match = this.cachedScripts.find((s) => s.label === data.scriptTitle)
					if (match) resolvedScriptId = match.id
				}

				// Only overwrite currentScriptId when we have a definitive value.
				// Title-only events that arrive before cachedScripts are loaded
				// would otherwise clear a previously resolved ID.
				if (resolvedScriptId || data.scriptId !== undefined) {
					this.currentScriptId = resolvedScriptId
					this.setVariableValues({ script_id: this.currentScriptId })
				}

				this.log(
					'debug',
					`[LoadScript] scriptInfo: currentScriptId="${this.currentScriptId}" loadingScriptId="${this.loadingScriptId}"`,
				)

				// Handle loading state transitions
				if (this.loadingScriptId) {
					if (this.currentScriptId === this.loadingScriptId) {
						this.log('debug', `[LoadScript] Script confirmed loaded — clearing loading state`)
						this.clearLoadingState()
					} else if (this.currentScriptId) {
						this.log('debug', `[LoadScript] Different script loaded (${this.currentScriptId}) — clearing loading`)
						this.clearLoadingState()
					}
					// else: no definitive scriptId yet, keep loading
				}

				this.checkFeedbacks(...SCRIPT_FEEDBACKS)
			}),
		)

		// H1: Debounce scripts_changed notifications (250ms trailing)
		this.unsubscribers.push(
			this.connection.onScriptsChanged(() => {
				if (this._scriptsChangedDebounce) {
					clearTimeout(this._scriptsChangedDebounce)
				}
				this._scriptsChangedDebounce = setTimeout(() => {
					this._scriptsChangedDebounce = null
					void this.refreshScripts()
				}, 250)
			}),
		)

		// Start the connection
		this.connection.connect()
	}

	/**
	 * H1: Fetch user's recent scripts from the API with in-flight guard,
	 * abort support, and config epoch checking.
	 */
	private async refreshScripts(): Promise<void> {
		if (!this.config.serverUrl || !this.config.apiKey) return

		// H1: Abort any in-flight request
		if (this._refreshAbort) {
			this._refreshAbort.abort()
		}
		const controller = new AbortController()
		this._refreshAbort = controller

		// H1: Capture config epoch to detect stale results
		const epoch = this._configEpoch

		try {
			const url = this.config.serverUrl.replace(/\/+$/, '') + '/api/remote-keys/scripts'

			const resp = await fetch(url, {
				headers: { Authorization: 'Bearer ' + this.config.apiKey },
				// H1: Combine abort controller with 10s timeout

				signal: AbortSignal.any([controller.signal, AbortSignal.timeout(10_000)]),
			})

			// H1: Check if config changed while we were fetching
			if (epoch !== this._configEpoch) {
				this.log('debug', '[RefreshScripts] Config changed during fetch — discarding stale result')
				return
			}

			// L8: Report auth failures as BadConfig
			// #18: Only downgrade module status when the socket isn't already active,
			// to avoid overwriting a healthy socket connection's Ok status.
			if (resp.status === 401 || resp.status === 403) {
				this.log('warn', `[RefreshScripts] Integration key rejected (HTTP ${resp.status})`)
				if (this.connectionState !== 'active') {
					this.updateStatus(InstanceStatus.BadConfig, 'Integration key rejected')
				}
				this._refreshFailures++
				return
			}

			if (!resp.ok) {
				this.log('warn', `Failed to fetch scripts: HTTP ${resp.status}`)
				this._refreshFailures++
				// L8: Report repeated network failure
				if (this._refreshFailures >= 3 && this.connectionState !== 'active') {
					this.updateStatus(InstanceStatus.ConnectionFailure, `Script fetch failed (HTTP ${resp.status})`)
				}
				return
			}

			// Success — reset failure counter
			this._refreshFailures = 0

			const data = (await resp.json()) as { scripts?: unknown[] }
			const rawScripts = Array.isArray(data.scripts) ? data.scripts : []
			const newScripts = rawScripts
				.filter(
					(s): s is { id: string; title: string } =>
						typeof s === 'object' &&
						s !== null &&
						typeof (s as Record<string, unknown>).id === 'string' &&
						typeof (s as Record<string, unknown>).title === 'string',
				)
				.map((s) => ({ id: s.id, label: s.title || '(Untitled)' }))

			// H1: Re-check epoch after JSON parsing
			if (epoch !== this._configEpoch) {
				this.log('debug', '[RefreshScripts] Config changed during parse — discarding stale result')
				return
			}

			if (newScripts.length === 0 && this.cachedScripts.length === 0) {
				this.log('warn', '[RefreshScripts] No scripts found — ensure scripts exist in your EasyPrompter account')
			}

			// Skip action/feedback redefinition if the list hasn't changed
			const changed = JSON.stringify(newScripts) !== JSON.stringify(this.cachedScripts)
			this.cachedScripts = newScripts

			if (changed) {
				this.setActionDefinitions(getActionDefinitions(this))
				this.setFeedbackDefinitions(getFeedbackDefinitions(this))
			}

			// Re-resolve currentScriptId in case scriptInfo arrived before scripts were cached
			if (!this.currentScriptId && this.currentScriptTitle) {
				const match = this.cachedScripts.find((s) => s.label === this.currentScriptTitle)
				if (match) {
					this.currentScriptId = match.id
					this.setVariableValues({ script_id: this.currentScriptId })
					this.log(
						'debug',
						`[RefreshScripts] Resolved currentScriptId="${match.id}" from title "${this.currentScriptTitle}"`,
					)
				}
			}
			this.checkFeedbacks(...SCRIPT_FEEDBACKS)

			this.log(
				'debug',
				`Refreshed scripts: ${this.cachedScripts.length} found, currentScriptId="${this.currentScriptId}"`,
			)
		} catch (err) {
			// Don't log aborted requests (normal cancellation)
			if (err instanceof Error && err.name === 'AbortError') return
			this.log('warn', `Failed to fetch scripts: ${err}`)
			this._refreshFailures++
			// L8: Report repeated network failure
			if (this._refreshFailures >= 3 && this.connectionState !== 'active') {
				this.updateStatus(InstanceStatus.ConnectionFailure, `Script fetch failed: ${err}`)
			}
		} finally {
			if (this._refreshAbort === controller) {
				this._refreshAbort = null
			}
		}
	}

	/**
	 * M4: Reset prompter-specific state when leaving the active connection state.
	 * Called from the connection-state listener on any non-active transition.
	 */
	private resetPrompterState(): void {
		this.isPlaying = false
		this.isBlackout = false

		// Clear timer sync
		if (this._timerSyncTimer) {
			clearTimeout(this._timerSyncTimer)
			this._timerSyncTimer = null
		}
		this._displayedElapsed = '00:00'
		this._displayedRemaining = '00:00'
		this._pendingElapsed = '00:00'
		this._pendingRemaining = '00:00'
		this._pendingProgress = '0'

		this.setVariableValues({
			is_playing: 'Paused',
			speed: '—',
			blackout: 'OFF',
		})
		this.checkFeedbacks('is_playing', 'is_blackout', ...SCRIPT_FEEDBACKS)
	}

	private disconnect(): void {
		// Unsubscribe all listeners
		for (const unsub of this.unsubscribers) {
			unsub()
		}
		this.unsubscribers = []

		// H1: Abort any in-flight refreshScripts
		if (this._refreshAbort) {
			this._refreshAbort.abort()
			this._refreshAbort = null
		}
		if (this._scriptsChangedDebounce) {
			clearTimeout(this._scriptsChangedDebounce)
			this._scriptsChangedDebounce = null
		}

		// Disconnect and clean up
		if (this.connection) {
			this.connection.disconnect()
			this.connection = null
		}

		// Reset state
		this.connectionState = 'disconnected'
		this.isPlaying = false
		this.isBlackout = false
		this.currentSpeed = 150
		this.currentScriptId = ''
		this.currentScriptTitle = ''
		this._refreshFailures = 0

		// Clear timer sync and reset displayed values
		if (this._timerSyncTimer) {
			clearTimeout(this._timerSyncTimer)
			this._timerSyncTimer = null
		}
		this._displayedElapsed = '00:00'
		this._displayedRemaining = '00:00'
		this._pendingElapsed = '00:00'
		this._pendingRemaining = '00:00'
		this._pendingProgress = '0'

		// Clear speed debounce
		if (this._speedDebounceTimer) {
			clearTimeout(this._speedDebounceTimer)
			this._speedDebounceTimer = null
		}
		this._speedDelta = 0

		// Clear loading/failed timers
		if (this._loadingTimeout) {
			clearTimeout(this._loadingTimeout)
			this._loadingTimeout = null
		}
		if (this._failedTimeout) {
			clearTimeout(this._failedTimeout)
			this._failedTimeout = null
		}

		this.loadingScriptId = ''
		this.failedScriptId = ''

		// Only reset connection-dependent values; keep last-known progress,
		// timer, and display settings so they persist across
		// reconnects rather than flashing to zero.
		this.setVariableValues({
			speed: '—',
			status: 'Offline',
			is_playing: 'Paused',
			blackout: 'OFF',
		})
	}

	/**
	 * Map remote-client ConnectionState to Companion InstanceStatus.
	 * L5: Now accepts an optional reason for error display.
	 */
	private updateCompanionStatus(state: ConnectionState, reason?: string): void {
		switch (state) {
			case 'active':
				this.updateStatus(InstanceStatus.Ok)
				break
			case 'waiting':
				this.updateStatus(InstanceStatus.Ok, 'Waiting for teleprompter session')
				break
			case 'disconnected':
				this.updateStatus(InstanceStatus.Disconnected)
				break
			case 'error': {
				// L5: Auth errors are config problems, not connection failures
				const isAuthError =
					reason === 'INVALID_REMOTE_KEY' ||
					reason === 'REMOTE_KEY_REVOKED' ||
					reason === 'REMOTE_KEY_PLAN_INSUFFICIENT'
				if (isAuthError) {
					this.updateStatus(InstanceStatus.BadConfig, reason)
				} else {
					this.updateStatus(InstanceStatus.ConnectionFailure, reason)
				}
				break
			}
		}
	}

	/**
	 * Update the status variable based on connection state.
	 */
	private updateStatusVariable(state: ConnectionState): void {
		const labels: Record<ConnectionState, string> = {
			active: 'Connected',
			waiting: 'Waiting',
			disconnected: 'Offline',
			error: 'Error',
		}
		this.setVariableValues({ status: labels[state] })
	}

	/**
	 * Strip leading "00:" hours from an HH:MM:SS pair when the script is
	 * under 1 hour, so the text fits on small Companion button displays.
	 * If either value has non-zero hours, both keep the full HH:MM:SS format
	 * for visual consistency.
	 */
	static compactTimerPair(a: string, b: string): [string, string] {
		const strip = (s: string): string => {
			const parts = s.split(':')
			// Only strip if exactly 3 segments and hours segment is "00"
			if (parts.length === 3 && parts[0] === '00') return parts.slice(1).join(':')
			return s
		}
		const hasHours = (s: string): boolean => {
			const parts = s.split(':')
			return parts.length === 3 && parts[0] !== '00'
		}
		// If either value has non-zero hours, keep both in HH:MM:SS
		if (hasHours(a) || hasHours(b)) return [a, b]
		return [strip(a), strip(b)]
	}
}

export { UpgradeScripts }

export default EasyPrompterModule
