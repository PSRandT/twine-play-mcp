import type { BrowserContext, BrowserContextOptions, LaunchOptions } from 'playwright-core';
import { SessionManager, type GameSession, type OpenGameOptions } from './session.js';
import { publicHttpsUrl } from './network-policy.js';

export class ContextBudget {
  active = 0;
  constructor(readonly maximum = 4) {}
  acquire() {
    if (this.active >= this.maximum) throw new Error('Browser capacity reached; close a game first.');
    this.active++;
  }
  release() {
    this.active--;
  }
}

export class RemoteSessionManager extends SessionManager {
  protected override persistDownloads = false;
  private touched = new Map<string, number>();
  private pending = 0;
  private disposed = false;
  constructor(
    private proxy: string,
    private budget: ContextBudget,
    private clock = Date.now,
  ) {
    super();
  }
  protected override launchOptions(): LaunchOptions {
    return {
      chromiumSandbox: true,
      proxy: { server: this.proxy },
      args: [
        '--no-first-run',
        '--no-default-browser-check',
        '--proxy-bypass-list=<-loopback>',
        '--disable-quic',
        '--force-webrtc-ip-handling-policy=disable_non_proxied_udp',
        '--disable-features=WebTransport',
        '--js-flags=--max-old-space-size=128',
      ],
      timeout: 20_000,
    };
  }
  protected override contextOptions(): BrowserContextOptions {
    return { acceptDownloads: false, serviceWorkers: 'block', permissions: [], viewport: { width: 1280, height: 800 } };
  }
  protected override async configureContext(context: BrowserContext, entryUrl: string) {
    const origin = publicHttpsUrl(entryUrl).origin;
    const primary = context.pages()[0]!;
    await context.routeWebSocket('**/*', (ws) => ws.close());
    await context.route('**/*', async (route) => {
      try {
        const request = route.request();
        const url = publicHttpsUrl(request.url());
        if (request.isNavigationRequest() && (url.origin !== origin || request.frame().page() !== primary))
          throw new Error('External navigation or popup blocked');
        await route.fallback(); // actual DNS/IP policy is enforced by CONNECT proxy for EVERY connection
      } catch {
        await route.abort('blockedbyclient').catch(() => undefined);
      }
    });
    // Playwright routes see the initial URL, not every HTTP redirect hop. Pause
    // document responses before Chrome follows Location, including iframe loads.
    const cdp = await context.newCDPSession(primary);
    await cdp.send('Fetch.enable', {
      patterns: [{ urlPattern: '*', resourceType: 'Document', requestStage: 'Response' }],
    });
    cdp.on('Fetch.requestPaused', (event) => {
      void (async () => {
        try {
          const location = event.responseHeaders?.find((header) => header.name.toLowerCase() === 'location')?.value;
          if (
            event.responseStatusCode &&
            event.responseStatusCode >= 300 &&
            event.responseStatusCode < 400 &&
            location
          ) {
            const destination = publicHttpsUrl(new URL(location, event.request.url).href);
            if (destination.origin !== origin) throw new Error('External redirect blocked');
          }
          await cdp.send('Fetch.continueResponse', { requestId: event.requestId });
        } catch {
          await cdp
            .send('Fetch.failRequest', { requestId: event.requestId, errorReason: 'BlockedByClient' })
            .catch(() => undefined);
        }
      })();
    });
    context.on('page', (page) => {
      if (page !== primary) void page.close().catch(() => undefined);
    });
    context.setDefaultNavigationTimeout(20_000);
  }
  override async open(options: OpenGameOptions) {
    if (this.disposed) throw new Error('MCP session closed. Reconnect to start again.');
    publicHttpsUrl(options.source);
    if (this.sessions.size + this.pending >= 2) throw new Error('Maximum 2 games per MCP session.');
    this.budget.acquire();
    this.pending++;
    try {
      const session = await super.open({ ...options, headless: true, seed: undefined, waitTimeoutMs: 15_000 });
      if (this.disposed) {
        await super.close(session.id);
        throw new Error('MCP session closed.');
      }
      this.touched.set(session.id, this.clock());
      return session;
    } catch (err) {
      this.budget.release();
      throw err;
    } finally {
      this.pending--;
    }
  }
  override get(id: string) {
    const s = super.get(id);
    this.touched.set(id, this.clock());
    return s;
  }
  override resolve(id?: string) {
    const s = super.resolve(id);
    this.touched.set(s.id, this.clock());
    return s;
  }
  override async choose(s: GameSession, choice: number | string, expected?: string) {
    return super.choose(s, choice, expected, false);
  }
  override async interact(s: GameSession, ref: string, value?: string) {
    const result = await super.interact(s, ref, value);
    if (result.ok) s.step++;
    return result;
  }
  override async press(s: GameSession, key: string, ref?: string) {
    const result = await super.press(s, key, ref);
    if (result.ok) s.step++;
    return result;
  }
  override async clickUi(s: GameSession, target: Parameters<SessionManager['clickUi']>[1]) {
    const result = await super.clickUi(s, target);
    if (result.ok) s.step++;
    return result;
  }
  override async screenshot(s: GameSession, outPath?: string) {
    if (outPath !== undefined) throw new Error('Remote screenshots cannot write files.');
    const data = await s.page.screenshot({ type: 'png', timeout: 10_000 });
    if (data.length > 5 * 1024 * 1024) throw new Error('Screenshot exceeds 5 MiB limit.');
    return data;
  }
  override async saveState(s: GameSession, name: string) {
    if (s.snapshots.size >= 8 && !s.snapshots.has(name)) throw new Error('Maximum 8 snapshots per game.');
    const result = await super.saveState(s, name);
    if (result.bytes && result.bytes > 1024 * 1024) {
      s.snapshots.delete(name);
      throw new Error('Snapshot exceeds 1 MiB limit.');
    }
    return result;
  }
  override async loadState(s: GameSession, name: string) {
    const result = await super.loadState(s, name);
    if (result.ok) s.step++;
    return result;
  }
  override async restart(s: GameSession) {
    const previous = s.step;
    const result = await super.restart(s);
    s.step = previous + 1;
    return result;
  }
  override async close(id: string) {
    const exists = this.sessions.has(id);
    if (!exists) return false;
    this.touched.delete(id);
    this.sessions.get(id)!.snapshots.clear();
    try {
      return await super.close(id);
    } finally {
      this.budget.release();
    }
  }
  async expireIdle(ttl = 30 * 60_000) {
    for (const [id, touched] of this.touched) if (this.clock() - touched >= ttl) await this.close(id);
  }
  override async closeAll() {
    this.disposed = true;
    await super.closeAll();
  }
}
