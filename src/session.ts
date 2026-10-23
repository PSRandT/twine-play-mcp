import { chromium, type Browser, type BrowserContext, type Download, type Frame, type Page, type LaunchOptions, type BrowserContextOptions } from 'playwright-core';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { serveGame, type GameServer } from './static-server.js';

export interface ChoiceInfo {
  ref: string;
  label: string;
  kind: string;
  target: string | null;
  href: string | null;
  disabled: boolean;
  external: boolean;
  dialog?: boolean;
}

export interface InputInfo {
  ref: string;
  kind: string;
  name: string | null;
  placeholder: string | null;
  value: string | null;
  options?: Array<{ value: string; label: string }>;
  disabled: boolean;
  label?: string;
  checked?: boolean;
  dialog?: boolean;
}

export interface UiButton {
  ref: string;
  label: string;
  kind: string;
}

export interface DialogInfo {
  title: string | null;
  text: string;
  buttonCount: number;
  buttons: Array<{ n: number; label: string; ref: string }>;
}

export interface Observation {
  ok: boolean;
  passage: string | null;
  format: string;
  formatVersion: string | null;
  story: Record<string, string | null>;
  url: string;
  title: string | null;
  text: string;
  choices: ChoiceInfo[];
  inputs: InputInfo[];
  inputsTotal?: number;
  inputsOffset?: number;
  ui: UiButton[];
  uiTotal?: number;
  dialog: DialogInfo | null;
  status: string | null;
  variables: unknown;
  engineState: string | null;
  hasPassageRoot: boolean;
  readyState: string;
}

export interface ConsoleEntry {
  type: string;
  text: string;
  location?: string;
  at: number;
}

export interface OpenGameOptions {
  source: string;
  headless?: boolean;
  seed?: string;
  chromePath?: string;
  viewport?: { width: number; height: number };
  waitTimeoutMs?: number;
  blockTrackers?: boolean;
}

/** Analytics / tracking hosts that many published games embed; blocked for quiet, private playtesting. */
const TRACKER_PATTERN =
  /(google-analytics\.com|googletagmanager\.com|doubleclick\.net|connect\.facebook\.net|hotjar\.com|mixpanel\.com|segment\.(io|com)|sentry\.io|cloudflareinsights\.com|newrelic\.com|matomo\.cloud|plausible\.io|statcounter\.com|yandex\.ru\/metrika)/i;

export interface JournalEntry {
  step: number;
  passage: string | null;
  action: string;
  target: string | null;
  at: number;
}

export interface DownloadRecord {
  id: number;
  download: Download;
  suggested: string;
  url: string;
  at: number;
  localPath: string | null;
  saved: string | null;
  promise: Promise<void> | null;
  /** Why persisting this download failed, if it did — surfaced instead of a generic error. */
  error: string | null;
}

export interface GameSession {
  id: string;
  source: string;
  entryUrl: string;
  server: GameServer | null;
  context: BrowserContext;
  page: Page;
  console: ConsoleEntry[];
  downloads: DownloadRecord[];
  lastObservation: Observation | null;
  snapshots: Map<string, { data: string; at: number }>;
  journal: JournalEntry[];
  step: number;
  seed: string | null;
}

interface BridgeResult {
  ok: boolean;
  error?: string;
  message?: string;
  [key: string]: unknown;
}

let bridgeSourceCache: string | null = null;

function bridgeSource(): string {
  if (bridgeSourceCache) return bridgeSourceCache;
  const candidates = [
    new URL('./bridge/bridge.js', import.meta.url),
    new URL('../src/bridge/bridge.js', import.meta.url),
    new URL('../bridge/bridge.js', import.meta.url)
  ];
  for (const url of candidates) {
    const p = url.pathname;
    if (fs.existsSync(p)) {
      bridgeSourceCache = fs.readFileSync(p, 'utf8');
      return bridgeSourceCache;
    }
  }
  throw new Error('bridge.js not found; the package is missing src/bridge/bridge.js');
}

/** Where a resolved download folder came from — surfaced so callers can explain a fallback. */
export interface DownloadsDir {
  dir: string;
  /** True when the preferred folder was unusable and a fallback was chosen. */
  fellBack: boolean;
  /** Why the preferred folder failed, when it did. */
  reason: string | null;
}

let downloadsDirCache: DownloadsDir | null = null;

/**
 * Folder where every browser download lands. Unlike Playwright's anonymous temp dir it survives
 * sessions and MCP restarts, so captured files can always be listed and exported.
 *
 * The preferred location is `TWMCP_DOWNLOAD_DIR`, else `~/.cache/twine-play-mcp/downloads`.
 * Caches and home directories are frequently read-only (containers, CI sandboxes, hardened
 * setups), so an unusable folder must not break downloads: we fall back down the list and
 * report which folder we actually got. The result is resolved once and reused.
 */
export function resolveDownloadsDir(): DownloadsDir {
  if (downloadsDirCache) return downloadsDirCache;
  const first = process.env.TWMCP_DOWNLOAD_DIR ?? path.join(os.homedir(), '.cache', 'twine-play-mcp', 'downloads');
  const candidates = [
    first,
    path.join(os.tmpdir(), 'twine-play-mcp', 'downloads'),
    path.join(process.cwd(), 'downloads')
  ];
  let reason: string | null = null;
  for (const dir of candidates) {
    try {
      fs.mkdirSync(dir, { recursive: true });
      const probe = path.join(dir, `.twmcp-write-probe-${process.pid}`);
      fs.writeFileSync(probe, '');
      fs.unlinkSync(probe);
    } catch (err) {
      reason = `${dir}: ${String((err as Error)?.message ?? err)}`;
      continue;
    }
    downloadsDirCache = { dir, fellBack: dir !== first, reason: dir === first ? null : reason };
    return downloadsDirCache;
  }
  // Nothing writable: keep the preferred path so error messages stay actionable.
  downloadsDirCache = { dir: first, fellBack: false, reason };
  return downloadsDirCache;
}

/** Path of the download folder (first call resolves and caches it). */
export function downloadsDir(): string {
  return resolveDownloadsDir().dir;
}

/** Test hook: forget the resolved folder so a new TWMCP_DOWNLOAD_DIR takes effect. */
export function resetDownloadsDirCache(): void {
  downloadsDirCache = null;
}

const isUrl = (s: string) => /^https?:\/\//i.test(s);

const normalizeLabel = (s: string) =>
  s
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();

export class SessionManager {
  private browser: Browser | null = null;
  private browserHeadless: boolean | null = null;
  private browserLaunch: Promise<Browser> | null = null;
  private chromePath: string | undefined;
  readonly sessions = new Map<string, GameSession>();

  constructor(chromePath?: string) {
    this.chromePath = chromePath ?? process.env.TWMCP_CHROME_PATH;
  }

  /** True when the shared browser is currently running with a visible window (open_game headless:false). */
  get browserIsHeaded(): boolean {
    return !!this.browser && this.browserHeadless === false;
  }

  protected launchOptions(): LaunchOptions { return {}; }
  protected contextOptions(): BrowserContextOptions { return {}; }
  protected async configureContext(_context: BrowserContext, _entryUrl: string): Promise<void> {}
  protected persistDownloads = true;
  protected newGameId(): string { return 'game_' + crypto.randomBytes(3).toString('hex'); }

  private async launchBrowser(headless: boolean): Promise<Browser> {
    const attempts: Array<Record<string, unknown>> = [];
    if (this.chromePath) attempts.push({ executablePath: this.chromePath, headless });
    attempts.push({ channel: 'chrome', headless });
    attempts.push({ executablePath: '/usr/bin/google-chrome-stable', headless });
    attempts.push({ executablePath: '/usr/bin/google-chrome', headless });

    const errors: string[] = [];
    for (const opts of attempts) {
      try {
        return await chromium.launch({ ...(opts as object), args: ['--no-first-run', '--no-default-browser-check'], ...this.launchOptions() });
      } catch (err) {
        errors.push(String((err as Error)?.message ?? err).split('\n')[0] ?? '');
      }
    }
    throw new Error(
      `Could not launch Chrome. Tried: ${errors.join(' | ')}. ` +
        `Install Google Chrome, set TWMCP_CHROME_PATH, or run: npx playwright install chromium`
    );
  }

  private async ensureBrowser(headless: boolean): Promise<Browser> {
    if (this.browser && this.browser.isConnected() && this.browserHeadless === headless) return this.browser;
    if (this.browser) {
      await this.browser.close().catch(() => undefined);
      this.browser = null;
    }
    if (!this.browserLaunch) {
      this.browserLaunch = this.launchBrowser(headless)
        .then((b) => {
          this.browser = b;
          this.browserHeadless = headless;
          this.browserLaunch = null;
          return b;
        })
        .catch((err) => {
          this.browserLaunch = null;
          throw err;
        });
    }
    return this.browserLaunch;
  }

  async open(opts: OpenGameOptions): Promise<GameSession> {
    const headless = opts.headless ?? true;
    const browser = await this.ensureBrowser(headless);

    const server = isUrl(opts.source) ? null : await serveGame(opts.source);
    const entryUrl = server ? server.entryUrl : opts.source;

    const context = await browser.newContext({
      viewport: opts.viewport ?? { width: 1280, height: 800 },
      locale: 'en-US',
      ...this.contextOptions()
    });
    try {
      const page = await context.newPage();
      page.setDefaultTimeout(5000);

      if (opts.blockTrackers ?? true) {
        await context.route('**/*', (route) => {
          const url = route.request().url();
          if (url.endsWith('/favicon.ico')) return route.fulfill({ status: 204, body: '' });
          if (TRACKER_PATTERN.test(url)) {
            return route.fulfill({ status: 200, contentType: 'application/javascript', body: '/* blocked by twine-play-mcp */' });
          }
          return route.continue();
        });
      }

      await this.configureContext(context, entryUrl);

      const id = this.newGameId();
      const session: GameSession = {
        id,
        source: opts.source,
        entryUrl,
        server,
        context,
        page,
        console: [],
        downloads: [],
        lastObservation: null,
        snapshots: new Map(),
        journal: [],
        step: 0,
        seed: opts.seed ?? null
      };
      this.attachConsole(session);
      if (this.persistDownloads) this.attachDownloads(session);

      await page.addInitScript({ content: bridgeSource() });
      await page.goto(entryUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
      await this.waitStable(session, opts.waitTimeoutMs ?? 20000);

      if (opts.seed) {
        const seeded = await this.bridge<BridgeResult>(session, 'seed', opts.seed);
        if (!seeded.ok) {
          session.console.push({ type: 'warning', text: `seed ignored: ${seeded.message ?? seeded.error}`, at: Date.now() });
        } else {
          await this.waitStable(session, opts.waitTimeoutMs ?? 20000);
        }
      }

      session.lastObservation = await this.observe(session);
      this.sessions.set(id, session);
      return session;
    } catch (err) {
      await context.close().catch(() => undefined);
      await server?.close();
      throw err;
    }
  }

  private attachConsole(session: GameSession): void {
    const push = (entry: ConsoleEntry) => {
      if (session.console.length > 300) session.console.shift();
      session.console.push(entry);
    };
    session.page.on('console', (msg) => {
      const type = msg.type();
      if (type !== 'error' && type !== 'warning') return;
      push({ type, text: msg.text().slice(0, 1200), location: msg.location()?.url, at: Date.now() });
    });
    session.page.on('pageerror', (err) => {
      push({ type: 'pageerror', text: String(err?.stack ?? err).slice(0, 2000), at: Date.now() });
    });
    session.page.on('response', (res) => {
      if (res.status() >= 400) push({ type: 'http', text: `${res.status()} ${res.url()}`, location: res.url(), at: Date.now() });
    });
  }

  get(id: string): GameSession {
    const session = this.sessions.get(id);
    if (!session) {
      const known = this.sessions.size ? [...this.sessions.keys()].join(', ') : '(none)';
      throw new Error(`Unknown game_id "${id}". Open games: ${known}`);
    }
    return session;
  }

  /**
   * Resolve the session a tool call applies to.
   *
   * `game_id` is optional everywhere because with a single open game it carries no information —
   * making the agent repeat it is pure friction, and forgetting it used to be a hard error. With
   * two or more games open the id is genuinely required, so we say so and list the candidates.
   */
  resolve(id?: string): GameSession {
    if (id) return this.get(id);
    if (this.sessions.size === 1) return [...this.sessions.values()][0]!;
    if (this.sessions.size === 0) throw new Error('No open games. Call open_game first.');
    const known = [...this.sessions.keys()].join(', ');
    throw new Error(`game_id is required with ${this.sessions.size} open games (${known}). Pass game_id, or close the others.`);
  }

  /** One line per open session, for the `session` tool and error messages. */
  listSessions(): Array<{ id: string; title: string; format: string; step: number; source: string }> {
    return [...this.sessions.values()].map((s) => ({
      id: s.id,
      title: s.lastObservation?.story?.title ?? s.lastObservation?.title ?? '(unknown)',
      format: s.lastObservation?.format ?? '?',
      step: s.step,
      source: s.source
    }));
  }

  async bridge<T = BridgeResult>(session: GameSession, fn: string, arg?: unknown): Promise<T> {
    const result = await session.page.evaluate(
      ([name, value]) => {
        const api = (window as unknown as { __twineMCP?: Record<string, (a?: unknown) => unknown> }).__twineMCP;
        if (!api || typeof api[name as string] !== 'function') {
          return { ok: false, error: 'bridge-missing', message: 'window.__twineMCP is not available on this page.' };
        }
        return api[name as string]!(value);
      },
      [fn, arg] as const
    );
    return result as T;
  }

  async waitStable(session: GameSession, timeoutMs = 15000): Promise<BridgeResult> {
    return this.bridge<BridgeResult>(session, 'waitStable', { timeout: timeoutMs });
  }

  async observe(
    session: GameSession,
    opts: {
      includeVariables?: boolean;
      includeStatus?: boolean;
      maxTextChars?: number;
      inputsOffset?: number;
      inputsLimit?: number;
    } = {}
  ): Promise<Observation> {
    const obs = await this.bridge<Observation & BridgeResult>(session, 'observe', {
      includeVariables: opts.includeVariables ?? true,
      includeStatus: opts.includeStatus ?? true,
      maxTextChars: opts.maxTextChars ?? 12000,
      inputsOffset: opts.inputsOffset ?? 0,
      inputsLimit: opts.inputsLimit ?? 40
    });
    // A failed bridge call returns `{ok:false, error:'bridge-missing'}` — not an observation.
    // Storing it would poison session.lastObservation (every later action reads it) and the
    // renderer would then trip over missing fields, so fail loudly and keep the last good state.
    if (!obs || obs.ok === false) {
      const detail = (obs as BridgeResult | undefined)?.message ?? (obs as BridgeResult | undefined)?.error ?? 'no result';
      throw new Error(`page bridge unavailable: ${detail}`);
    }
    session.lastObservation = obs;
    return obs;
  }

  async choose(
    session: GameSession,
    choice: number | string,
    expected?: string,
    allowExternal = false
  ): Promise<{ ok: boolean; error?: string; message?: string; observation?: Observation; clicked?: ChoiceInfo }> {
    const last = session.lastObservation;
    if (!last) return { ok: false, error: 'no-observation', message: 'Call observe first.' };

    let picked: ChoiceInfo | undefined;
    const choices = last.choices;
    if (typeof choice === 'number') {
      const idx = Math.trunc(choice);
      picked = idx >= 1 && idx <= choices.length ? choices[idx - 1] : undefined;
      if (!picked) {
        return { ok: false, error: 'bad-index', message: `Choice ${idx} is out of range 1..${choices.length}.`, observation: await this.observe(session) };
      }
      if (picked.disabled) {
        return { ok: false, error: 'choice-disabled', message: `Choice ${idx} ("${picked.label}") is disabled.`, observation: await this.observe(session) };
      }
    } else {
      const needle = normalizeLabel(choice);
      const visible = choices.filter((c) => !c.disabled);
      const exact = visible.filter((c) => normalizeLabel(c.label) === needle);
      const partial = exact.length ? exact : visible.filter((c) => normalizeLabel(c.label).includes(needle));
      if (partial.length === 0) {
        return {
          ok: false,
          error: 'no-such-choice',
          message: `No visible choice matches "${choice}".`,
          observation: await this.observe(session)
        };
      }
      if (partial.length > 1 && !exact.length) {
        return {
          ok: false,
          error: 'ambiguous-choice',
          message: `"${choice}" matches ${partial.length} choices; use a number or a longer label.`,
          observation: await this.observe(session)
        };
      }
      picked = partial[0];
    }

    if (!picked) return { ok: false, error: 'no-such-choice' };
    if (picked.external && !allowExternal) {
      return {
        ok: false,
        error: 'external-link-blocked',
        message: `"${picked.label}" leaves the game (${picked.href ?? 'external URL'}). Pass allow_external=true if you really want to follow it.`,
        observation: await this.observe(session)
      };
    }
    if (expected && !normalizeLabel(picked.label).includes(normalizeLabel(expected))) {
      return {
        ok: false,
        error: 'expectation-failed',
        message: `Choice ${picked.ref} is "${picked.label}", expected to contain "${expected}".`,
        observation: await this.observe(session)
      };
    }

    // Click with one automatic retry: dynamic passages can re-render between
    // observe and click, which invalidates the choice ref (common in timed games).
    let method: string | null = null;
    let retried = false;
    for (let attempt = 0; attempt < 2 && !method; attempt++) {
      try {
        await session.page.locator(`[data-twmcp-ref="${picked.ref}"]`).click({ timeout: 2000 });
        method = 'mouse';
        break;
      } catch {
        const res = await this.bridge<BridgeResult>(session, 'clickRef', picked.ref);
        if (res.ok) {
          method = 'js';
          break;
        }
      }
      if (attempt === 0) {
        const fresh = await this.observe(session);
        const needle = normalizeLabel(picked.label);
        const again =
          fresh.choices.find((c) => !c.disabled && normalizeLabel(c.label) === needle) ??
          fresh.choices.find((c) => !c.disabled && normalizeLabel(c.label).includes(needle));
        if (!again) {
          return {
            ok: false,
            error: 'stale-ref',
            message: `Choice "${picked.label}" disappeared before it could be clicked.`,
            observation: fresh
          };
        }
        picked = again;
        retried = true;
      }
    }
    if (!method) {
      return { ok: false, error: 'click-failed', message: `Could not click "${picked.label}".`, observation: await this.observe(session) };
    }

    await this.waitStable(session);
    session.step += 1;
    const observation = await this.observe(session);
    session.journal.push({
      step: session.step,
      passage: observation.passage,
      action: picked.label,
      target: picked.target,
      at: Date.now()
    });
    return { ok: true, clicked: { ...picked, kind: `${picked.kind}/${method}${retried ? '/retry' : ''}` }, observation };
  }

  async interact(
    session: GameSession,
    ref: string,
    value?: string
  ): Promise<{ ok: boolean; error?: string; message?: string; observation?: Observation }> {
    const selector = `[data-twmcp-ref="${ref}"]`;
    const locator = session.page.locator(selector);
    const count = await locator.count();
    if (count === 0) {
      return { ok: false, error: 'stale-ref', message: `Ref ${ref} is gone; call observe again.`, observation: await this.observe(session) };
    }
    const tag = await locator.first().evaluate((el) => el.tagName.toLowerCase()).catch(() => '');
    const inputType = await locator.first().getAttribute('type').catch(() => null);
    try {
      if (inputType === 'checkbox' || inputType === 'radio') {
        const desired = value === undefined ? true : /^(true|1|yes|on|check|checked)$/i.test(String(value).trim());
        if (desired) await locator.first().check({ timeout: 2000 });
        else await locator.first().uncheck({ timeout: 2000 });
      } else if (tag === 'select') {
        await locator.first().selectOption({ label: value ?? '' }).catch(async () => {
          await locator.first().selectOption(value ?? '');
        });
      } else if (tag === 'input' || tag === 'textarea') {
        await locator.first().fill(value ?? '');
      } else {
        await locator.first().click({ timeout: 2000 });
      }
    } catch {
      const res = await this.bridge<BridgeResult>(session, 'fillRef', { ref, value });
      if (!res.ok) return { ok: false, error: res.error ?? 'interact-failed', message: res.message, observation: await this.observe(session) };
    }
    await this.waitStable(session);
    const observation = await this.observe(session);
    return { ok: true, observation };
  }

  async press(session: GameSession, key: string, ref?: string): Promise<{ ok: boolean; observation?: Observation }> {
    if (ref) {
      const locator = session.page.locator(`[data-twmcp-ref="${ref}"]`);
      if (await locator.count()) await locator.first().focus().catch(() => undefined);
    }
    await session.page.keyboard.press(key);
    await this.waitStable(session);
    const observation = await this.observe(session);
    return { ok: true, observation };
  }

  /** Main frame first, then child frames (iframes). Everything that scans the DOM wants this order. */
  private framesOf(session: GameSession): Frame[] {
    const main = session.page.mainFrame();
    return [main, ...session.page.frames().filter((f) => f !== main)];
  }

  /** Resolve a target inside one frame using that frame's injected bridge (fast, value-aware). */
  private async resolveInFrame(
    frame: Frame,
    q: { selector?: string; text?: string; exact?: boolean; target?: string }
  ): Promise<{ ref: string; label?: string; matches?: number; alternatives?: string[] } | null> {
    try {
      const res = (await frame.evaluate((arg) => {
        const api = (window as unknown as { __twineMCP?: { resolveUi?: (o: unknown) => unknown } }).__twineMCP;
        if (!api || typeof api.resolveUi !== 'function') return { ok: false, error: 'bridge-missing' };
        return api.resolveUi(arg);
      }, q)) as { ok?: boolean; ref?: string; label?: string; matches?: number; alternatives?: string[] };
      if (res && res.ok && res.ref) return { ref: res.ref, label: res.label, matches: res.matches, alternatives: res.alternatives };
    } catch {
      /* frame may be detached or cross-origin */
    }
    return null;
  }

  /** Resolve a target by CSS selector or visible text across the main frame and all child frames. */
  private async resolveAcrossFrames(
    session: GameSession,
    q: { selector?: string; text?: string; exact?: boolean; target?: string }
  ): Promise<{ frame: Frame; ref: string; label: string; matches: number; alternatives?: string[] } | null> {
    for (const frame of this.framesOf(session)) {
      const hit = await this.resolveInFrame(frame, q);
      if (hit) {
        return { frame, ref: hit.ref, label: hit.label ?? '', matches: hit.matches ?? 1, alternatives: hit.alternatives };
      }
    }
    return null;
  }

  /** Click a data-twmcp-ref element with Playwright, falling back to a DOM click. */
  private async clickRefWithFallback(session: GameSession, ref: string): Promise<{ ok: boolean; method: string; message?: string }> {
    try {
      await session.page.locator(`[data-twmcp-ref="${ref}"]`).click({ timeout: 2500 });
      return { ok: true, method: 'mouse' };
    } catch {
      const res = await this.bridge<BridgeResult>(session, 'clickRef', ref);
      if (!res.ok) return { ok: false, method: 'js', message: res.message ?? res.error };
      return { ok: true, method: 'js' };
    }
  }

  /** Click UI outside the passage (dialogs, sidebar, menus, iframes) by ref, CSS selector or visible text. */
  async clickUi(
    session: GameSession,
    target: { ref?: string; selector?: string; text?: string; exact?: boolean; target?: string }
  ): Promise<{ ok: boolean; error?: string; message?: string; label?: string; matches?: number; alternatives?: string[]; observation?: Observation }> {
    // Fast path: JS-side resolution in the main frame. Essential on huge pages where
    // Playwright's text engine is slow (100k+ DOM nodes).
    const viaBridge = await this.bridge<BridgeResult & { ref?: string; label?: string; matches?: number; alternatives?: string[] }>(
      session,
      'resolveUi',
      target
    );
    if (viaBridge.ok && viaBridge.ref) {
      const clicked = await this.clickRefWithFallback(session, viaBridge.ref);
      await this.waitStable(session);
      if (!clicked.ok) {
        return { ok: false, error: 'click-failed', message: clicked.message, observation: await this.observe(session) };
      }
      return {
        ok: true,
        label: viaBridge.label ? `${viaBridge.label} [${clicked.method}]` : clicked.method,
        matches: viaBridge.matches,
        alternatives: viaBridge.alternatives,
        observation: await this.observe(session)
      };
    }

    // Fallback: resolve inside child frames via their own injected bridge.
    const hit = await this.resolveAcrossFrames(session, target);
    if (!hit) {
      return { ok: false, error: viaBridge.error ?? 'no-match', message: viaBridge.message ?? 'No element matched in any frame.', observation: await this.observe(session) };
    }
    const clicked = await this.clickRefInFrame(hit.frame, hit.ref);
    if (!clicked.ok) {
      return { ok: false, error: 'click-failed', message: clicked.message, observation: await this.observe(session) };
    }
    await this.waitStable(session);
    const frameNote = hit.frame === session.page.mainFrame() ? '' : ' [iframe]';
    return { ok: true, label: `${hit.label}${frameNote} [${clicked.method}]`, matches: hit.matches, alternatives: hit.alternatives, observation: await this.observe(session) };
  }

  /** Click a data-twmcp-ref inside a specific frame (Playwright first, DOM click fallback). */
  private async clickRefInFrame(frame: Frame, ref: string): Promise<{ ok: boolean; method: string; message?: string }> {
    try {
      await frame.locator(`[data-twmcp-ref="${ref}"]`).click({ timeout: 2500 });
      return { ok: true, method: 'mouse' };
    } catch {
      try {
        const res = (await frame.evaluate((r) => {
          const api = (window as unknown as { __twineMCP?: { clickRef?: (x: string) => unknown } }).__twineMCP;
          if (!api || typeof api.clickRef !== 'function') return { ok: false, message: 'bridge-missing' };
          return api.clickRef(r);
        }, ref)) as { ok?: boolean; message?: string };
        if (res && res.ok) return { ok: true, method: 'js' };
        return { ok: false, method: 'js', message: res?.message };
      } catch (err) {
        return { ok: false, method: 'none', message: String((err as Error)?.message ?? err) };
      }
    }
  }

  /** Upload a local file into an <input type=file> (mods, save imports, …), optionally via a trigger button. */
  async uploadFile(
    session: GameSession,
    opts: { path: string; ref?: string; selector?: string; trigger?: string; triggerRef?: string; triggerText?: string; triggerSelector?: string }
  ): Promise<{ ok: boolean; error?: string; message?: string; observation?: Observation }> {
    const filePath = path.resolve(opts.path);
    if (!fs.existsSync(filePath)) return { ok: false, error: 'file-not-found', message: filePath };

    if (opts.trigger || opts.triggerRef || opts.triggerText || opts.triggerSelector) {
      const chooserPromise = session.page.waitForEvent('filechooser', { timeout: 4000 }).catch(() => null);
      const clicked = await this.clickUi(session, {
        ref: opts.triggerRef,
        text: opts.triggerText,
        selector: opts.triggerSelector,
        target: opts.trigger
      });
      if (!clicked.ok) return { ok: false, error: clicked.error, message: clicked.message, observation: clicked.observation };
      const chooser = await chooserPromise;
      if (chooser) {
        await chooser.setFiles(filePath);
        await this.waitStable(session);
        return { ok: true, observation: await this.observe(session) };
      }
      // No native picker appeared — the click likely revealed a hidden <input type=file>; fall through.
    }

    const selector = opts.ref ? `[data-twmcp-ref="${opts.ref}"]` : opts.selector ?? 'input[type="file"]';
    let lastErr = '';
    for (const frame of this.framesOf(session)) {
      const locators = frame.locator(selector);
      const count = await locators.count().catch(() => 0);
      if (!count) continue;
      let target = -1;
      for (let i = count - 1; i >= 0; i--) {
        if (await locators.nth(i).isVisible().catch(() => false)) {
          target = i;
          break;
        }
      }
      if (target < 0) target = count - 1;
      try {
        await locators.nth(target).setInputFiles(filePath);
        await this.waitStable(session);
        return { ok: true, observation: await this.observe(session) };
      } catch (err) {
        lastErr = String((err as Error)?.message ?? err);
      }
    }
    return { ok: false, error: 'no-file-input', message: lastErr || `No file input matched ${selector}` };
  }

  /**
   * Every browser download is persisted into the tool's download folder (downloadsDir) as it
   * arrives, so files keep their real names and survive closing the game and MCP restarts.
   */
  private attachDownloads(session: GameSession): void {
    session.page.on('download', (download) => {
      const rec = this.trackDownload(session, download);
      if (!rec.promise) rec.promise = this.beginPersist(rec);
    });
  }

  /** Kick off persistence, recording the reason on failure instead of swallowing it. */
  private beginPersist(rec: DownloadRecord): Promise<void> {
    return this.persistDownload(rec).catch((err: unknown) => {
      rec.error = String((err as Error)?.message ?? err);
    });
  }

  private trackDownload(session: GameSession, download: Download): DownloadRecord {
    const rec: DownloadRecord = {
      id: session.downloads.length + 1,
      download,
      suggested: download.suggestedFilename() || `download-${session.downloads.length + 1}.bin`,
      url: download.url(),
      at: Date.now(),
      localPath: null,
      saved: null,
      promise: null,
      error: null
    };
    session.downloads.push(rec);
    if (session.downloads.length > 50) session.downloads.shift();
    return rec;
  }

  /** Save a captured download into the shared download folder (same-named files are overwritten). */
  private async persistDownload(rec: DownloadRecord): Promise<void> {
    const safe = (rec.suggested || `download-${rec.id}.bin`).replace(/[/\\]/g, '_').trim() || `download-${rec.id}.bin`;
    const dest = path.join(downloadsDir(), safe);
    await rec.download.saveAs(dest);
    rec.localPath = dest;
  }

  /** List files captured in the download folder (newest first). Works across sessions and MCP restarts. */
  async listDownloads(limit = 20): Promise<{
    ok: boolean;
    dir: string;
    fellBack: boolean;
    fallbackReason: string | null;
    total: number;
    files: Array<{ name: string; path: string; bytes: number; mtime: number }>;
  }> {
    const resolved = resolveDownloadsDir();
    const dir = resolved.dir;
    let names: string[] = [];
    try {
      names = fs.readdirSync(dir);
    } catch {
      names = [];
    }
    const files: Array<{ name: string; path: string; bytes: number; mtime: number }> = [];
    for (const name of names) {
      const p = path.join(dir, name);
      try {
        const st = fs.statSync(p);
        if (st.isFile()) files.push({ name, path: p, bytes: st.size, mtime: st.mtimeMs });
      } catch {
        /* skip unreadable entries */
      }
    }
    files.sort((a, b) => b.mtime - a.mtime);
    const capped = Math.max(1, Math.min(limit, 200));
    return {
      ok: true,
      dir,
      fellBack: resolved.fellBack,
      fallbackReason: resolved.reason,
      total: files.length,
      files: files.slice(0, capped)
    };
  }

  /**
   * Where a copy should land.
   *
   * `destIsDir` comes from the caller's choice of parameter (`dest_dir` vs `dest_file`), because a
   * destination that does not exist yet cannot be told apart from a file name by inspection alone.
   */
  private resolveDownloadPath(target: string | undefined, suggested: string, destIsDir = false): string {
    const safeName = (suggested || 'download.bin').replace(/[/\\]/g, '_').trim() || 'download.bin';
    if (!target) return path.resolve(process.cwd(), 'downloads', safeName);
    const abs = path.resolve(target);
    const looksLikeDir = destIsDir || /[/\\]$/.test(target) || (fs.existsSync(abs) && fs.statSync(abs).isDirectory());
    return looksLikeDir ? path.join(abs, safeName) : abs;
  }

  /**
   * Browser file control (any game). Either:
   *  - click a download button (triggerRef/triggerText/triggerSelector) and take its file, or
   *  - pick an already-captured file by `name` or 1-based `index` (newest first, from listDownloads), or
   *  - with none of those, take the newest file in the download folder.
   * Every captured file stays in the download folder; pass `path` to also copy it somewhere else.
   */
  async downloadFile(
    session: GameSession,
    opts: {
      path?: string;
      destIsDir?: boolean;
      ref?: string;
      text?: string;
      selector?: string;
      target?: string;
      name?: string;
      index?: number;
      timeoutMs?: number;
    } = {}
  ): Promise<{
    ok: boolean;
    error?: string;
    message?: string;
    path?: string;
    source?: string;
    filename?: string;
    bytes?: number;
    copied?: boolean;
    overwrote?: boolean;
    observation?: Observation;
  }> {
    const timeout = Math.max(1000, Math.min(opts.timeoutMs ?? 30000, 120000));
    let sourcePath: string | null = null;
    let filename = '';

    if (opts.ref || opts.text || opts.selector || opts.target) {
      const dlPromise = session.page.waitForEvent('download', { timeout });
      dlPromise.catch(() => undefined); // avoid an unhandled rejection when the click fails
      const clicked = await this.clickUi(session, { ref: opts.ref, text: opts.text, selector: opts.selector, target: opts.target });
      if (!clicked.ok) {
        return { ok: false, error: clicked.error ?? 'click-failed', message: clicked.message, observation: clicked.observation };
      }
      let dl: Download;
      try {
        dl = await dlPromise;
      } catch {
        return {
          ok: false,
          error: 'no-download',
          message:
            `Clicked "${clicked.label ?? 'trigger'}" but no download started within ${timeout}ms. ` +
            'If that button only opens a sub-dialog, click the actual file button in this call.'
        };
      }
      let rec = session.downloads.find((r) => r.download === dl);
      if (!rec) rec = this.trackDownload(session, dl);
      if (!rec.promise) rec.promise = this.beginPersist(rec);
      await rec.promise;
      sourcePath = rec.localPath;
      if (!sourcePath || !fs.existsSync(sourcePath)) {
        return {
          ok: false,
          error: 'download-incomplete',
          message:
            `Download "${rec.suggested}" could not be stored in the download folder` +
            (rec.error ? `: ${rec.error}` : '.')
        };
      }
      filename = rec.suggested || path.basename(sourcePath);
    } else if (opts.name || opts.index != null) {
      const listed = await this.listDownloads(200);
      let hit: { name: string; path: string; bytes: number; mtime: number } | undefined;
      if (opts.name) {
        const needle = opts.name.toLowerCase();
        hit =
          listed.files.find((f) => f.name.toLowerCase() === needle) ??
          listed.files.find((f) => f.name.toLowerCase().endsWith(needle)) ??
          (listed.files.filter((f) => f.name.toLowerCase().includes(needle)).length === 1
            ? listed.files.find((f) => f.name.toLowerCase().includes(needle))
            : undefined);
        if (!hit) {
          return {
            ok: false,
            error: 'no-download',
            message: `No file in the download folder matches "${opts.name}". Use download_file(action:"list") to see the ${listed.total} captured file(s).`
          };
        }
      } else {
        hit = listed.files[(opts.index ?? 1) - 1];
        if (!hit) {
          return { ok: false, error: 'no-download', message: `Index ${opts.index} is out of range 1..${listed.files.length}.` };
        }
      }
      sourcePath = hit.path;
      filename = hit.name;
    } else {
      const listed = await this.listDownloads(200);
      const newest = listed.files[0];
      if (!newest) {
        return {
          ok: false,
          error: 'no-download',
          message:
            `The download folder is empty (${listed.dir}). Pass trigger to click the download button, ` +
            'or trigger a download first and call download_file again.'
        };
      }
      sourcePath = newest.path;
      filename = newest.name;
    }

    let dest = sourcePath;
    let overwrote = false;
    let copied = false;
    try {
      if (opts.path) {
        dest = this.resolveDownloadPath(opts.path, filename, opts.destIsDir ?? false);
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        overwrote = fs.existsSync(dest);
        if (path.resolve(dest) !== path.resolve(sourcePath)) {
          fs.copyFileSync(sourcePath, dest);
          copied = true;
        }
      }
      const bytes = fs.statSync(dest).size;
      session.journal.push({
        step: session.step,
        passage: session.lastObservation?.passage ?? null,
        action: `(download:${path.basename(dest)})`,
        target: dest,
        at: Date.now()
      });
      return { ok: true, path: dest, source: sourcePath, filename, bytes, copied, overwrote, observation: await this.observe(session) };
    } catch (err) {
      return { ok: false, error: 'save-failed', message: String((err as Error)?.message ?? err) };
    }
  }

  /** Find visible controls (buttons, links, labels, inputs) by text/name; refs work with click_ui/interact. */
  async findUi(
    session: GameSession,
    opts: { text?: string; exact?: boolean; kind?: string; name?: string; limit?: number }
  ): Promise<{
    ok: boolean;
    error?: string;
    message?: string;
    matches?: Array<{ ref: string; kind: string; label: string; tag: string; name?: string; checked?: boolean; disabled?: boolean; value?: string }>;
    total?: number;
    truncated?: boolean;
  }> {
    return this.bridge(session, 'findUi', opts);
  }

  /** Read selected story variables by dot path (e.g. ["haircolour", "V.background"]). No paths = top-level key summary. */
  async getVariables(
    session: GameSession,
    paths?: string[]
  ): Promise<{
    ok: boolean;
    error?: string;
    message?: string;
    mode?: string;
    values?: Record<string, unknown>;
    missing?: string[];
    keys?: string[];
    summary?: Record<string, unknown>;
    totalKeys?: number;
  }> {
    return this.bridge(session, 'getVariables', { paths: paths ?? [] });
  }

  /** Inspect an arbitrary UI subtree (mod GUI, backstage panel) or discover overlay panels. */
  async inspectUi(
    session: GameSession,
    selector?: string
  ): Promise<{
    ok: boolean;
    error?: string;
    message?: string;
    selector?: string;
    text?: string;
    frame?: boolean;
    buttons?: Array<{ ref: string; label: string; kind: string }>;
    inputs?: InputInfo[];
    candidates?: unknown[];
  }> {
    const res = await this.bridge<BridgeResult & {
      selector?: string;
      text?: string;
      buttons?: Array<{ ref: string; label: string; kind: string }>;
      inputs?: InputInfo[];
      candidates?: unknown[];
    }>(session, 'inspectUi', { selector });

    const childFrames = session.page.frames().filter((f) => f !== session.page.mainFrame());

    if (!selector) {
      const frameCandidates: Array<Record<string, unknown>> = [];
      for (const frame of childFrames) {
        try {
          const info = (await frame.evaluate(`(() => ({
            files: document.querySelectorAll('input[type=file]').length,
            buttons: Array.from(document.querySelectorAll('button, a, [role=button]')).filter((e) => {
              const r = e.getBoundingClientRect();
              const s = getComputedStyle(e);
              return r.width > 1 && r.height > 1 && s.display !== 'none' && s.visibility !== 'hidden';
            }).length,
            text: (() => {
              const base = ((document.body && document.body.innerText) || '').replace(/\\s+/g, ' ');
              const values = Array.from(document.querySelectorAll('textarea, input')).map((v) => v.value).filter((v) => v && v.length < 500).join(' | ');
              return (values ? '⟦values: ' + values + '⟧ ' + base : base).slice(0, 400);
            })()
          }))()`)) as { files: number; buttons: number; text: string };
          if (info.files || info.buttons) {
            frameCandidates.push({
              selector: `iframe(${frame.url().slice(0, 60) || 'about:blank'})`,
              frame: true,
              fileInputs: info.files,
              buttons: info.buttons,
              inputs: 0,
              area: 0,
              text: info.text
            });
          }
        } catch {
          /* frame may be gone */
        }
      }
      frameCandidates.sort((a, b) => Number(b.fileInputs) - Number(a.fileInputs) || Number(b.buttons) - Number(a.buttons));
      const base = res.ok ? (res.candidates ?? []) : [];
      return { ok: true, candidates: [...frameCandidates, ...base] };
    }

    if (res.ok) return res;

    // Selector not found in the main frame by the bridge: try the bridge inside each child frame.
    for (const frame of childFrames) {
      try {
        const frameRes = (await frame.evaluate((sel) => {
          const api = (window as unknown as { __twineMCP?: { inspectUi?: (o: unknown) => unknown } }).__twineMCP;
          if (!api || typeof api.inspectUi !== 'function') return { ok: false, error: 'bridge-missing' };
          return api.inspectUi({ selector: sel });
        }, selector)) as { ok?: boolean; text?: string; buttons?: Array<{ ref: string; label: string; kind: string }>; inputs?: InputInfo[] };
        if (frameRes && frameRes.ok) {
          return { ok: true, selector, text: frameRes.text, buttons: frameRes.buttons, inputs: frameRes.inputs, frame: true };
        }
      } catch {
        /* ignore */
      }
    }
    return res;
  }

  async wait(
    session: GameSession,
    opts: { ms?: number; forText?: string; timeoutMs?: number }
  ): Promise<{ ok: boolean; waitedMs: number; matched?: boolean; observation?: Observation }> {
    const timeout = Math.min(opts.timeoutMs ?? 15000, 120000);
    const t0 = Date.now();
    if (opts.forText) {
      try {
        await session.page.waitForFunction(
          (needle) => (document.body?.innerText ?? '').includes(needle as string),
          opts.forText,
          { timeout }
        );
      } catch {
        return { ok: true, waitedMs: Date.now() - t0, matched: false, observation: await this.observe(session) };
      }
      await this.waitStable(session);
      return { ok: true, waitedMs: Date.now() - t0, matched: true, observation: await this.observe(session) };
    }
    if (opts.ms) await new Promise((r) => setTimeout(r, Math.min(opts.ms!, timeout)));
    await this.waitStable(session);
    return { ok: true, waitedMs: Date.now() - t0, observation: await this.observe(session) };
  }

  async screenshot(session: GameSession, outPath?: string): Promise<Buffer> {
    const buf = await session.page.screenshot({ type: 'png' });
    if (outPath) {
      const abs = path.resolve(outPath);
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, buf);
    }
    return buf;
  }

  async back(session: GameSession): Promise<{ ok: boolean; observation?: Observation; error?: string; message?: string }> {
    const res = await this.bridge<BridgeResult>(session, 'back');
    if (!res.ok) return { ok: false, error: res.error, message: res.message };
    await this.waitStable(session);
    session.step += 1;
    const observation = await this.observe(session);
    session.journal.push({ step: session.step, passage: observation.passage, action: '(back)', target: null, at: Date.now() });
    return { ok: true, observation };
  }

  async restart(session: GameSession, seed?: string): Promise<{ ok: boolean; observation?: Observation; seeded?: boolean }> {
    if (seed) {
      const seeded = await this.bridge<BridgeResult>(session, 'seed', seed);
      if (seeded.ok) session.seed = seed;
    } else {
      await this.bridge<BridgeResult>(session, 'restart');
    }
    await this.waitStable(session, 20000);
    session.step = 0;
    session.journal.push({ step: 0, passage: null, action: seed ? `(restart seed=${seed})` : '(restart)', target: null, at: Date.now() });
    return { ok: true, observation: await this.observe(session), seeded: !!seed };
  }

  /** List the in-session snapshots, newest first. */
  listSnapshots(session: GameSession): Array<{ name: string; bytes: number; at: number }> {
    return [...session.snapshots.entries()]
      .map(([name, snap]) => ({ name, bytes: snap.data.length, at: snap.at }))
      .sort((a, b) => b.at - a.at);
  }

  /**
   * Jump straight to a passage by name (SugarCube `Engine.play`, Snowman `story.show/go`,
   * Harlowe `Engine.goTo`). Intended for QA: reaching a specific passage without replaying
   * the path that leads there.
   */
  async goTo(session: GameSession, passage: string): Promise<{ ok: boolean; observation?: Observation; error?: string; message?: string }> {
    const res = await this.bridge<BridgeResult>(session, 'goTo', passage);
    if (!res.ok) return { ok: false, error: res.error ?? 'goto-failed', message: res.message };
    await this.waitStable(session);
    session.step += 1;
    const observation = await this.observe(session);
    session.journal.push({ step: session.step, passage: observation.passage, action: `(goto:${passage})`, target: passage, at: Date.now() });
    return { ok: true, observation };
  }

  async saveState(session: GameSession, name: string): Promise<{ ok: boolean; error?: string; message?: string; bytes?: number }> {
    const res = await this.bridge<BridgeResult & { data?: string }>(session, 'snapshot');
    if (!res.ok || typeof res.data !== 'string') return { ok: false, error: res.error, message: res.message };
    session.snapshots.set(name, { data: res.data, at: Date.now() });
    return { ok: true, bytes: res.data.length };
  }

  async loadState(session: GameSession, name: string): Promise<{ ok: boolean; error?: string; message?: string; observation?: Observation }> {
    const snap = session.snapshots.get(name);
    if (!snap) {
      const names = [...session.snapshots.keys()].join(', ') || '(none)';
      return { ok: false, error: 'no-snapshot', message: `No snapshot named "${name}". Available: ${names}` };
    }
    const res = await this.bridge<BridgeResult>(session, 'restore', snap.data);
    if (!res.ok) return { ok: false, error: res.error, message: res.message };
    await this.waitStable(session);
    const observation = await this.observe(session);
    session.journal.push({ step: session.step, passage: observation.passage, action: `(load:${name})`, target: null, at: Date.now() });
    return { ok: true, observation };
  }

  async close(id: string): Promise<boolean> {
    const session = this.sessions.get(id);
    if (!session) return false;
    this.sessions.delete(id);
    await session.context.close().catch(() => undefined);
    await session.server?.close();
    return true;
  }

  async closeAll(): Promise<void> {
    if (this.browserLaunch) await this.browserLaunch.catch(() => undefined);
    for (const id of [...this.sessions.keys()]) await this.close(id);
    if (this.browser) {
      await this.browser.close().catch(() => undefined);
      this.browser = null;
    }
  }
}
