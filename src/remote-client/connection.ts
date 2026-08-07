import { io, type Socket } from 'socket.io-client'
import type {
	ConnectionState,
	Logger,
	PlaybackState,
	PrompterState,
	RemoteControlAction,
	ScriptInfo,
	SettingsData,
	TimerData,
} from './types.js'

/** Default logger that uses console. */
const defaultLogger: Logger = {
	info: (msg) => console.log(`[EasyPrompter] ${msg}`),
	warn: (msg) => console.warn(`[EasyPrompter] ${msg}`),
	error: (msg) => console.error(`[EasyPrompter] ${msg}`),
	debug: (msg) => console.debug(`[EasyPrompter] ${msg}`),
}

/** Error codes that indicate the remote key is permanently invalid — do not reconnect. */
const PERMANENT_ERROR_CODES = [
	'INVALID_REMOTE_KEY',
	'REMOTE_KEY_REVOKED',
	'REMOTE_KEY_PLAN_INSUFFICIENT',
	'CONNECTION_LIMIT_REACHED',
]

type StateListener = (state: PrompterState) => void
type ConnectionStateListener = (state: ConnectionState, reason?: string) => void
type TimerListener = (data: TimerData) => void
type SettingsListener = (data: SettingsData) => void
type ScriptInfoListener = (data: ScriptInfo) => void
type ScriptsChangedListener = () => void

/**
 * Derive a stable UUID-format clientId from the API key so the same
 * plugin + key always produces the same ID. This prevents ghost
 * remote connections when the host process restarts.
 */
function deriveClientId(apiKey: string): string {
	// Simple hash → UUID v4 format from first 32 hex chars
	let hash = 0
	for (let i = 0; i < apiKey.length; i++) {
		hash = ((hash << 5) - hash + apiKey.charCodeAt(i)) | 0
	}
	// Pad with the key length and repeated chars to fill 32 hex digits
	const hex =
		Math.abs(hash).toString(16).padStart(8, '0') +
		apiKey.length.toString(16).padStart(8, '0') +
		Math.abs(hash ^ 0x5f3759df)
			.toString(16)
			.padStart(8, '0') +
		Math.abs(hash ^ 0xdeadbeef)
			.toString(16)
			.padStart(8, '0')
	const h = hex.slice(0, 32)
	return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`
}

/**
 * Individual socket.io connection to an EasyPrompter instance.
 * Device-agnostic — works with any controller (Stream Deck, Companion, Touch Portal, etc.).
 */
export class EasyPrompterConnection {
	private socket: Socket | null = null
	private stateListeners = new Set<StateListener>()
	private connectionStateListeners = new Set<ConnectionStateListener>()
	private timerListeners = new Set<TimerListener>()
	private settingsListeners = new Set<SettingsListener>()
	private scriptInfoListeners = new Set<ScriptInfoListener>()
	private scriptsChangedListeners = new Set<ScriptsChangedListener>()

	private _connectionState: ConnectionState = 'disconnected'
	private _lastState: PrompterState | null = null
	private _lastTimer: TimerData | null = null
	private _lastSettings: SettingsData | null = null
	private _lastScriptInfo: ScriptInfo | null = null
	/** Tracks the most recent error code received from the server. */
	private _lastErrorCode: string | null = null
	/** Prevents multiple socket instances during reconnect delay */
	private _reconnectScheduled = false
	/** Tracks reconnect attempts for exponential backoff */
	private _reconnectAttempts = 0
	/** Reconnect timer ID for cancellation */
	private _reconnectTimer: ReturnType<typeof setTimeout> | null = null
	/** Throttle timers for rate-limiting listener notifications (~10/sec max) */
	private _stateNotifyPending = false
	private _stateNotifyTimer: ReturnType<typeof setTimeout> | null = null
	private _timerNotifyPending = false
	private _timerNotifyTimer: ReturnType<typeof setTimeout> | null = null

	private readonly logger: Logger

	constructor(
		private readonly serverUrl: string,
		private readonly apiKey: string,
		logger?: Logger,
	) {
		this.logger = logger ?? defaultLogger
	}

	get connectionState(): ConnectionState {
		return this._connectionState
	}

	get lastErrorCode(): string | null {
		return this._lastErrorCode
	}

	get lastState(): PrompterState | null {
		return this._lastState
	}

	get lastScriptInfo(): ScriptInfo | null {
		return this._lastScriptInfo
	}

	/**
	 * Subscribe to prompter state updates.
	 * Returns an unsubscribe function.
	 */
	onStateChange(listener: StateListener): () => void {
		this.stateListeners.add(listener)
		// Emit current state immediately if available
		if (this._lastState) {
			listener(this._lastState)
		}
		return () => this.stateListeners.delete(listener)
	}

	/**
	 * Subscribe to connection state changes.
	 * Returns an unsubscribe function.
	 */
	onConnectionStateChange(listener: ConnectionStateListener): () => void {
		this.connectionStateListeners.add(listener)
		listener(this._connectionState)
		return () => this.connectionStateListeners.delete(listener)
	}

	/**
	 * Subscribe to timer updates (elapsed/remaining time).
	 * Returns an unsubscribe function.
	 */
	onTimerChange(listener: TimerListener): () => void {
		this.timerListeners.add(listener)
		if (this._lastTimer) {
			listener(this._lastTimer)
		}
		return () => this.timerListeners.delete(listener)
	}

	get lastTimer(): TimerData | null {
		return this._lastTimer
	}

	/**
	 * Subscribe to display settings changes (fontSize, lineHeight).
	 * Returns an unsubscribe function.
	 */
	onSettingsChange(listener: SettingsListener): () => void {
		this.settingsListeners.add(listener)
		if (this._lastSettings) {
			listener(this._lastSettings)
		}
		return () => this.settingsListeners.delete(listener)
	}

	/**
	 * Subscribe to script info changes (title, id).
	 * Returns an unsubscribe function.
	 */
	onScriptInfoChange(listener: ScriptInfoListener): () => void {
		this.scriptInfoListeners.add(listener)
		if (this._lastScriptInfo) {
			listener(this._lastScriptInfo)
		}
		return () => this.scriptInfoListeners.delete(listener)
	}

	/**
	 * Subscribe to scripts_changed notifications.
	 * Fired when the user's script list changes (create, delete, rename, restore).
	 * Returns an unsubscribe function.
	 */
	onScriptsChanged(listener: ScriptsChangedListener): () => void {
		this.scriptsChangedListeners.add(listener)
		return () => this.scriptsChangedListeners.delete(listener)
	}

	/**
	 * Establish the socket.io connection.
	 */
	connect(): void {
		if (this.socket || this._reconnectScheduled) {
			return // Already connected/connecting, or reconnect pending
		}

		this.logger.info(`Connecting to EasyPrompter at ${this.serverUrl}`)

		// L7: Capture socket in a local variable so the catch can close it properly
		let sock: Socket | null = null
		try {
			sock = io(this.serverUrl, {
				path: '/api/socket/io',
				auth: {
					apiKey: this.apiKey,
				},
				query: {
					// M8: Only send clientId and clientType in query — apiKey stays in auth only
					clientId: deriveClientId(this.apiKey),
					clientType: 'remote',
				},
				// Disable socket.io's built-in reconnection — we manage reconnects
				// ourselves to guarantee exactly ONE connection at a time.
				reconnection: false,
				// Force a fresh Manager per connect() call so the old Manager's
				// internal state can't spawn ghost connections after close().
				forceNew: true,
				// Force WebSocket transport — polling adds ~1.5s latency per batch,
				// unacceptable for real-time encoder dial events.
				transports: ['websocket'],
			})

			this.socket = sock

			this.socket.on('connect', () => {
				this.logger.info(`Connected to EasyPrompter at ${this.serverUrl}`)
				// State will transition to "waiting" or "active" via server events
			})

			this.socket.on('disconnect', (reason: string) => {
				this.logger.warn(`Disconnected from EasyPrompter (reason: ${reason})`)
				this.setConnectionState('disconnected')
				this._lastState = null

				const errorCode = this._lastErrorCode
				this._lastErrorCode = null

				// Clean up old socket completely
				const oldSock = this.socket
				this.socket = null
				oldSock?.removeAllListeners()
				oldSock?.close()

				if (errorCode && PERMANENT_ERROR_CODES.includes(errorCode)) {
					this.logger.error(`Permanent error (${errorCode}) — will not reconnect`)
					this.setConnectionState('error', errorCode)
					return
				}

				this.scheduleReconnect()
			})

			this.socket.on('connect_error', (err: Error) => {
				this.logger.error(`Connection error: ${err.message}`)

				// Check if the error carries a permanent error code (e.g. auth failure).
				// Socket.io attaches server-sent data to the error object.
				const errData = (err as Error & { data?: { code?: string } }).data
				const errorCode = errData?.code ?? null
				const isPermanent = errorCode !== null && PERMANENT_ERROR_CODES.includes(errorCode)

				const oldSock = this.socket
				this.socket = null
				oldSock?.removeAllListeners()
				oldSock?.close()

				if (isPermanent) {
					this.logger.error(`Permanent auth error (${errorCode}) — will not reconnect`)
					// L5: Use descriptive reason for error status
					this.setConnectionState('error', errorCode)
					return
				}

				this.setConnectionState('disconnected')
				this.scheduleReconnect()
			})

			// Server events for session lifecycle
			this.socket.on('waiting_for_session', () => {
				this.logger.info('Waiting for teleprompter session...')
				this._reconnectAttempts = 0 // Successful app-level auth
				// M2: Clear sticky error code on successful auth
				this._lastErrorCode = null
				this.setConnectionState('waiting')
			})

			this.socket.on('session_joined', (data: Record<string, unknown>) => {
				this.logger.debug(`Joined session: ${JSON.stringify(data)}`)
				this._reconnectAttempts = 0 // Successful app-level auth
				// M2: Clear sticky error code on successful auth
				this._lastErrorCode = null
				this.setConnectionState('active')
			})

			this.socket.on('session_state', (data: Record<string, unknown>) => {
				this.logger.debug(
					// eslint-disable-next-line @typescript-eslint/no-base-to-string -- server always sends string
					`Session state: scriptId=${data.scriptId != null ? String(data.scriptId) : '(null)'}, status=${String(data.status)}, paused=${String(data.paused)}`,
				)
				this._reconnectAttempts = 0 // Successful app-level auth
				// M2: Clear sticky error code on successful auth
				this._lastErrorCode = null
				this.setConnectionState('active')
				const paused = typeof data.paused === 'number' ? data.paused : 1
				const speed = typeof data.playbackSpeed === 'number' ? data.playbackSpeed : 150
				this._lastState = { isPlaying: paused === 0, speed }
				this.notifyStateListeners()

				// Extract script info from session_state if present
				const ssScriptId = typeof data.scriptId === 'string' ? data.scriptId : undefined
				const ssScriptTitle = typeof data.scriptTitle === 'string' ? data.scriptTitle : undefined
				if (ssScriptId !== undefined || ssScriptTitle !== undefined) {
					this.mergeScriptInfo(ssScriptId, ssScriptTitle)
				}
			})

			this.socket.on('playback_state', (data: PlaybackState) => {
				this.logger.debug(`Playback state: ${JSON.stringify(data)}`)
				this.handlePlaybackState(data)
			})

			this.socket.on('session_ended', () => {
				this.logger.info('Teleprompter session ended')
				this.setConnectionState('waiting')
				// Notify listeners with a "stopped" state BEFORE nulling,
				// so buttons reset to their paused/idle appearance.
				// Use flush (not throttled) so the reset is immediate.
				this._lastState = { isPlaying: false, speed: this._lastState?.speed ?? 0 }
				this.flushStateListeners()
				this._lastState = null
				this._lastTimer = null
				this._lastSettings = null
				this._lastScriptInfo = null
			})

			this.socket.on('error', (data: Record<string, unknown>) => {
				this.logger.error(`Server error: ${JSON.stringify(data)}`)
				if (typeof data.code === 'string') {
					this._lastErrorCode = data.code
				}
			})

			this.socket.on('scripts_changed', () => {
				this.logger.debug('Script list changed — notifying listeners')
				this.notifyScriptsChangedListeners()
			})

			this.socket.on('timer_update', (data: Record<string, unknown>) => {
				// M7: Merge instead of replace — partial updates don't blank existing values
				const elapsed = typeof data.elapsed === 'string' ? data.elapsed : undefined
				const remaining = typeof data.remaining === 'string' ? data.remaining : undefined
				const progress = typeof data.progress === 'number' ? data.progress : undefined
				this._lastTimer = {
					...this._lastTimer,
					...(elapsed !== undefined ? { elapsed } : {}),
					...(remaining !== undefined ? { remaining } : {}),
					...(progress !== undefined ? { progress } : {}),
				}
				this.notifyTimerListeners()
			})

			// Display settings updates (fontSize, lineHeight, scriptTitle, etc.)
			this.socket.on('settings_update', (data: Record<string, unknown>) => {
				const settings = (data?.settings ?? data) as Record<string, unknown>
				if (!settings || typeof settings !== 'object') return

				const fontSize = typeof settings.fontSize === 'number' ? settings.fontSize : undefined
				const lineHeight = typeof settings.lineHeight === 'number' ? settings.lineHeight : undefined
				const blackout = typeof settings.blackout === 'boolean' ? settings.blackout : undefined
				const screenMargin = typeof settings.screenMargin === 'number' ? settings.screenMargin : undefined

				// Only notify if we have relevant display settings
				if (
					fontSize !== undefined ||
					lineHeight !== undefined ||
					blackout !== undefined ||
					screenMargin !== undefined
				) {
					this._lastSettings = {
						...this._lastSettings,
						...(fontSize !== undefined ? { fontSize } : {}),
						...(lineHeight !== undefined ? { lineHeight } : {}),
						...(blackout !== undefined ? { blackout } : {}),
						...(screenMargin !== undefined ? { screenMargin } : {}),
					}
					this.notifySettingsListeners()
				}

				// Extract script title if present
				const scriptTitle = typeof settings.scriptTitle === 'string' ? settings.scriptTitle : undefined
				const scriptId = typeof settings.scriptId === 'string' ? settings.scriptId : undefined
				if (scriptTitle !== undefined || scriptId !== undefined) {
					this.mergeScriptInfo(scriptId, scriptTitle)
				}
			})

			// Initial settings snapshot on connect
			this.socket.on('settings_state', (data: Record<string, unknown>) => {
				// settings_state has { global: { key: { value, ts } }, viewer: ... }
				const global = data?.global as Record<string, { value: unknown }> | null
				if (!global || typeof global !== 'object') return

				const fontSize = typeof global.fontSize?.value === 'number' ? global.fontSize.value : undefined
				const lineHeight = typeof global.lineHeight?.value === 'number' ? global.lineHeight.value : undefined
				const blackout = typeof global.blackout?.value === 'boolean' ? global.blackout.value : undefined
				const screenMargin = typeof global.screenMargin?.value === 'number' ? global.screenMargin.value : undefined

				if (
					fontSize !== undefined ||
					lineHeight !== undefined ||
					blackout !== undefined ||
					screenMargin !== undefined
				) {
					this._lastSettings = {
						...this._lastSettings,
						...(fontSize !== undefined ? { fontSize } : {}),
						...(lineHeight !== undefined ? { lineHeight } : {}),
						...(blackout !== undefined ? { blackout } : {}),
						...(screenMargin !== undefined ? { screenMargin } : {}),
					}
					this.notifySettingsListeners()
				}

				// Extract script title if present
				const scriptTitle = typeof global.scriptTitle?.value === 'string' ? global.scriptTitle.value : undefined
				const scriptId = typeof global.scriptId?.value === 'string' ? global.scriptId.value : undefined
				if (scriptTitle !== undefined || scriptId !== undefined) {
					this.mergeScriptInfo(scriptId, scriptTitle)
				}
			})
		} catch (err) {
			this.logger.error(`Failed to create socket: ${err}`)
			// L7: Close the orphaned socket if io() succeeded but a subsequent .on() threw
			if (sock) {
				sock.removeAllListeners()
				sock.close()
			}
			this.socket = null
			this.setConnectionState('error', 'Failed to create socket')
		}
	}

	/**
	 * Cleanly close the connection.
	 */
	disconnect(): void {
		// Cancel any pending reconnect timer
		if (this._reconnectTimer) {
			clearTimeout(this._reconnectTimer)
			this._reconnectTimer = null
		}
		// Cancel any pending throttled notifications
		if (this._stateNotifyTimer) {
			clearTimeout(this._stateNotifyTimer)
			this._stateNotifyTimer = null
			this._stateNotifyPending = false
		}
		if (this._timerNotifyTimer) {
			clearTimeout(this._timerNotifyTimer)
			this._timerNotifyTimer = null
			this._timerNotifyPending = false
		}

		this._reconnectScheduled = false
		this._reconnectAttempts = 0
		if (this.socket) {
			// Remove listeners BEFORE disconnecting to prevent the 'disconnect'
			// event handler from scheduling an unwanted reconnect.
			this.socket.removeAllListeners()
			this.socket.disconnect()
			this.socket = null
		}
		this.setConnectionState('disconnected')
		this._lastState = null
		this._lastTimer = null
		this._lastSettings = null
		this._lastScriptInfo = null
	}

	/**
	 * Send a remote control action to the server.
	 */
	sendRemoteControl(action: RemoteControlAction): void {
		if (!this.socket || this._connectionState !== 'active') {
			this.logger.warn(`Cannot send remote control "${action.type}" — state is ${this._connectionState}`)
			return
		}

		this.socket.emit('remote_control', { ...action, ts: this.nextTs() })
		this.logger.debug(`Sent remote_control: ${action.type}`)
	}

	/** Monotonic timestamp — guarantees each event has a strictly increasing ts. */
	private _lastTs = 0
	private nextTs(): number {
		const now = Date.now()
		this._lastTs = now > this._lastTs ? now : this._lastTs + 1
		return this._lastTs
	}

	// --- Private methods ---

	/**
	 * Merge script info, only notifying listeners when values actually changed.
	 * H4: Prevents flooding from settings_update payloads that repeat the same scriptTitle.
	 */
	private mergeScriptInfo(scriptId: string | undefined, scriptTitle: string | undefined): void {
		const prev = this._lastScriptInfo
		const idChanged = scriptId !== undefined && scriptId !== prev?.scriptId
		const titleChanged = scriptTitle !== undefined && scriptTitle !== prev?.scriptTitle
		if (!idChanged && !titleChanged) return

		this._lastScriptInfo = {
			...prev,
			...(scriptId !== undefined ? { scriptId } : {}),
			...(scriptTitle !== undefined ? { scriptTitle } : {}),
		}
		this.notifyScriptInfoListeners()
	}

	/**
	 * Schedule a single reconnect with exponential backoff.
	 * Guarantees only one reconnect timer is active at a time.
	 */
	private scheduleReconnect(): void {
		if (this._reconnectScheduled) return
		this._reconnectScheduled = true
		// Exponential backoff: 3s, 6s, 12s, 24s, capped at 30s
		const delay = Math.min(3000 * Math.pow(2, this._reconnectAttempts), 30000)
		this._reconnectAttempts++
		this.logger.info(`Scheduling reconnect in ${(delay / 1000).toFixed(0)}s (attempt ${this._reconnectAttempts})`)
		this._reconnectTimer = setTimeout(() => {
			this._reconnectTimer = null
			this._reconnectScheduled = false
			this.connect()
		}, delay)
	}

	private handlePlaybackState(data: PlaybackState): void {
		// Only update play/pause state if the paused field is explicitly present.
		// Speed-only updates (set_speed) don't include paused, so we must preserve
		// the current value to avoid incorrectly showing "paused".
		const isPlaying = typeof data.paused === 'number' ? data.paused === 0 : (this._lastState?.isPlaying ?? false)
		const speed = data.playbackSpeed ?? this._lastState?.speed ?? 150

		this._lastState = { isPlaying, speed }
		this.notifyStateListeners()
	}

	/**
	 * Throttled state listener notification — max ~10/sec.
	 * Coalesces rapid updates so only the latest state is delivered.
	 * M1: Each listener is wrapped in try/catch to prevent a single throw from killing the module.
	 */
	private notifyStateListeners(): void {
		if (!this._lastState) return
		if (this._stateNotifyPending) return // Already scheduled
		this._stateNotifyPending = true
		this._stateNotifyTimer = setTimeout(() => {
			this._stateNotifyPending = false
			this._stateNotifyTimer = null
			if (this._lastState) {
				for (const listener of this.stateListeners) {
					try {
						listener(this._lastState)
					} catch (err) {
						this.logger.error(`State listener error: ${err}`)
					}
				}
			}
		}, 100)
	}

	/**
	 * Flush pending state notification immediately (for session_ended, disconnect).
	 * M1: Each listener is wrapped in try/catch.
	 */
	private flushStateListeners(): void {
		if (this._stateNotifyTimer) {
			clearTimeout(this._stateNotifyTimer)
			this._stateNotifyTimer = null
			this._stateNotifyPending = false
		}
		if (this._lastState) {
			for (const listener of this.stateListeners) {
				try {
					listener(this._lastState)
				} catch (err) {
					this.logger.error(`State listener error: ${err}`)
				}
			}
		}
	}

	/**
	 * Throttled timer listener notification — max ~10/sec.
	 * M1: Each listener is wrapped in try/catch.
	 */
	private notifyTimerListeners(): void {
		if (!this._lastTimer) return
		if (this._timerNotifyPending) return
		this._timerNotifyPending = true
		this._timerNotifyTimer = setTimeout(() => {
			this._timerNotifyPending = false
			this._timerNotifyTimer = null
			if (this._lastTimer) {
				for (const listener of this.timerListeners) {
					try {
						listener(this._lastTimer)
					} catch (err) {
						this.logger.error(`Timer listener error: ${err}`)
					}
				}
			}
		}, 100)
	}

	/**
	 * L5: Connection state now carries an optional reason for error display.
	 */
	private setConnectionState(state: ConnectionState, reason?: string): void {
		if (this._connectionState === state) return
		this._connectionState = state
		for (const listener of this.connectionStateListeners) {
			try {
				listener(state, reason)
			} catch (err) {
				this.logger.error(`Connection state listener error: ${err}`)
			}
		}
	}

	/**
	 * Notify settings listeners immediately (infrequent events).
	 * M1: Each listener is wrapped in try/catch.
	 */
	private notifySettingsListeners(): void {
		if (!this._lastSettings) return
		for (const listener of this.settingsListeners) {
			try {
				listener(this._lastSettings)
			} catch (err) {
				this.logger.error(`Settings listener error: ${err}`)
			}
		}
	}

	/**
	 * Notify script info listeners immediately (infrequent events).
	 * M1: Each listener is wrapped in try/catch.
	 */
	private notifyScriptInfoListeners(): void {
		if (!this._lastScriptInfo) return
		for (const listener of this.scriptInfoListeners) {
			try {
				listener(this._lastScriptInfo)
			} catch (err) {
				this.logger.error(`Script info listener error: ${err}`)
			}
		}
	}

	private notifyScriptsChangedListeners(): void {
		for (const listener of this.scriptsChangedListeners) {
			try {
				listener()
			} catch (err) {
				this.logger.error(`scripts_changed listener error: ${err}`)
			}
		}
	}
}
