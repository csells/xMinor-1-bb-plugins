// lib/limits.ts — the limit snapshot, in plain data.
//
// Everything here is pure: no DOM, no React. Two surfaces read the same
// snapshot — the rings drawn by the content script and the Usage page — and a
// window that means "session" on one of them has to mean "session" on the
// other, down to the wording and the colour thresholds.
import type { UsageState, UsageWindow } from "../server";

/** Plugin id, also the first segment of every panel route. */
export const PLUGIN_ID = "usage-meter";
/** URL segment of the Usage page under /plugins/<id>/. */
export const PANEL_PATH = "usage";
/** Full route of the Usage page — the fallback link for the content script. */
export const PANEL_URL = `/plugins/${PLUGIN_ID}/${PANEL_PATH}`;

/** Window labels from the API, the ones the rings are looked up by. */
export const SESSION_LABEL = "Current session";
export const WEEKLY_LABEL = "Weekly limit";

/** Case and stray spaces in a window label are none of our business. */
export function labelKey(label: string): string {
  return label.trim().toLowerCase();
}

/** Which ring this window gets; null — a window with no ring (the per-model limit). */
export function ringOf(label: string): "outer" | "inner" | null {
  const key = labelKey(label);
  if (key === labelKey(SESSION_LABEL)) return "outer";
  if (key === labelKey(WEEKLY_LABEL)) return "inner";
  return null;
}

/**
 * Colour thresholds. The neighbouring server-status plugin has its own (80%
 * and 90%): that is RAM, worth worrying about only near the ceiling, while
 * this is a limit that was paid for and is worth noticing at 60%. Both
 * surfaces name the thresholds in words so one colour cannot be read as one
 * alarm.
 */
export const WARN = 60;
export const DANGER = 85;

/**
 * The API's own window labels are long for a narrow panel. Model names
 * ("Fable") are left exactly as they come.
 */
export const SHORT_LABEL: Record<string, string> = {
  [labelKey(SESSION_LABEL)]: "Session",
  [labelKey(WEEKLY_LABEL)]: "Week",
};

export function percentOf(limit: UsageWindow | null): number | null {
  if (!limit || !Number.isFinite(limit.usedPercent)) return null;
  return Math.min(100, Math.max(0, limit.usedPercent));
}

/**
 * Whether the snapshot holds figures worth trusting. After a one-off poll
 * failure the backend keeps the previous windows (see `toState` in server.ts) —
 * they are old but real, and honester than an empty ring. A cleared snapshot
 * (`not_installed`, `unauthenticated`, `expired`, `unknown`) arrives with no
 * windows at all.
 */
export function hasFigures(state: UsageState | null): state is UsageState {
  if (!state || state.windows.length === 0) return false;
  return state.status === "ok" || state.status === "error";
}

/**
 * A window by label. The API owns the set of windows and is allowed to differ:
 * a window that is not there is not an error, it simply gets no ring.
 */
export function findWindow(
  state: UsageState | null,
  label: string,
): UsageWindow | null {
  if (!hasFigures(state)) return null;
  const wanted = labelKey(label);
  return state.windows.find((w) => labelKey(w.label) === wanted) ?? null;
}

/**
 * The largest of the windows that got no ring (today that is the per-model
 * limit). It drives the dot on the button: without it an exhausted window
 * would keep quiet.
 */
export function extraMax(state: UsageState | null): number | null {
  if (!hasFigures(state)) return null;
  let top: number | null = null;
  for (const limit of state.windows) {
    if (ringOf(limit.label) !== null) continue;
    const percent = percentOf(limit);
    if (percent !== null && (top === null || percent > top)) top = percent;
  }
  return top;
}

const TIME_FORMAT = new Intl.DateTimeFormat("en-GB", {
  hour: "2-digit",
  minute: "2-digit",
});
const DATE_FORMAT = new Intl.DateTimeFormat("en-GB", {
  day: "numeric",
  month: "short",
});

/** Whether the date is today — that decides if the label needs a date at all. */
export function isToday(at: Date): boolean {
  const now = new Date();
  return (
    at.getFullYear() === now.getFullYear() &&
    at.getMonth() === now.getMonth() &&
    at.getDate() === now.getDate()
  );
}

/** A date with no trailing dot: Intl gives "24 Aug." where "24 Aug" is wanted. */
export function dayText(at: Date): string {
  return DATE_FORMAT.format(at).replace(/\.$/, "");
}

/** "resets at 17:20" for a reset today, "resets 24 Aug at 01:30" for the rest. */
export function resetText(iso: string | null): string {
  if (!iso) return "";
  const exact = new Date(iso);
  if (Number.isNaN(exact.getTime())) return "";
  // The API returns a time with seconds (…14:19:59.781Z). Round to the minute,
  // or "resets at 17:19" looks like it is off by one.
  const at = new Date(Math.round(exact.getTime() / 60_000) * 60_000);
  const time = TIME_FORMAT.format(at);
  // The date alone is not an answer to "when does this free up again": a session
  // that rolls past midnight resets in the small hours, and "resets 4 Sep" reads
  // as a whole day away. The clock stays, the day is what gets added.
  return isToday(at) ? `resets at ${time}` : `resets ${dayText(at)} at ${time}`;
}

/** "Figures as of 16:48" — the age of the last successful snapshot. */
export function ageText(iso: string | null): string {
  if (!iso) return "";
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return "";
  return isToday(at)
    ? `Figures as of ${TIME_FORMAT.format(at)}`
    : `Figures from ${dayText(at)}, ${TIME_FORMAT.format(at)}`;
}

/**
 * Provider messages arrive as prose ("Claude usage is rate limited right
 * now."), which is too long for a panel row. Known ones become a short phrase;
 * an unknown one never enters the row body — it moves into the hover tooltip.
 */
const PROVIDER_REASONS: Array<[RegExp, string]> = [
  [
    /rate limit/i,
    "Claude is rate limiting requests, the figures will catch up later",
  ],
  [/timed out|timeout|ETIMEDOUT/i, "Claude Code did not answer in time"],
  [
    /ENOTFOUND|ECONNREFUSED|ECONNRESET|fetch failed|network/i,
    "No connection to Claude",
  ],
];

/** A short cause; null when the message is unknown or absent. */
export function reasonText(message: string | null): string | null {
  if (!message) return null;
  for (const [pattern, text] of PROVIDER_REASONS) {
    if (pattern.test(message)) return text;
  }
  return null;
}

/** A row of text: what to show, and what to hide in the tooltip. */
export interface Line {
  text: string;
  /** The provider's raw text — on hover only, never in the interface. */
  title: string | null;
}

/** Why there are no figures, in plain words. */
export function statusLine(state: UsageState | null): Line {
  if (!state || state.status === "unknown") {
    return { text: "Loading limits…", title: null };
  }
  switch (state.status) {
    case "not_installed":
      return { text: "Claude Code is not installed", title: null };
    case "unauthenticated":
      return { text: "Claude Code is not signed in", title: null };
    case "expired":
      return { text: "The Claude Code session has expired, sign in again", title: null };
    case "error": {
      const reason = reasonText(state.message);
      return reason
        ? { text: `Could not read the limits: ${reason}`, title: null }
        : { text: "Could not read the limits", title: state.message };
    }
    default:
      return { text: "Limits are not reported", title: null };
  }
}

/** The age of the previous figures and why they did not refresh. */
export function staleLine(state: UsageState): Line {
  const reason = reasonText(state.message);
  const age = ageText(state.okAt);
  const failure = reason ? `refresh failed: ${reason}` : "refresh failed";
  return {
    text: age ? `${age} · ${failure}` : `${failure[0].toUpperCase()}${failure.slice(1)}`,
    title: reason ? null : state.message,
  };
}
