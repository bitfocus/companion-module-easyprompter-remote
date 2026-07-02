/**
 * Pluggable logger interface.
 * Consumers inject their framework's logger (e.g. Stream Deck, Companion).
 * Defaults to console when not provided.
 */
export interface Logger {
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
  debug(message: string): void;
}

/**
 * Connection state for a remote device.
 */
export type ConnectionState = "disconnected" | "waiting" | "active" | "error";

/**
 * Remote control actions sent to the server via socket.io.
 */
export type RemoteControlAction =
  | { type: "play_pause" }
  | { type: "reset" }
  | { type: "next_marker" }
  | { type: "prev_marker" }
  | { type: "rewind_start"; displacement?: number }
  | { type: "rewind_stop" }
  | { type: "fast_forward_start"; displacement?: number }
  | { type: "fast_forward_stop" }
  | { type: "set_speed"; speedWpm: number }
  | { type: "shuttle_set"; displacement: number }
  | { type: "shuttle_release" }
  | { type: "jog_tick"; direction: 1 | -1; magnitude?: number }
  | { type: "font_size_step"; delta: number }
  | { type: "line_height_step"; delta: number }
  | { type: "margin_step"; delta: number }
  | { type: "blackout_toggle" }
  | { type: "switch_script"; scriptId: string };

/**
 * Playback state received from the server.
 */
export interface PlaybackState {
  paused?: number; // 0 = playing, 1 = paused
  playbackSpeed?: number;
  playbackStartTime?: string | null;
  playbackStartAnchorIndex?: number;
  pauseReason?: "manual" | "auto" | null;
}

/**
 * Prompter state tracked locally from server events.
 */
export interface PrompterState {
  /** Whether the teleprompter is currently playing */
  isPlaying: boolean;
  /** Current scroll speed */
  speed: number;
}

/**
 * Timer data received from the server (pre-formatted display strings).
 */
export interface TimerData {
  /** Elapsed time display string, e.g. "05:23" or "1:05:23" */
  elapsed?: string;
  /** Remaining time display string */
  remaining?: string;
  /** Progress percentage 0-100 */
  progress?: number;
}

/**
 * Display settings received from the server's settings_update channel.
 */
export interface SettingsData {
  fontSize?: number;
  lineHeight?: number;
  screenMargin?: number;
  blackout?: boolean;
  activeDisplayName?: string | null;
  activeDisplayColor?: string | null; // hex color e.g. "#448AFF"
}

/**
 * Script info extracted from settings.
 */
export interface ScriptInfo {
  scriptTitle?: string;
  scriptId?: string;
}
