// FR-103: the ONLY module allowed to branch on browser behaviour. Feature detection first.
// Every branch must document browser, version and removal condition.
//
// Current branches:
//  (none browser-identified). All paths below use feature detection only.

/** Minimum Chromium version this build needs: sidePanel.open() landed in Chromium 116 (§16.2). */
export const MIN_CHROMIUM = 116;

export function chromiumVersion() {
  const brand = navigator.userAgentData?.brands?.find((b) => b.brand === 'Chromium');
  if (brand) return Number(brand.version);
  const m = navigator.userAgent.match(/Chrom(?:e|ium)\/(\d+)/);
  return m ? Number(m[1]) : null;
}

/** Make the toolbar action open the side panel (Brave and Chrome both support this API). */
export async function enableActionOpensPanel() {
  if (chrome.sidePanel?.setPanelBehavior) {
    await chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
  }
}

/**
 * §11.2: open the side panel for a conversation from a notification click. Uses sidePanel.open()
 * when the browser accepts the click as a qualifying gesture; otherwise falls back to an extension tab.
 * Brave note (§16.2): the panel is opened only for normal browser windows, never popup windows.
 */
export async function openConversationUi(conversationId) {
  const url = chrome.runtime.getURL(`src/sidepanel/sidepanel.html?conversation=${encodeURIComponent(conversationId)}`);
  try {
    const win = await chrome.windows.getLastFocused({ windowTypes: ['normal'] });
    if (win?.id != null && win.type === 'normal' && typeof chrome.sidePanel?.open === 'function') {
      await chrome.storage.session.set({ focusConversation: conversationId });
      await chrome.sidePanel.open({ windowId: win.id });
      return 'sidepanel';
    }
  } catch {
    // Gesture not accepted or API unavailable: fall through to the tab.
  }
  await chrome.tabs.create({ url });
  return 'tab';
}

/** Notifications may be denied or unavailable; callers fall back to the action badge. */
export async function notificationsAvailable() {
  if (!chrome.notifications?.create) return false;
  if (!chrome.notifications.getPermissionLevel) return true;
  return new Promise((resolve) => chrome.notifications.getPermissionLevel((lvl) => resolve(lvl === 'granted')));
}
