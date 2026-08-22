import * as http from 'http';
import * as crypto from 'crypto';

// ============================================================
// DASHBOARD — read-only account view + a two-way message box
//
// Deliberately narrow: this process can show state and accept a text message
// for the model to read next cycle. It cannot place an order, change a stop,
// or touch config. The trading loop is the only thing that trades; this is a
// window onto it, not a second control surface.
// ============================================================

export interface DashboardPosition {
  pair: string;
  entryPrice: number;
  currentPrice: number;
  qty: number;
  costBasisUsd: number;
  stopLoss: number;
  takeProfit: number;
  alertPrice: number | null;
  origin: 'bot' | 'operator';
  sector: string;
  openedAt: string;
}

export interface DashboardClosedTrade {
  pair: string;
  sector: string;
  pnlUsd: number;
  pnlPct: number;
  closedAt: string;
  closeReason: string;
  holdDays: number;
}

export interface DashboardChatMessage {
  id: string;
  from: 'operator' | 'ai';
  text: string;
  at: string;
  kind?: string;
}

export interface DashboardAccount {
  totalUsd: number;
  cashUsd: number;
  tradableUsd: number;
  stakedUsd: number;
  asOf: string;
}

export interface DashboardStance {
  stance: string;
  confidence: number;
  reasoning: string;
  counterCase: string;
  cashTargetPct: number;
  recordedAt?: string;
}

export interface DashboardFundingRequest {
  usd: number;
  reasoning: string;
  requestedAt: string;
}

export interface DashboardEquityPoint {
  at: string;
  totalUsd: number;
}

export interface DashboardSnapshot {
  mode: 'paper' | 'live';
  generatedAt: string;
  account: DashboardAccount | null;
  positions: DashboardPosition[];
  closedTrades: DashboardClosedTrade[];
  totalPnl: number;
  wins: number;
  losses: number;
  winRatePct: number;
  cycleCount: number;
  lastScan: string;
  stance: DashboardStance | null;
  fundingRequest: DashboardFundingRequest | null;
  chat: DashboardChatMessage[];
  model: string;
  usage: { calls: number; promptTokens: number; completionTokens: number };
  /** Recent total-account-value points, oldest first, for the equity chart. */
  equityHistory: DashboardEquityPoint[];
  /** Largest peak-to-trough decline across the full recorded history, as a fraction. */
  maxDrawdownPct: number;
  /** True while the kill switch has paused new entries. */
  tradingPaused: boolean;
  /** Why trading is paused, shown next to the resume control. */
  pauseReason: string;
}

export interface DashboardOptions {
  port: number;
  username: string;
  password: string;
  getSnapshot: () => DashboardSnapshot;
  /** The full trade ledger as CSV text, for the /export/trades.csv route. */
  getTradesCsv: () => string;
  onOperatorMessage: (text: string) => void;
  /** Sells everything and pauses new entries until onResume is called. */
  onKillSwitch: (reason: string) => void;
  /** Clears the pause set by the kill switch (or by any other pause). */
  onResume: () => void;
  /** Failed logins from one address before it is locked out (default 8). */
  maxLoginAttempts?: number;
  /** How long a lockout lasts, in minutes (default 15). */
  lockoutMinutes?: number;
}

const MAX_BODY_BYTES = 10_000;
/** Bound on tracked addresses, so a flood of forged source IPs can't grow this forever. */
const MAX_TRACKED_ADDRESSES = 500;

function escapeHtml(value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function fmtUsd(n: number): string {
  if (!Number.isFinite(n)) return '$n/a';
  const abs = Math.abs(n);
  return abs >= 1 ? `$${n.toFixed(2)}` : `$${n.toFixed(6)}`;
}

function fmtPct(n: number): string {
  return `${n >= 0 ? '+' : ''}${n.toFixed(1)}%`;
}

/** True when the provided credentials match, compared without leaking timing. */
function credentialsMatch(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) {
    // Still run a comparison of equal length so a length mismatch does not
    // itself leak timing information beyond "wrong length".
    crypto.timingSafeEqual(bufA, bufA);
    return false;
  }
  return crypto.timingSafeEqual(bufA, bufB);
}

function checkAuth(req: http.IncomingMessage, username: string, password: string): boolean {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Basic ')) return false;
  let decoded: string;
  try {
    decoded = Buffer.from(header.slice(6), 'base64').toString('utf8');
  } catch {
    return false;
  }
  const separator = decoded.indexOf(':');
  if (separator < 0) return false;
  const user = decoded.slice(0, separator);
  const pass = decoded.slice(separator + 1);
  return credentialsMatch(user, username) && credentialsMatch(pass, password);
}

function requireAuth(res: http.ServerResponse) {
  res.writeHead(401, {
    'WWW-Authenticate': 'Basic realm="dashboard"',
    'Content-Type': 'text/plain',
  });
  res.end('Authentication required.');
}

/** Railway terminates TLS in front of this process, so the real client sits behind
 * X-Forwarded-For; fall back to the socket address for a direct connection (e.g. tests). */
function clientAddress(req: http.IncomingMessage): string {
  const forwarded = req.headers['x-forwarded-for'];
  const first = Array.isArray(forwarded) ? forwarded[0] : forwarded;
  const ip = first?.split(',')[0]?.trim();
  return ip || req.socket.remoteAddress || 'unknown';
}

/**
 * Locks an address out after too many failed logins, so a live-money dashboard
 * isn't just as strong as its password against a script trying every guess.
 * In-memory and per-process by design: a redeploy is a fresh slate, which is
 * an acceptable trade for not needing a datastore over this.
 */
class LoginThrottle {
  private readonly attempts = new Map<string, { failures: number; lockedUntil: number }>();
  constructor(private readonly maxAttempts: number, private readonly lockoutMs: number) {}

  /** Seconds remaining before this address may try again, or 0 if it is not locked out. */
  lockedForSeconds(address: string): number {
    const entry = this.attempts.get(address);
    if (!entry || entry.lockedUntil <= Date.now()) return 0;
    return Math.ceil((entry.lockedUntil - Date.now()) / 1000);
  }

  recordFailure(address: string) {
    const entry = this.attempts.get(address) ?? { failures: 0, lockedUntil: 0 };
    entry.failures++;
    if (entry.failures >= this.maxAttempts) entry.lockedUntil = Date.now() + this.lockoutMs;
    this.attempts.set(address, entry);
    if (this.attempts.size > MAX_TRACKED_ADDRESSES) {
      const oldest = this.attempts.keys().next().value;
      if (oldest !== undefined) this.attempts.delete(oldest);
    }
  }

  recordSuccess(address: string) {
    this.attempts.delete(address);
  }
}

function renderPositions(positions: DashboardPosition[]): string {
  if (positions.length === 0) return '<p class="muted">No open positions.</p>';
  const rows = positions.map(p => {
    const pnl = (p.currentPrice - p.entryPrice) * p.qty;
    const pnlPct = p.costBasisUsd > 0 ? (pnl / p.costBasisUsd) * 100 : 0;
    const badge = p.origin === 'operator' ? '<span class="badge badge-operator">yours</span>' : '<span class="badge badge-bot">bot</span>';
    return `<tr>
      <td>${escapeHtml(p.pair)} ${badge}</td>
      <td>${escapeHtml(p.sector)}</td>
      <td>${fmtUsd(p.entryPrice)}</td>
      <td>${fmtUsd(p.currentPrice)}</td>
      <td class="${pnl >= 0 ? 'pos' : 'neg'}">${fmtUsd(pnl)} (${fmtPct(pnlPct)})</td>
      <td>${fmtUsd(p.stopLoss)}</td>
      <td>${fmtUsd(p.takeProfit)}</td>
      <td>${p.alertPrice === null ? '—' : fmtUsd(p.alertPrice)}</td>
    </tr>`;
  }).join('');
  return `<table>
    <thead><tr><th>Pair</th><th>Sector</th><th>Entry</th><th>Now</th><th>P/L</th><th>Stop</th><th>Target</th><th>Alert</th></tr></thead>
    <tbody>${rows}</tbody>
  </table>`;
}

function renderClosedTrades(trades: DashboardClosedTrade[]): string {
  if (trades.length === 0) return '<p class="muted">No closed trades yet.</p>';
  const rows = [...trades].reverse().slice(0, 20).map(t => `<tr>
    <td>${escapeHtml(t.pair)}</td>
    <td class="${t.pnlUsd >= 0 ? 'pos' : 'neg'}">${fmtUsd(t.pnlUsd)} (${fmtPct(t.pnlPct)})</td>
    <td>${t.holdDays.toFixed(1)}d</td>
    <td>${escapeHtml(t.closeReason)}</td>
    <td>${escapeHtml(t.closedAt.slice(0, 16).replace('T', ' '))}</td>
  </tr>`).join('');
  return `<table>
    <thead><tr><th>Pair</th><th>P/L</th><th>Held</th><th>Reason</th><th>Closed</th></tr></thead>
    <tbody>${rows}</tbody>
  </table>`;
}

function renderChat(chat: DashboardChatMessage[]): string {
  if (chat.length === 0) return '<p class="muted">No messages yet.</p>';
  return chat.map(m => {
    const who = m.from === 'operator' ? 'You' : 'GLM';
    const kindTag = m.kind && m.kind !== 'reply' ? ` <span class="badge badge-kind">${escapeHtml(m.kind.replace('_', ' '))}</span>` : '';
    return `<div class="chat-msg chat-${m.from}">
      <div class="chat-meta">${who}${kindTag} · ${escapeHtml(m.at.slice(0, 16).replace('T', ' '))}</div>
      <div class="chat-text">${escapeHtml(m.text)}</div>
    </div>`;
  }).join('');
}

function renderEquitySparkline(points: DashboardEquityPoint[]): string {
  if (points.length < 2) return '<p class="muted">Not enough history yet for a chart.</p>';
  const width = 600, height = 80, pad = 4;
  const values = points.map(p => p.totalUsd);
  const min = Math.min(...values);
  const max = Math.max(...values);
  const range = max - min || 1;
  const stepX = (width - pad * 2) / (points.length - 1);
  const coords = points.map((p, i) => {
    const x = pad + i * stepX;
    const y = pad + (height - pad * 2) * (1 - (p.totalUsd - min) / range);
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  }).join(' ');
  const color = values[values.length - 1] >= values[0] ? '#4ade80' : '#f87171';
  return `<svg viewBox="0 0 ${width} ${height}" preserveAspectRatio="none" style="width:100%;height:80px;display:block;">` +
    `<polyline points="${coords}" fill="none" stroke="${color}" stroke-width="2" /></svg>` +
    `<div class="muted" style="margin-top:4px;">${escapeHtml(points[0].at.slice(0, 16).replace('T', ' '))} → ${escapeHtml(points[points.length - 1].at.slice(0, 16).replace('T', ' '))} · ${fmtUsd(min)}–${fmtUsd(max)}</div>`;
}

function renderPage(snapshot: DashboardSnapshot): string {
  const a = snapshot.account;
  const stance = snapshot.stance;
  return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="refresh" content="60">
<title>KAI Trading — Dashboard</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body { margin: 0; padding: 24px; background: #0b0e14; color: #e6e9ef; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; }
  h1 { font-size: 20px; margin: 0 0 4px; }
  .sub { color: #8891a3; font-size: 13px; margin-bottom: 24px; }
  .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 12px; margin-bottom: 24px; }
  .tile { background: #131826; border: 1px solid #232b3d; border-radius: 10px; padding: 14px; }
  .tile .label { color: #8891a3; font-size: 12px; text-transform: uppercase; letter-spacing: 0.04em; }
  .tile .value { font-size: 20px; font-weight: 600; margin-top: 4px; }
  section { margin-bottom: 28px; }
  h2 { font-size: 15px; color: #c3c9d6; border-bottom: 1px solid #232b3d; padding-bottom: 8px; }
  table { width: 100%; border-collapse: collapse; font-size: 13px; }
  th { text-align: left; color: #8891a3; font-weight: 500; padding: 6px 8px; border-bottom: 1px solid #232b3d; }
  td { padding: 6px 8px; border-bottom: 1px solid #1a2030; }
  .pos { color: #4ade80; } .neg { color: #f87171; }
  .muted { color: #8891a3; font-size: 13px; }
  .badge { font-size: 10px; padding: 2px 6px; border-radius: 999px; margin-left: 6px; }
  .badge-operator { background: #3730a3; color: #c7d2fe; }
  .badge-bot { background: #1e293b; color: #94a3b8; }
  .badge-kind { background: #713f12; color: #fde68a; }
  .banner { background: #422006; border: 1px solid #a16207; border-radius: 8px; padding: 12px 16px; margin-bottom: 20px; }
  .chat-msg { padding: 10px 12px; border-radius: 8px; margin-bottom: 8px; max-width: 80%; }
  .chat-operator { background: #1e293b; margin-left: auto; }
  .chat-ai { background: #131826; border: 1px solid #232b3d; }
  .chat-meta { font-size: 11px; color: #8891a3; margin-bottom: 4px; }
  form { display: flex; gap: 8px; margin-top: 12px; }
  textarea { flex: 1; background: #0b0e14; border: 1px solid #232b3d; border-radius: 8px; color: #e6e9ef; padding: 10px; font-family: inherit; font-size: 13px; resize: vertical; min-height: 44px; }
  button { background: #4f46e5; color: white; border: none; border-radius: 8px; padding: 0 18px; font-size: 13px; cursor: pointer; }
  .stance-box { background: #131826; border: 1px solid #232b3d; border-radius: 10px; padding: 14px; }
  .mode-live { color: #f87171; font-weight: 600; }
  .mode-paper { color: #94a3b8; }
  .banner-danger { background: #450a0a; border: 1px solid #b91c1c; border-radius: 8px; padding: 12px 16px; margin-bottom: 20px; }
  .danger-box { background: #1c0a0a; border: 1px solid #7f1d1d; border-radius: 10px; padding: 14px; }
  .btn-danger { background: #b91c1c; }
  .btn-safe { background: #15803d; }
  input[type=text] { background: #0b0e14; border: 1px solid #232b3d; border-radius: 8px; color: #e6e9ef; padding: 8px 10px; font-family: inherit; font-size: 13px; }
</style>
</head>
<body>
<h1>KAI Trading — <span class="${snapshot.mode === 'live' ? 'mode-live' : 'mode-paper'}">${snapshot.mode.toUpperCase()}</span></h1>
<div class="sub">Generated ${escapeHtml(snapshot.generatedAt)} · cycle ${snapshot.cycleCount} · last scan ${escapeHtml(snapshot.lastScan || 'n/a')} · ${escapeHtml(snapshot.model)} (${snapshot.usage.calls} calls, ${(snapshot.usage.promptTokens + snapshot.usage.completionTokens).toLocaleString()} tokens since start)</div>

${snapshot.tradingPaused ? `<div class="banner-danger"><strong>Trading paused:</strong> ${escapeHtml(snapshot.pauseReason)} — no new positions will open until resumed.</div>` : ''}

${snapshot.fundingRequest ? `<div class="banner"><strong>Funding request:</strong> ${fmtUsd(snapshot.fundingRequest.usd)} — ${escapeHtml(snapshot.fundingRequest.reasoning)} <span class="muted">(${escapeHtml(snapshot.fundingRequest.requestedAt)})</span></div>` : ''}

<div class="grid">
  <div class="tile"><div class="label">Total</div><div class="value">${a ? fmtUsd(a.totalUsd) : '—'}</div></div>
  <div class="tile"><div class="label">Cash (free)</div><div class="value">${a ? fmtUsd(a.cashUsd) : '—'}</div></div>
  <div class="tile"><div class="label">Tradable</div><div class="value">${a ? fmtUsd(a.tradableUsd) : '—'}</div></div>
  <div class="tile"><div class="label">Staked / reserved</div><div class="value">${a ? fmtUsd(a.stakedUsd) : '—'}</div></div>
  <div class="tile"><div class="label">Realised P/L</div><div class="value ${snapshot.totalPnl >= 0 ? 'pos' : 'neg'}">${fmtUsd(snapshot.totalPnl)}</div></div>
  <div class="tile"><div class="label">Win rate</div><div class="value">${snapshot.winRatePct.toFixed(0)}% <span class="muted">(${snapshot.wins}/${snapshot.wins + snapshot.losses})</span></div></div>
  <div class="tile"><div class="label">Max drawdown</div><div class="value ${snapshot.maxDrawdownPct > 0 ? 'neg' : ''}">${(snapshot.maxDrawdownPct * 100).toFixed(1)}%</div></div>
</div>

<section><h2>Equity</h2>${renderEquitySparkline(snapshot.equityHistory)}</section>

${stance ? `<section><h2>Latest stance</h2><div class="stance-box">
  <strong>${escapeHtml(stance.stance)}</strong> (${stance.confidence}/10) — ${escapeHtml(stance.reasoning)}
  ${stance.counterCase ? `<div class="muted" style="margin-top:6px;">Against it: ${escapeHtml(stance.counterCase)}</div>` : ''}
  ${stance.cashTargetPct > 0 ? `<div class="muted" style="margin-top:6px;">Holding ${(stance.cashTargetPct * 100).toFixed(0)}% back as dry powder</div>` : ''}
  <div class="muted" style="margin-top:6px;">${escapeHtml(stance.recordedAt || '')}</div>
</div></section>` : ''}

<section><h2>Open positions (${snapshot.positions.length})</h2>${renderPositions(snapshot.positions)}</section>

<section><h2>Recent closes</h2>${renderClosedTrades(snapshot.closedTrades)}
  <div class="muted" style="margin-top:8px;"><a href="/export/trades.csv" style="color:#818cf8;">Export full trade ledger (CSV)</a></div>
</section>

<section>
  <h2>Controls</h2>
  <div class="danger-box">
  ${snapshot.tradingPaused
    ? `<p>Trading is paused: ${escapeHtml(snapshot.pauseReason)}</p>
       <form method="POST" action="/resume"><button type="submit" class="btn-safe">Resume trading</button></form>`
    : `<p>Sells every open position at market right now and pauses new entries until you resume. Type <strong>FLATTEN</strong> to confirm.</p>
       <form method="POST" action="/kill-switch">
         <input type="text" name="confirm" placeholder="FLATTEN" autocomplete="off">
         <input type="text" name="reason" placeholder="reason (optional)" autocomplete="off" style="flex:1;">
         <button type="submit" class="btn-danger">Flatten &amp; pause</button>
       </form>`}
  </div>
</section>

<section>
  <h2>Chat with GLM</h2>
  ${renderChat(snapshot.chat)}
  <form method="POST" action="/message">
    <textarea name="text" maxlength="2000" placeholder="Ask a question, flag something, or say what you want changed. GLM reads this on its next cycle."></textarea>
    <button type="submit">Send</button>
  </form>
</section>

</body>
</html>`;
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error('body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

/**
 * Starts the read-only dashboard. Requires a non-empty password: there is no
 * "runs unauthenticated" mode, because this serves real portfolio value and a
 * message box that reaches a live-money decision loop.
 */
export function startDashboard(options: DashboardOptions): http.Server {
  if (!options.password) throw new Error('startDashboard requires a non-empty password');
  const throttle = new LoginThrottle(
    Math.max(1, options.maxLoginAttempts ?? 8),
    Math.max(1, options.lockoutMinutes ?? 15) * 60_000,
  );

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url || '/', 'http://localhost');

      if (url.pathname === '/health') {
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.end('ok');
        return;
      }

      const address = clientAddress(req);
      const lockedFor = throttle.lockedForSeconds(address);
      if (lockedFor > 0) {
        res.writeHead(429, { 'Content-Type': 'text/plain', 'Retry-After': String(lockedFor) });
        res.end(`Too many failed logins. Try again in ${Math.ceil(lockedFor / 60)} minute(s).`);
        return;
      }

      if (!checkAuth(req, options.username, options.password)) {
        throttle.recordFailure(address);
        requireAuth(res);
        return;
      }
      throttle.recordSuccess(address);

      if (url.pathname === '/' && req.method === 'GET') {
        const html = renderPage(options.getSnapshot());
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(html);
        return;
      }

      if (url.pathname === '/api/state' && req.method === 'GET') {
        const body = JSON.stringify(options.getSnapshot());
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(body);
        return;
      }

      if (url.pathname === '/export/trades.csv' && req.method === 'GET') {
        res.writeHead(200, {
          'Content-Type': 'text/csv; charset=utf-8',
          'Content-Disposition': 'attachment; filename="trades.csv"',
        });
        res.end(options.getTradesCsv());
        return;
      }

      if (url.pathname === '/message' && req.method === 'POST') {
        const body = await readBody(req);
        const params = new URLSearchParams(body);
        const text = (params.get('text') || '').trim();
        if (text) options.onOperatorMessage(text);
        res.writeHead(303, { Location: '/' });
        res.end();
        return;
      }

      if (url.pathname === '/kill-switch' && req.method === 'POST') {
        const body = await readBody(req);
        const params = new URLSearchParams(body);
        // A typed confirmation, not just a click, so this can't fire from a stray
        // request or a form auto-resubmitted by the browser.
        if (params.get('confirm') === 'FLATTEN') {
          const reason = (params.get('reason') || '').trim() || 'operator triggered via dashboard';
          options.onKillSwitch(reason);
        }
        res.writeHead(303, { Location: '/' });
        res.end();
        return;
      }

      if (url.pathname === '/resume' && req.method === 'POST') {
        options.onResume();
        res.writeHead(303, { Location: '/' });
        res.end();
        return;
      }

      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Not found.');
    } catch (e: any) {
      res.writeHead(400, { 'Content-Type': 'text/plain' });
      res.end(`Bad request: ${e.message}`);
    }
  });

  server.listen(options.port, () => {
    console.log(`  [DASHBOARD] Listening on port ${options.port} as user "${options.username}"`);
  });
  server.on('error', (e: any) => {
    console.error(`  [DASHBOARD] Server error: ${e.message}`);
  });
  return server;
}
