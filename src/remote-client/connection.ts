import { io, type Socket } from "socket.io-client";
import type {
  ConnectionState,
  Logger,
  PlaybackState,
  PrompterState,
  RemoteControlAction,
  ScriptInfo,
  SettingsData,
  TimerData,
} from "./types.js";

/** Default logger that uses console. */
const defaultLogger: Logger = {
  info: (msg) => console.log(`[EasyPrompter] ${msg}`),
  warn: (msg) => console.warn(`[EasyPrompter] ${msg}`),
  error: (msg) => console.error(`[EasyPrompter] ${msg}`),
  debug: (msg) => console.debug(`[EasyPrompter] ${msg}`),
};

/** Error codes that indicate the remote key is permanently invalid — do not reconnect. */
const PERMANENT_ERROR_CODES = ["INVALID_REMOTE_KEY", "REMOTE_KEY_REVOKED", "REMOTE_KEY_PLAN_INSUFFICIENT"];

type StateListener = (state: PrompterState) => void;
type ConnectionStateListener = (state: ConnectionState) => void;
type TimerListener = (data: TimerData) => void;
type SettingsListener = (data: SettingsData) => void;
type ScriptInfoListener = (data: ScriptInfo) => void;
type ScriptsChangedListener = () => void;

/**
 * Derive a stable UUID-format clientId from the API key so the same
 * plugin + key always produces the same ID. This prevents ghost
 * remote connections when the host process restarts.
 */
function deriveClientId(apiKey: string): string {
  // Simple hash → UUID v4 format from first 32 hex chars
  let hash = 0;
  for (let i = 0; i < apiKey.length; i++) {
    hash = ((hash << 5) - hash + apiKey.charCodeAt(i)) | 0;
  }
  // Pad with the key length and repeated chars to fill 32 hex digits
  const hex = Math.abs(hash).toString(16).padStart(8, "0")
    + apiKey.length.toString(16).padStart(8, "0")
    + Math.abs(hash ^ 0x5f3759df).toString(16).padStart(8, "0")
    + Math.abs(hash ^ 0xdeadbeef).toString(16).padStart(8, "0");
  const h = hex.slice(0, 32);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

/**
 * Individual socket.io connection to an EasyPrompter instance.
 * Device-agnostic — works with any controller (Stream Deck, Companion, Touch Portal, etc.).
 */
export class EasyPrompterConnection {
  private socket: Socket | null = null;
  private stateListeners = new Set<StateListener>();
  private connectionStateListeners = new Set<ConnectionStateListener>();
  private timerListeners = new Set<TimerListener>();
  private settingsListeners = new Set<SettingsListener>();
  private scriptInfoListeners = new Set<ScriptInfoListener>();
  private scriptsChangedListeners = new Set<ScriptsChangedListener>();

  private _connectionState: ConnectionState = "disconnected";
  private _lastState: PrompterState | null = null;
  private _lastTimer: TimerData | null = null;
  private _lastSettings: SettingsData | null = null;
  private _lastScriptInfo: ScriptInfo | null = null;
  /** Tracks the most recent error code received from the server. */
  private _lastErrorCode: string | null = null;
  /** Prevents multiple socket instances during reconnect delay */
  private _reconnectScheduled = false;
  /** Tracks reconnect attempts for exponential backoff */
  private _reconnectAttempts = 0;
  /** Reconnect timer ID for cancellation */
  private _reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  /** Throttle timers for rate-limiting listener notifications (~10/sec max) */
  private _stateNotifyPending = false;
  private _stateNotifyTimer: ReturnType<typeof setTimeout> | null = null;
  private _timerNotifyPending = false;
  private _timerNotifyTimer: ReturnType<typeof setTimeout> | null = null;

  private readonly logger: Logger;

  constructor(
    private readonly serverUrl: string,
    private readonly apiKey: string,
    logger?: Logger
  ) {
    this.logger = logger ?? defaultLogger;
  }

  get connectionState(): ConnectionState {
    return this._connectionState;
  }

  get lastState(): PrompterState | null {
    return this._lastState;
  }

  get lastScriptInfo(): ScriptInfo | null {
    return this._lastScriptInfo;
  }

  /**
   * Subscribe to prompter state updates.
   * Returns an unsubscribe function.
   */
  onStateChange(listener: StateListener): () => void {
    this.stateListeners.add(listener);
    // Emit current state immediately if available
    if (this._lastState) {
      listener(this._lastState);
    }
    return () => this.stateListeners.delete(listener);
  }

  /**
   * Subscribe to connection state changes.
   * Returns an unsubscribe function.
   */
  onConnectionStateChange(listener: ConnectionStateListener): () => void {
    this.connectionStateListeners.add(listener);
    listener(this._connectionState);
    return () => this.connectionStateListeners.delete(listener);
  }

  /**
   * Subscribe to timer updates (elapsed/remaining time).
   * Returns an unsubscribe function.
   */
  onTimerChange(listener: TimerListener): () => void {
    this.timerListeners.add(listener);
    if (this._lastTimer) {
      listener(this._lastTimer);
    }
    return () => this.timerListeners.delete(listener);
  }

  get lastTimer(): TimerData | null {
    return this._lastTimer;
  }

  /**
   * Subscribe to display settings changes (fontSize, lineHeight).
   * Returns an unsubscribe function.
   */
  onSettingsChange(listener: SettingsListener): () => void {
    this.settingsListeners.add(listener);
    if (this._lastSettings) {
      listener(this._lastSettings);
    }
    return () => this.settingsListeners.delete(listener);
  }

  /**
   * Subscribe to script info changes (title, id).
   * Returns an unsubscribe function.
   */
  onScriptInfoChange(listener: ScriptInfoListener): () => void {
    this.scriptInfoListeners.add(listener);
    if (this._lastScriptInfo) {
      listener(this._lastScriptInfo);
    }
    return () => this.scriptInfoListeners.delete(listener);
  }

  /**
   * Subscribe to scripts_changed notifications.
   * Fired when the user's script list changes (create, delete, rename, restore).
   * Returns an unsubscribe function.
   */
  onScriptsChanged(listener: ScriptsChangedListener): () => void {
    this.scriptsChangedListeners.add(listener);
    return () => this.scriptsChangedListeners.delete(listener);
  }

  /**
   * Establish the socket.io connection.
   */
  connect(): void {
    if (this.socket || this._reconnectScheduled) {
      return; // Already connected/connecting, or reconnect pending
    }

    this.logger.info(`Connecting to EasyPrompter at ${this.serverUrl}`);

    try {
      this.socket = io(this.serverUrl, {
        path: "/api/socket/io",
        auth: {
          apiKey: this.apiKey,
        },
        query: {
          apiKey: this.apiKey,
          clientId: deriveClientId(this.apiKey),
          clientType: "remote",
        },
        // Disable socket.io's built-in reconnection — we manage reconnects
        // ourselves to guarantee exactly ONE connection at a time.
        reconnection: false,
        // Accept self-signed / mkcert development certificates.
        // The Stream Deck plugin's bundled Node.js doesn't use the system
        // trust store, so local dev certs fail without this.
        rejectUnauthorized: false,
        // Force WebSocket transport — polling adds ~1.5s latency per batch,
        // unacceptable for real-time encoder dial events.
        transports: ["websocket"],
      });

      this.socket.on("connect", () => {
        this.logger.info(`Connected to EasyPrompter at ${this.serverUrl}`);
        this._reconnectAttempts = 0; // Reset backoff on successful connect
        // State will transition to "waiting" or "active" via server events
      });

      this.socket.on("disconnect", (reason: string) => {
        this.logger.warn(`Disconnected from EasyPrompter (reason: ${reason})`);
        this.setConnectionState("disconnected");
        this._lastState = null;

        const errorCode = this._lastErrorCode;
        this._lastErrorCode = null;

        // Clean up old socket completely
        const sock = this.socket;
        this.socket = null;
        sock?.removeAllListeners();
        sock?.close();

        if (errorCode && PERMANENT_ERROR_CODES.includes(errorCode)) {
          this.logger.error(`Permanent error (${errorCode}) — will not reconnect`);
          this.setConnectionState("error");
          return;
        }

        this.scheduleReconnect();
      });

      this.socket.on("connect_error", (err: Error) => {
        this.logger.error(`Connection error: ${err.message}`);
        this.setConnectionState("disconnected");
        // Socket.io won't auto-reconnect (reconnection: false), so we must.
        const sock = this.socket;
        this.socket = null;
        sock?.removeAllListeners();
        sock?.close();
        this.scheduleReconnect();
      });

      // Server events for session lifecycle
      this.socket.on("waiting_for_session", () => {
        this.logger.info("Waiting for teleprompter session...");
        this.setConnectionState("waiting");
      });

      this.socket.on("session_joined", (data: Record<string, unknown>) => {
        this.logger.info(`Joined session: ${JSON.stringify(data)}`);
        this.setConnectionState("active");
      });

      this.socket.on("session_state", (data: Record<string, unknown>) => {
        this.logger.info(`Session state: scriptId=${data.scriptId ?? "(null)"}, status=${data.status}, paused=${data.paused}`);
        this.setConnectionState("active");
        const paused = typeof data.paused === "number" ? data.paused : 1;
        const speed = typeof data.playbackSpeed === "number" ? data.playbackSpeed : 150;
        this._lastState = { isPlaying: paused === 0, speed };
        this.notifyStateListeners();

        // Extract script info from session_state if present
        const ssScriptId = typeof data.scriptId === "string" ? data.scriptId : undefined;
        const ssScriptTitle = typeof data.scriptTitle === "string" ? data.scriptTitle : undefined;
        if (ssScriptId !== undefined || ssScriptTitle !== undefined) {
          this._lastScriptInfo = {
            ...this._lastScriptInfo,
            ...(ssScriptId !== undefined ? { scriptId: ssScriptId } : {}),
            ...(ssScriptTitle !== undefined ? { scriptTitle: ssScriptTitle } : {}),
          };
          this.notifyScriptInfoListeners();
        }
      });

      this.socket.on("playback_state", (data: PlaybackState) => {
        this.logger.debug(`Playback state: ${JSON.stringify(data)}`);
        this.handlePlaybackState(data);
      });

      this.socket.on("session_ended", () => {
        this.logger.info("Teleprompter session ended");
        this.setConnectionState("waiting");
        // Notify listeners with a "stopped" state BEFORE nulling,
        // so buttons reset to their paused/idle appearance.
        // Use flush (not throttled) so the reset is immediate.
        this._lastState = { isPlaying: false, speed: this._lastState?.speed ?? 0 };
        this.flushStateListeners();
        this._lastState = null;
        this._lastTimer = null;
        this._lastSettings = null;
        this._lastScriptInfo = null;
      });

      this.socket.on("error", (data: Record<string, unknown>) => {
        this.logger.error(`Server error: ${JSON.stringify(data)}`);
        if (typeof data.code === "string") {
          this._lastErrorCode = data.code;
        }
      });

      this.socket.on("scripts_changed", () => {
        this.logger.info("Script list changed — notifying listeners");
        this.notifyScriptsChangedListeners();
      });

      this.socket.on("timer_update", (data: Record<string, unknown>) => {
        // Validate types before propagating
        const timer: TimerData = {
          elapsed: typeof data.elapsed === "string" ? data.elapsed : undefined,
          remaining: typeof data.remaining === "string" ? data.remaining : undefined,
          progress: typeof data.progress === "number" ? data.progress : undefined,
        };
        this._lastTimer = timer;
        this.notifyTimerListeners();
      });

      // Display settings updates (fontSize, lineHeight, scriptTitle, etc.)
      this.socket.on("settings_update", (data: Record<string, unknown>) => {
        const settings = (data?.settings ?? data) as Record<string, unknown>;
        if (!settings || typeof settings !== "object") return;

        const fontSize = typeof settings.fontSize === "number" ? settings.fontSize : undefined;
        const lineHeight = typeof settings.lineHeight === "number" ? settings.lineHeight : undefined;
        const blackout = typeof settings.blackout === "boolean" ? settings.blackout : undefined;
        const screenMargin = typeof settings.screenMargin === "number" ? settings.screenMargin : undefined;
        const activeDisplayName = typeof settings.activeDisplayName === "string" ? settings.activeDisplayName : (settings.activeDisplayName === null ? null : undefined);
        const activeDisplayColor = typeof settings.activeDisplayColor === "string" ? settings.activeDisplayColor : (settings.activeDisplayColor === null ? null : undefined);

        // Only notify if we have relevant display settings
        if (fontSize !== undefined || lineHeight !== undefined || blackout !== undefined || screenMargin !== undefined || activeDisplayName !== undefined || activeDisplayColor !== undefined) {
          this._lastSettings = {
            ...this._lastSettings,
            ...(fontSize !== undefined ? { fontSize } : {}),
            ...(lineHeight !== undefined ? { lineHeight } : {}),
            ...(blackout !== undefined ? { blackout } : {}),
            ...(screenMargin !== undefined ? { screenMargin } : {}),
            ...(activeDisplayName !== undefined ? { activeDisplayName } : {}),
            ...(activeDisplayColor !== undefined ? { activeDisplayColor } : {}),
          };
          this.notifySettingsListeners();
        }

        // Extract script title if present
        const scriptTitle = typeof settings.scriptTitle === "string" ? settings.scriptTitle : undefined;
        const scriptId = typeof settings.scriptId === "string" ? settings.scriptId : undefined;
        if (scriptTitle !== undefined || scriptId !== undefined) {
          this._lastScriptInfo = {
            ...this._lastScriptInfo,
            ...(scriptTitle !== undefined ? { scriptTitle } : {}),
            ...(scriptId !== undefined ? { scriptId } : {}),
          };
          this.notifyScriptInfoListeners();
        }
      });

      // Initial settings snapshot on connect
      this.socket.on("settings_state", (data: Record<string, unknown>) => {
        // settings_state has { global: { key: { value, ts } }, viewer: ... }
        const global = data?.global as Record<string, { value: unknown }> | null;
        if (!global || typeof global !== "object") return;

        const fontSize = typeof global.fontSize?.value === "number" ? global.fontSize.value : undefined;
        const lineHeight = typeof global.lineHeight?.value === "number" ? global.lineHeight.value : undefined;
        const blackout = typeof global.blackout?.value === "boolean" ? global.blackout.value : undefined;
        const screenMargin = typeof global.screenMargin?.value === "number" ? global.screenMargin.value : undefined;
        const activeDisplayNameRaw = global.activeDisplayName?.value;
        const activeDisplayName = typeof activeDisplayNameRaw === "string" ? activeDisplayNameRaw : (activeDisplayNameRaw === null ? null : undefined);
        const activeDisplayColorRaw = global.activeDisplayColor?.value;
        const activeDisplayColor = typeof activeDisplayColorRaw === "string" ? activeDisplayColorRaw : (activeDisplayColorRaw === null ? null : undefined);

        if (fontSize !== undefined || lineHeight !== undefined || blackout !== undefined || screenMargin !== undefined || activeDisplayName !== undefined || activeDisplayColor !== undefined) {
          this._lastSettings = {
            ...this._lastSettings,
            ...(fontSize !== undefined ? { fontSize } : {}),
            ...(lineHeight !== undefined ? { lineHeight } : {}),
            ...(blackout !== undefined ? { blackout } : {}),
            ...(screenMargin !== undefined ? { screenMargin } : {}),
            ...(activeDisplayName !== undefined ? { activeDisplayName } : {}),
            ...(activeDisplayColor !== undefined ? { activeDisplayColor } : {}),
          };
          this.notifySettingsListeners();
        }

        // Extract script title if present
        const scriptTitle = typeof global.scriptTitle?.value === "string" ? global.scriptTitle.value : undefined;
        const scriptId = typeof global.scriptId?.value === "string" ? global.scriptId.value : undefined;
        if (scriptTitle !== undefined || scriptId !== undefined) {
          this._lastScriptInfo = {
            ...this._lastScriptInfo,
            ...(scriptTitle !== undefined ? { scriptTitle } : {}),
            ...(scriptId !== undefined ? { scriptId } : {}),
          };
          this.notifyScriptInfoListeners();
        }
      });
    } catch (err) {
      this.logger.error(`Failed to create socket: ${err}`);
      this.socket = null;
    }
  }

  /**
   * Cleanly close the connection.
   */
  disconnect(): void {
    // Cancel any pending reconnect timer
    if (this._reconnectTimer) {
      clearTimeout(this._reconnectTimer);
      this._reconnectTimer = null;
    }
    // Cancel any pending throttled notifications
    if (this._stateNotifyTimer) {
      clearTimeout(this._stateNotifyTimer);
      this._stateNotifyTimer = null;
      this._stateNotifyPending = false;
    }
    if (this._timerNotifyTimer) {
      clearTimeout(this._timerNotifyTimer);
      this._timerNotifyTimer = null;
      this._timerNotifyPending = false;
    }

    this._reconnectScheduled = false;
    this._reconnectAttempts = 0;
    if (this.socket) {
      // Remove listeners BEFORE disconnecting to prevent the 'disconnect'
      // event handler from scheduling an unwanted reconnect.
      this.socket.removeAllListeners();
      this.socket.disconnect();
      this.socket = null;
    }
    this.setConnectionState("disconnected");
    this._lastState = null;
    this._lastTimer = null;
    this._lastSettings = null;
    this._lastScriptInfo = null;
  }

  /**
   * Send a remote control action to the server.
   */
  sendRemoteControl(action: RemoteControlAction): void {
    if (!this.socket || this._connectionState !== "active") {
      this.logger.warn(
        `Cannot send remote control "${action.type}" — state is ${this._connectionState}`
      );
      return;
    }

    this.socket.emit("remote_control", { ...action, ts: this.nextTs() });
    this.logger.debug(`Sent remote_control: ${action.type}`);
  }

  /** Monotonic timestamp — guarantees each event has a strictly increasing ts. */
  private _lastTs = 0;
  private nextTs(): number {
    const now = Date.now();
    this._lastTs = now > this._lastTs ? now : this._lastTs + 1;
    return this._lastTs;
  }

  // --- Private methods ---

  /**
   * Schedule a single reconnect with exponential backoff.
   * Guarantees only one reconnect timer is active at a time.
   */
  private scheduleReconnect(): void {
    if (this._reconnectScheduled) return;
    this._reconnectScheduled = true;
    // Exponential backoff: 3s, 6s, 12s, 24s, capped at 30s
    const delay = Math.min(3000 * Math.pow(2, this._reconnectAttempts), 30000);
    this._reconnectAttempts++;
    this.logger.info(`Scheduling reconnect in ${(delay / 1000).toFixed(0)}s (attempt ${this._reconnectAttempts})`);
    this._reconnectTimer = setTimeout(() => {
      this._reconnectTimer = null;
      this._reconnectScheduled = false;
      this.connect();
    }, delay);
  }

  private handlePlaybackState(data: PlaybackState): void {
    // Only update play/pause state if the paused field is explicitly present.
    // Speed-only updates (set_speed) don't include paused, so we must preserve
    // the current value to avoid incorrectly showing "paused".
    const isPlaying = typeof data.paused === "number"
      ? data.paused === 0
      : (this._lastState?.isPlaying ?? false);
    const speed = data.playbackSpeed ?? this._lastState?.speed ?? 150;

    this._lastState = { isPlaying, speed };
    this.notifyStateListeners();
  }

  /**
   * Throttled state listener notification — max ~10/sec.
   * Coalesces rapid updates so only the latest state is delivered.
   */
  private notifyStateListeners(): void {
    if (!this._lastState) return;
    if (this._stateNotifyPending) return; // Already scheduled
    this._stateNotifyPending = true;
    this._stateNotifyTimer = setTimeout(() => {
      this._stateNotifyPending = false;
      this._stateNotifyTimer = null;
      if (this._lastState) {
        this.stateListeners.forEach((listener) => listener(this._lastState!));
      }
    }, 100);
  }

  /**
   * Flush pending state notification immediately (for session_ended, disconnect).
   */
  private flushStateListeners(): void {
    if (this._stateNotifyTimer) {
      clearTimeout(this._stateNotifyTimer);
      this._stateNotifyTimer = null;
      this._stateNotifyPending = false;
    }
    if (this._lastState) {
      this.stateListeners.forEach((listener) => listener(this._lastState!));
    }
  }

  /**
   * Throttled timer listener notification — max ~10/sec.
   */
  private notifyTimerListeners(): void {
    if (!this._lastTimer) return;
    if (this._timerNotifyPending) return;
    this._timerNotifyPending = true;
    this._timerNotifyTimer = setTimeout(() => {
      this._timerNotifyPending = false;
      this._timerNotifyTimer = null;
      if (this._lastTimer) {
        this.timerListeners.forEach((listener) => listener(this._lastTimer!));
      }
    }, 100);
  }

  private setConnectionState(state: ConnectionState): void {
    if (this._connectionState === state) return;
    this._connectionState = state;
    this.connectionStateListeners.forEach((listener) => listener(state));
  }

  /**
   * Notify settings listeners immediately (infrequent events).
   */
  private notifySettingsListeners(): void {
    if (!this._lastSettings) return;
    this.settingsListeners.forEach((listener) => listener(this._lastSettings!));
  }

  /**
   * Notify script info listeners immediately (infrequent events).
   */
  private notifyScriptInfoListeners(): void {
    if (!this._lastScriptInfo) return;
    this.scriptInfoListeners.forEach((listener) => listener(this._lastScriptInfo!));
  }

  private notifyScriptsChangedListeners(): void {
    for (const listener of this.scriptsChangedListeners) {
      try { listener(); } catch (err) { this.logger.error(`scripts_changed listener error: ${err}`); }
    }
  }
}
