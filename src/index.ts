import { InstanceBase, InstanceStatus } from "@companion-module/base";
import type { CompanionActionDefinitions, CompanionFeedbackDefinitions, CompanionVariableDefinitions } from "@companion-module/base";
import {
  EasyPrompterConnection,
  type ConnectionState,
  type Logger,
  type PrompterState,
  type RemoteControlAction,
  type ScriptInfo,
  type SettingsData,
  type TimerData,
} from "./remote-client/index.js";

import { type EasyPrompterConfig, getConfigFields } from "./config.js";
import { getActionDefinitions } from "./actions.js";
import { getFeedbackDefinitions } from "./feedbacks.js";
import { getVariableDefinitions } from "./variables.js";
import { getPresetDefinitions, getPresetSections } from "./presets.js";
import { MIN_SPEED, MAX_SPEED, SCRIPT_FEEDBACKS } from "./constants.js";

/**
 * EasyPrompter Companion module.
 * Connects to an EasyPrompter instance via the shared remote-client library
 * and exposes transport controls, speed adjustment, markers, and timer display.
 */
export class EasyPrompterModule extends InstanceBase {
  private connection: EasyPrompterConnection | null = null;
  private config: EasyPrompterConfig = { serverUrl: "", apiKey: "" };
  private unsubscribers: (() => void)[] = [];

  /** Cached scripts for load_script dropdown */
  cachedScripts: { id: string; label: string }[] = [];


  // --- Public state for actions/feedbacks to read ---

  /** Current connection state */
  connectionState: ConnectionState = "disconnected";
  /** Whether the prompter is currently playing */
  isPlaying = false;
  /** Current scroll speed */
  currentSpeed = 150;
  /** Whether display is blacked out */
  isBlackout = false;
  /** Currently loaded script ID */
  currentScriptId = "";
  /** Currently loaded script title (from server) */
  currentScriptTitle = "";
  /** Script ID currently being loaded (for loading feedback) */
  loadingScriptId = "";
  /** Script ID that failed to load (for failed feedback) */
  failedScriptId = "";
  /** Map of controlId → scriptId for buttons with load_script action */
  subscribedScripts = new Map<string, string>();
  private _loadingTimeout: ReturnType<typeof setTimeout> | null = null;
  private _failedTimeout: ReturnType<typeof setTimeout> | null = null;

  // --- Speed debounce state ---
  private _speedDelta = 0;
  private _speedDebounceTimer: ReturnType<typeof setTimeout> | null = null;
  private static readonly SPEED_DEBOUNCE_MS = 80;

  // --- Timer sync state ---
  private _displayedElapsed = "00:00";
  private _displayedRemaining = "00:00";
  private _pendingElapsed = "00:00";
  private _pendingRemaining = "00:00";
  private _pendingProgress = "0";
  private _timerSyncTimer: ReturnType<typeof setTimeout> | null = null;

  // --- Lifecycle ---

  async init(config: Record<string, unknown>, _isFirstInit: boolean): Promise<void> {
    this.config = config as unknown as EasyPrompterConfig;

    // Set up definitions
    this.setActionDefinitions(getActionDefinitions(this) as CompanionActionDefinitions);
    this.setFeedbackDefinitions(getFeedbackDefinitions(this) as CompanionFeedbackDefinitions);
    this.setVariableDefinitions(getVariableDefinitions() as CompanionVariableDefinitions);
    this.setPresetDefinitions(getPresetSections(), getPresetDefinitions());

    // Set initial variable values
    this.setVariableValues({
      speed: "—",
      status: "Offline",
      elapsed: "00:00",
      remaining: "00:00",
      progress: "0",
      is_playing: "Paused",
      font_size: "—",
      line_height: "—",
      script_title: "—",
      script_id: "",
      blackout: "OFF",
      screen_margin: "—",
    });

    // Connect if configured
    if (this.config.serverUrl && this.config.apiKey) {
      this.connect();
    } else {
      this.updateStatus(InstanceStatus.Disconnected, "Missing configuration");
    }
  }

  async configUpdated(config: Record<string, unknown>): Promise<void> {
    this.config = config as unknown as EasyPrompterConfig;
    this.disconnect();

    if (this.config.serverUrl && this.config.apiKey) {
      this.connect();
    } else {
      this.updateStatus(InstanceStatus.Disconnected, "Missing configuration");
    }
  }

  async destroy(): Promise<void> {
    this.subscribedScripts.clear();
    this.disconnect();
  }

  getConfigFields() {
    return getConfigFields();
  }

  // --- Public methods for actions ---

  /**
   * Send a remote control action to the connected EasyPrompter instance.
   * Called by action callbacks.
   */
  sendAction(action: RemoteControlAction): void {
    if (!this.connection || this.connectionState !== "active") {
      this.log("warn", `Cannot send "${action.type}" — not connected`);
      return;
    }
    this.connection.sendRemoteControl(action);
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
      : [];
    const isAlreadyLoaded =
      scriptId === this.currentScriptId ||
      (!this.currentScriptId && titleMatches.length === 1 && titleMatches[0].id === scriptId);

    if (isAlreadyLoaded) {
      this.log("info", `[LoadScript] Script "${scriptId}" is already loaded — returning success`);
      this.currentScriptId = scriptId;
      this.checkFeedbacks(...SCRIPT_FEEDBACKS);
      return;
    }

    this.sendAction({ type: "switch_script", scriptId });

    // Enter loading state
    this.loadingScriptId = scriptId;
    this.failedScriptId = "";
    if (this._failedTimeout) { clearTimeout(this._failedTimeout); this._failedTimeout = null; }
    this.checkFeedbacks("is_loading_script", "is_failed_script");

    // Timeout: show failed after 8s
    if (this._loadingTimeout) clearTimeout(this._loadingTimeout);
    this._loadingTimeout = setTimeout(() => {
      if (this.loadingScriptId === scriptId) {
        this.loadingScriptId = "";
        this.failedScriptId = scriptId;
        this.checkFeedbacks("is_loading_script", "is_failed_script");

        // Auto-clear failed after 5s
        this._failedTimeout = setTimeout(() => {
          this.failedScriptId = "";
          this.checkFeedbacks("is_failed_script");
        }, 5000);
      }
    }, 8000);
  }

  private clearLoadingState(): void {
    this.loadingScriptId = "";
    this.failedScriptId = "";
    if (this._loadingTimeout) { clearTimeout(this._loadingTimeout); this._loadingTimeout = null; }
    if (this._failedTimeout) { clearTimeout(this._failedTimeout); this._failedTimeout = null; }
  }

  /**
   * Queue a speed change delta. Rapid calls are batched into a single
   * `set_speed` after a short debounce window.
   */
  queueSpeedChange(delta: number): void {
    this._speedDelta += delta;
    if (this._speedDebounceTimer) {
      clearTimeout(this._speedDebounceTimer);
    }
    this._speedDebounceTimer = setTimeout(() => {
      this._speedDebounceTimer = null;
      const d = this._speedDelta;
      this._speedDelta = 0;
      if (d === 0) return;
      const newSpeed = Math.max(
        MIN_SPEED,
        Math.min(MAX_SPEED, this.currentSpeed + d)
      );
      this.sendAction({ type: "set_speed", speedWpm: newSpeed });
    }, EasyPrompterModule.SPEED_DEBOUNCE_MS);
  }

  // --- Private connection management ---

  private connect(): void {
    // Create the connection manager with Companion's logger
    const logger: Logger = {
      info: (msg) => this.log("info", msg),
      warn: (msg) => this.log("warn", msg),
      error: (msg) => this.log("error", msg),
      debug: (msg) => this.log("debug", msg),
    };

    this.log("info", `Connecting with URL="${this.config.serverUrl}" apiKey="${this.config.apiKey ? `${this.config.apiKey.slice(0, 4)}...(len=${this.config.apiKey.length})` : "(empty)"}" `);

    this.connection = new EasyPrompterConnection(
      this.config.serverUrl,
      this.config.apiKey,
      logger
    );

    this.updateStatus(InstanceStatus.Connecting);

    // Subscribe to connection state changes
    this.unsubscribers.push(
      this.connection.onConnectionStateChange(
        (state: ConnectionState) => {
          this.connectionState = state;
          this.updateCompanionStatus(state);
          this.updateStatusVariable(state);
          this.checkFeedbacks("is_connected", "is_waiting");
        }
      )
    );

    // Subscribe to prompter state changes
    this.unsubscribers.push(
      this.connection.onStateChange((state: PrompterState) => {
        this.isPlaying = state.isPlaying;
        this.currentSpeed = state.speed;

        this.setVariableValues({
          speed: String(Math.round(state.speed)),
          is_playing: state.isPlaying ? "Playing" : "Paused",
        });

        this.checkFeedbacks("is_playing");
      })
    );

    // Subscribe to timer updates.
    // Timer strings update at 4Hz from the operator's position pings.
    // Elapsed and remaining cross second boundaries on different pings,
    // causing visual desync (one updates 250ms before the other).
    // Fix: buffer the latest values and only push to Companion variables
    // when BOTH have changed since the last displayed pair.
    this.unsubscribers.push(
      this.connection.onTimerChange((data: TimerData) => {
        const [elapsed, remaining] = EasyPrompterModule.compactTimerPair(
          data.elapsed ?? "00:00",
          data.remaining ?? "00:00",
        );

        // Always update progress immediately (it changes smoothly)
        const progress = data.progress != null ? String(Math.round(data.progress)) : "0";

        const elapsedChanged = elapsed !== this._displayedElapsed;
        const remainingChanged = remaining !== this._displayedRemaining;

        if (elapsedChanged && remainingChanged) {
          // Both changed — cancel any pending sync timer and push immediately
          if (this._timerSyncTimer) {
            clearTimeout(this._timerSyncTimer);
            this._timerSyncTimer = null;
          }
          this._displayedElapsed = elapsed;
          this._displayedRemaining = remaining;
          this.setVariableValues({ elapsed, remaining, progress });
        } else if (elapsedChanged || remainingChanged) {
          // Only one changed — buffer latest values and wait up to 600ms
          // for the other to catch up on the next ping.
          // elapsed uses floor (ticks at .000) and remaining uses round
          // (ticks at .500), so they're always ~500ms apart.
          this._pendingElapsed = elapsed;
          this._pendingRemaining = remaining;
          this._pendingProgress = progress;
          if (!this._timerSyncTimer) {
            this._timerSyncTimer = setTimeout(() => {
              this._timerSyncTimer = null;
              this._displayedElapsed = this._pendingElapsed;
              this._displayedRemaining = this._pendingRemaining;
              this.setVariableValues({
                elapsed: this._pendingElapsed,
                remaining: this._pendingRemaining,
                progress: this._pendingProgress,
              });
            }, 600);
          }
        } else {
          // Neither changed — just update progress
          this.setVariableValues({ progress });
        }
      })
    );
    // Subscribe to display settings changes (font size, line height, blackout)
    this.unsubscribers.push(
      this.connection.onSettingsChange((data: SettingsData) => {
        const vars: Record<string, string> = {};
        if (data.fontSize !== undefined) vars.font_size = String(Math.round(data.fontSize));
        if (data.lineHeight !== undefined) vars.line_height = String(Math.round(data.lineHeight));
        if (data.screenMargin !== undefined) vars.screen_margin = String(Math.round(data.screenMargin));
        if (data.blackout !== undefined) {
          this.isBlackout = data.blackout;
          vars.blackout = data.blackout ? "ON" : "OFF";
          this.checkFeedbacks("is_blackout");
        }
        if (Object.keys(vars).length > 0) {
          this.setVariableValues(vars);
        }
      })
    );

    // Subscribe to script info changes
    this.unsubscribers.push(
      this.connection.onScriptInfoChange((data: ScriptInfo) => {
        this.log("info", `Script info received: ${JSON.stringify(data)}`);
        if (data.scriptTitle !== undefined) {
          this.currentScriptTitle = data.scriptTitle || "";
          this.setVariableValues({ script_title: data.scriptTitle || "—" });
        }

        // Server may only send scriptTitle without scriptId.
        // Resolve scriptId from cachedScripts when missing.
        let resolvedScriptId = data.scriptId ?? "";
        if (!resolvedScriptId && data.scriptTitle) {
          const match = this.cachedScripts.find((s) => s.label === data.scriptTitle);
          if (match) resolvedScriptId = match.id;
        }

        // Only overwrite currentScriptId when we have a definitive value.
        // Title-only events that arrive before cachedScripts are loaded
        // would otherwise clear a previously resolved ID.
        if (resolvedScriptId || data.scriptId !== undefined) {
          this.currentScriptId = resolvedScriptId;
          this.setVariableValues({ script_id: this.currentScriptId });
        }

        this.log("info", `[LoadScript] scriptInfo: currentScriptId="${this.currentScriptId}" loadingScriptId="${this.loadingScriptId}"`);

        // Handle loading state transitions
        if (this.loadingScriptId) {
          if (this.currentScriptId === this.loadingScriptId) {
            this.log("info", `[LoadScript] Script confirmed loaded — clearing loading state`);
            this.clearLoadingState();
          } else if (this.currentScriptId) {
            this.log("info", `[LoadScript] Different script loaded (${this.currentScriptId}) — clearing loading`);
            this.clearLoadingState();
          }
          // else: no definitive scriptId yet, keep loading
        }

        this.checkFeedbacks(...SCRIPT_FEEDBACKS);
      })
    );

    // Re-fetch scripts when the server signals a change (create, delete, rename)
    this.unsubscribers.push(
      this.connection.onScriptsChanged(() => {
        this.refreshScripts();
      })
    );

    // Start the connection
    this.connection.connect();

    // Fetch user scripts for the load_script dropdown
    this.refreshScripts();
  }

  /**
   * Fetch user's recent scripts from the API and update the load_script dropdown choices.
   */
  private async refreshScripts(): Promise<void> {
    if (!this.config.serverUrl || !this.config.apiKey) return;

    try {
      const url = this.config.serverUrl.replace(/\/+$/, "") + "/api/remote-keys/scripts";
      const resp = await fetch(url, {
        headers: { "Authorization": "Bearer " + this.config.apiKey },
      });

      if (!resp.ok) {
        this.log("warn", `Failed to fetch scripts: HTTP ${resp.status}`);
        return;
      }

      const data = await resp.json() as { scripts?: unknown[] };
      const rawScripts = Array.isArray(data.scripts) ? data.scripts : [];
      const newScripts = rawScripts
        .filter((s): s is { id: string; title: string } =>
          typeof s === "object" && s !== null &&
          typeof (s as Record<string, unknown>).id === "string" &&
          typeof (s as Record<string, unknown>).title === "string"
        )
        .map((s) => ({ id: s.id, label: s.title || "(Untitled)" }));

      if (newScripts.length === 0 && this.cachedScripts.length === 0) {
        this.log("warn", "[RefreshScripts] No scripts found — ensure scripts exist in your EasyPrompter account");
      }

      // Skip action/feedback redefinition if the list hasn't changed
      const changed = JSON.stringify(newScripts) !== JSON.stringify(this.cachedScripts);
      this.cachedScripts = newScripts;

      if (changed) {
        this.setActionDefinitions(getActionDefinitions(this) as CompanionActionDefinitions);
        this.setFeedbackDefinitions(getFeedbackDefinitions(this) as CompanionFeedbackDefinitions);
      }

      // Re-resolve currentScriptId in case scriptInfo arrived before scripts were cached
      if (!this.currentScriptId && this.currentScriptTitle) {
        const match = this.cachedScripts.find((s) => s.label === this.currentScriptTitle);
        if (match) {
          this.currentScriptId = match.id;
          this.setVariableValues({ script_id: this.currentScriptId });
          this.log("info", `[RefreshScripts] Resolved currentScriptId="${match.id}" from title "${this.currentScriptTitle}"`);
        } else {
          this.log("info", `[RefreshScripts] Could not resolve scriptId from title "${this.currentScriptTitle}" — no match in ${this.cachedScripts.length} cached scripts`);
        }
      }
      this.checkFeedbacks(...SCRIPT_FEEDBACKS);

      this.log("info", `Refreshed scripts: ${this.cachedScripts.length} found, currentScriptId="${this.currentScriptId}"`);
    } catch (err) {
      this.log("warn", `Failed to fetch scripts: ${err}`);
    }


  }

  private disconnect(): void {
    // Unsubscribe all listeners
    for (const unsub of this.unsubscribers) {
      unsub();
    }
    this.unsubscribers = [];

    // Disconnect and clean up
    if (this.connection) {
      this.connection.disconnect();
      this.connection = null;
    }

    // Reset state
    this.connectionState = "disconnected";
    this.isPlaying = false;
    this.isBlackout = false;
    this.currentSpeed = 150;
    this.currentScriptId = "";
    this.currentScriptTitle = "";



    // Clear timer sync
    if (this._timerSyncTimer) {
      clearTimeout(this._timerSyncTimer);
      this._timerSyncTimer = null;
    }

    // Clear speed debounce
    if (this._speedDebounceTimer) {
      clearTimeout(this._speedDebounceTimer);
      this._speedDebounceTimer = null;
    }
    this._speedDelta = 0;

    // Clear loading/failed timers
    if (this._loadingTimeout) {
      clearTimeout(this._loadingTimeout);
      this._loadingTimeout = null;
    }
    if (this._failedTimeout) {
      clearTimeout(this._failedTimeout);
      this._failedTimeout = null;
    }

    this.loadingScriptId = "";
    this.failedScriptId = "";


    // Only reset connection-dependent values; keep last-known progress,
    // timer, and display settings so they persist across
    // reconnects rather than flashing to zero.
    this.setVariableValues({
      speed: "—",
      status: "Offline",
      is_playing: "Paused",
      blackout: "OFF",
    });
  }

  /**
   * Map remote-client ConnectionState to Companion InstanceStatus.
   */
  private updateCompanionStatus(state: ConnectionState): void {
    switch (state) {
      case "active":
        this.updateStatus(InstanceStatus.Ok);
        break;
      case "waiting":
        this.updateStatus(
          InstanceStatus.Ok,
          "Waiting for teleprompter session"
        );
        break;
      case "disconnected":
        this.updateStatus(InstanceStatus.Disconnected);
        break;
      case "error":
        this.updateStatus(InstanceStatus.ConnectionFailure);
        break;
    }
  }

  /**
   * Update the status variable based on connection state.
   */
   private updateStatusVariable(state: ConnectionState): void {
    const labels: Record<ConnectionState, string> = {
      active: "Connected",
      waiting: "Waiting",
      disconnected: "Offline",
      error: "Error",
    };
    this.setVariableValues({ status: labels[state] });
  }

  /**
   * Strip leading "00:" hours from an HH:MM:SS pair when the script is
   * under 1 hour, so the text fits on small Companion button displays.
   * If either value has non-zero hours, both keep the full HH:MM:SS format
   * for visual consistency.
   */
  static compactTimerPair(a: string, b: string): [string, string] {
    const strip = (s: string): string => {
      const parts = s.split(":");
      // Only strip if exactly 3 segments and hours segment is "00"
      if (parts.length === 3 && parts[0] === "00") return parts.slice(1).join(":");
      return s;
    };
    const hasHours = (s: string): boolean => {
      const parts = s.split(":");
      return parts.length === 3 && parts[0] !== "00";
    };
    // If either value has non-zero hours, keep both in HH:MM:SS
    if (hasHours(a) || hasHours(b)) return [a, b];
    return [strip(a), strip(b)];
  }
}

export const UpgradeScripts: never[] = [];

export default EasyPrompterModule;
