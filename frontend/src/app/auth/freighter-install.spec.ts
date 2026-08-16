import { detectBrowser, freighterInstallTarget } from './freighter-install';

const CHROME_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
const FIREFOX_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:127.0) Gecko/20100101 Firefox/127.0';
const EDGE_UA = `${CHROME_UA} Edg/126.0.0.0`;
const OPERA_UA = `${CHROME_UA} OPR/110.0.0.0`;
const SAFARI_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15';

describe('freighter-install', () => {
  describe('detectBrowser', () => {
    it('identifies Chrome', () => {
      expect(detectBrowser({ userAgent: CHROME_UA })).toBe('chrome');
    });

    it('identifies Firefox', () => {
      expect(detectBrowser({ userAgent: FIREFOX_UA })).toBe('firefox');
    });

    it('identifies Edge ahead of Chrome, since both report Chrome/', () => {
      expect(detectBrowser({ userAgent: EDGE_UA })).toBe('edge');
    });

    it('identifies Brave by navigator.brave, since its user agent matches Chrome', () => {
      expect(detectBrowser({ userAgent: CHROME_UA, brave: { isBrave: () => true } })).toBe('brave');
    });

    it('does not claim Chrome for other Chromium forks', () => {
      expect(detectBrowser({ userAgent: OPERA_UA })).toBe('unknown');
    });

    it('falls back to unknown for browsers without a Freighter extension', () => {
      expect(detectBrowser({ userAgent: SAFARI_UA })).toBe('unknown');
      expect(detectBrowser({ userAgent: '' })).toBe('unknown');
    });
  });

  describe('freighterInstallTarget', () => {
    it('links Chrome to the Chrome Web Store listing', () => {
      const target = freighterInstallTarget({ userAgent: CHROME_UA });
      expect(target.browser).toBe('chrome');
      expect(target.storeName).toBe('Chrome Web Store');
      expect(target.url).toContain('chromewebstore.google.com');
    });

    it('links Firefox to the Firefox Add-ons listing', () => {
      const target = freighterInstallTarget({ userAgent: FIREFOX_UA });
      expect(target.storeName).toBe('Firefox Add-ons');
      expect(target.url).toContain('addons.mozilla.org');
    });

    it('sends Brave and Edge to the Chrome Web Store', () => {
      const brave = freighterInstallTarget({ userAgent: CHROME_UA, brave: {} });
      const edge = freighterInstallTarget({ userAgent: EDGE_UA });
      expect(brave.url).toContain('chromewebstore.google.com');
      expect(edge.url).toContain('chromewebstore.google.com');
    });

    it('falls back to the Freighter site for unrecognised browsers', () => {
      const target = freighterInstallTarget({ userAgent: SAFARI_UA });
      expect(target.url).toBe('https://www.freighter.app/');
    });
  });
});
