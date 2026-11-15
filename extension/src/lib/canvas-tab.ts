/** Whether the active tab is on the Canvas site. The extension has no `tabs` permission, but the Canvas host permission already lets it read a Canvas tab's address. */

import { DEFAULT_CANVAS_ORIGIN } from "@/src/config/canvas";

export function isCanvasUrl(url: string | undefined, origin: string = DEFAULT_CANVAS_ORIGIN): boolean {
  if (!url) return false;
  try {
    return new URL(url).origin === origin;
  } catch {
    return false;
  }
}

/** True when the active tab of the current window is a Canvas page; any failure counts as "no". */
export async function canvasTabIsActive(origin: string = DEFAULT_CANVAS_ORIGIN): Promise<boolean> {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    return isCanvasUrl(tab?.url, origin);
  } catch {
    return false;
  }
}

/** The line shown in the popup when it is opened away from Canvas. */
export const OPEN_CANVAS_PROMPT = "Open canvas.cornell.edu to sync";
