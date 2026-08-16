/** Browsers Freighter ships an extension for, plus a catch-all. */
export type BrowserId = 'chrome' | 'brave' | 'edge' | 'firefox' | 'unknown';

export interface InstallTarget {
  browser: BrowserId;
  /** Store name shown on the install link, e.g. `Chrome Web Store`. */
  storeName: string;
  url: string;
}

// Chromium-based browsers all install Freighter from the Chrome Web Store.
const CHROME_WEB_STORE =
  'https://chromewebstore.google.com/detail/freighter/bcacfldlkkdogcmkkibnjlakofdplcbk';
const FIREFOX_ADD_ONS = 'https://addons.mozilla.org/firefox/addon/freighter/';
const FREIGHTER_HOME = 'https://www.freighter.app/';

const INSTALL_TARGETS: Record<BrowserId, Omit<InstallTarget, 'browser'>> = {
  chrome: { storeName: 'Chrome Web Store', url: CHROME_WEB_STORE },
  brave: { storeName: 'Chrome Web Store', url: CHROME_WEB_STORE },
  edge: { storeName: 'Chrome Web Store', url: CHROME_WEB_STORE },
  firefox: { storeName: 'Firefox Add-ons', url: FIREFOX_ADD_ONS },
  unknown: { storeName: 'Freighter website', url: FREIGHTER_HOME },
};

/** The `navigator` properties browser detection reads. */
export interface BrowserSignals {
  userAgent: string;
  /** Brave exposes a `navigator.brave` object; its user agent is otherwise Chrome's. */
  brave?: unknown;
}

export function detectBrowser(signals: BrowserSignals): BrowserId {
  const userAgent = signals.userAgent ?? '';
  if (signals.brave) return 'brave';
  if (/Firefox\/\d/.test(userAgent)) return 'firefox';
  if (/Edg\/\d/.test(userAgent)) return 'edge';
  // Opera and other Chromium forks report `Chrome/` too but do not carry the
  // Chrome Web Store, so send them to the Freighter site instead.
  if (/Chrome\/\d/.test(userAgent) && !/OPR\/|Opera/.test(userAgent)) return 'chrome';
  return 'unknown';
}

/** Resolves the extension store link to offer for the current browser. */
export function freighterInstallTarget(signals: BrowserSignals): InstallTarget {
  const browser = detectBrowser(signals);
  return { browser, ...INSTALL_TARGETS[browser] };
}
