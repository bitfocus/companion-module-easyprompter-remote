/**
 * Shared constants for the EasyPrompter Companion module.
 * Centralises magic strings and duplicated values used across
 * actions.ts, feedbacks.ts, index.ts, and presets.ts.
 */

// ── Feedback IDs (used in feedbacks.ts definitions + checkFeedbacks() calls) ──
export const FEEDBACK = {
  IS_PLAYING: "is_playing",
  IS_CONNECTED: "is_connected",
  IS_WAITING: "is_waiting",
  IS_BLACKOUT: "is_blackout",
  IS_ACTIVE_SCRIPT: "is_active_script",
  IS_LOADING_SCRIPT: "is_loading_script",
  IS_FAILED_SCRIPT: "is_failed_script",
} as const;

/** Convenience tuple for the three script-related feedbacks. */
export const SCRIPT_FEEDBACKS = [
  FEEDBACK.IS_ACTIVE_SCRIPT,
  FEEDBACK.IS_LOADING_SCRIPT,
  FEEDBACK.IS_FAILED_SCRIPT,
] as const;

// ── Speed bounds ──
export const MIN_SPEED = 10;
export const MAX_SPEED = 500;
