// Keeps the MV3 service worker alive while a provider call is in flight.
//
// Chromium can stop an idle extension service worker after ~30 s and may stop it while waiting on
// a slow fetch() response. Calling an extension API resets the idle timer, so we make a cheap call
// every 20 s while an operation runs. Whether this alone survives the 180 s silent first-content
// wait and the 300 s non-streaming deadline is exactly what PoC criteria 1–3 (§16.1) must prove on
// Brave and Chrome. If it does not, replace this with an offscreen-document mechanism.

const INTERVAL_MS = 20_000;
let holders = 0;
let timer = null;

export function acquireKeepalive() {
  holders += 1;
  if (!timer) timer = setInterval(() => { chrome.runtime.getPlatformInfo(() => {}); }, INTERVAL_MS);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    holders -= 1;
    if (holders <= 0) {
      clearInterval(timer);
      timer = null;
      holders = 0;
    }
  };
}
