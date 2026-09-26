/**
 * A clock that re-renders.
 *
 * Every time-relative label — "Today", "Due soon", "in 3 hours" — is only
 * correct for the instant it was computed. A tab left open overnight kept
 * rendering 11:59 PM items under "Today" at 12:01 AM, because React had no
 * reason to re-render: the data had not changed, only the time had.
 *
 * This hook makes the passage of time a state change. Three triggers:
 *
 * 1. **A timer**, so a page nobody touches still crosses midnight correctly.
 * 2. **Window focus**, so returning to a backgrounded tab is instantly right
 *    rather than right within 30 seconds.
 * 3. **`visibilitychange`**, which covers the case focus does not: switching
 *    back to a tab in an already-focused window. Browsers also throttle timers
 *    in hidden tabs, so the timer alone cannot be relied on here.
 */

import { useEffect, useState } from "react";

/** How often the clock ticks while the page is visible. */
export const DEFAULT_TICK_MS = 30_000;

/**
 * Returns a `Date` that updates on a timer, on focus, and on tab visibility.
 *
 * Pass it to anything time-relative rather than calling `new Date()` inside a
 * render — that is the thing this exists to prevent.
 */
export function useNow(tickMs: number = DEFAULT_TICK_MS): Date {
  const [now, setNow] = useState(() => new Date());

  useEffect(() => {
    const tick = () => setNow(new Date());

    const interval = setInterval(tick, tickMs);
    // Re-sync the moment the user could be looking at it again.
    const onVisible = () => {
      if (document.visibilityState === "visible") tick();
    };

    window.addEventListener("focus", tick);
    document.addEventListener("visibilitychange", onVisible);

    return () => {
      clearInterval(interval);
      window.removeEventListener("focus", tick);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [tickMs]);

  return now;
}
