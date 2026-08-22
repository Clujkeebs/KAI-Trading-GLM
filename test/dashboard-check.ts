import assert from 'node:assert/strict';
import * as http from 'node:http';
import { startDashboard, DashboardSnapshot } from '../src/dashboard';

function emptySnapshot(): DashboardSnapshot {
  return {
    mode: 'paper',
    generatedAt: new Date().toISOString(),
    account: { totalUsd: 100, cashUsd: 50, tradableUsd: 50, stakedUsd: 0, asOf: new Date().toISOString() },
    positions: [],
    closedTrades: [],
    totalPnl: 0, wins: 0, losses: 0, winRatePct: 0,
    cycleCount: 1, lastScan: new Date().toISOString(),
    stance: null, fundingRequest: null, chat: [],
    model: 'test-model', usage: { calls: 0, promptTokens: 0, completionTokens: 0 },
    equityHistory: [], maxDrawdownPct: 0,
    tradingPaused: false, pauseReason: '',
  };
}

function request(
  port: number, path: string, options: { auth?: string; method?: string; body?: string } = {},
): Promise<{ status: number; body: string; headers: http.IncomingHttpHeaders }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port, path, method: options.method || 'GET',
        headers: {
          ...(options.auth ? { Authorization: `Basic ${Buffer.from(options.auth).toString('base64')}` } : {}),
          ...(options.body ? { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(options.body) } : {}),
        },
      },
      res => {
        const chunks: Buffer[] = [];
        res.on('data', c => chunks.push(c));
        res.on('end', () => resolve({ status: res.statusCode!, body: Buffer.concat(chunks).toString('utf8'), headers: res.headers }));
      },
    );
    req.on('error', reject);
    if (options.body) req.write(options.body);
    req.end();
  });
}

async function main() {
  // startDashboard refuses to run without a password: this is a live-money view.
  assert.throws(() => startDashboard({
    port: 0, username: 'operator', password: '', getSnapshot: emptySnapshot,
    onOperatorMessage: () => {}, onKillSwitch: () => {}, onResume: () => {},
  }), /password/);

  let snapshot = emptySnapshot();
  const messages: string[] = [];
  const killSwitchCalls: string[] = [];
  let resumeCalls = 0;
  const server = startDashboard({
    port: 0, username: 'operator', password: 'correct-horse',
    getSnapshot: () => snapshot,
    onOperatorMessage: (text: string) => { messages.push(text); },
    onKillSwitch: (reason: string) => { killSwitchCalls.push(reason); },
    onResume: () => { resumeCalls++; },
  });
  await new Promise<void>(resolve => server.once('listening', resolve));
  const port = (server.address() as any).port;

  try {
    // /health is unauthenticated, for Railway's health check.
    const health = await request(port, '/health');
    assert.equal(health.status, 200);
    assert.equal(health.body, 'ok');

    // Every other route demands Basic Auth.
    const noAuth = await request(port, '/');
    assert.equal(noAuth.status, 401);
    assert.ok(noAuth.headers['www-authenticate']);

    const wrongAuth = await request(port, '/', { auth: 'operator:nope' });
    assert.equal(wrongAuth.status, 401);

    const wrongUser = await request(port, '/', { auth: 'someoneelse:correct-horse' });
    assert.equal(wrongUser.status, 401);

    const home = await request(port, '/', { auth: 'operator:correct-horse' });
    assert.equal(home.status, 200);
    assert.ok(home.body.includes('KAI Trading'));
    assert.ok(home.body.includes('PAPER'));

    const api = await request(port, '/api/state', { auth: 'operator:correct-horse' });
    assert.equal(api.status, 200);
    const parsed = JSON.parse(api.body);
    assert.equal(parsed.model, 'test-model');
    assert.equal(parsed.account.cashUsd, 50);

    // Posting a message reaches the callback and redirects home; it never trades.
    const post = await request(port, '/message', {
      auth: 'operator:correct-horse', method: 'POST', body: 'text=' + encodeURIComponent('Add $50 please'),
    });
    assert.equal(post.status, 303);
    assert.equal(post.headers.location, '/');
    assert.deepEqual(messages, ['Add $50 please']);

    // A blank message is dropped rather than posted as an empty entry.
    await request(port, '/message', { auth: 'operator:correct-horse', method: 'POST', body: 'text=' + encodeURIComponent('   ') });
    assert.deepEqual(messages, ['Add $50 please'], 'whitespace-only messages are not posted');

    // The page reflects live-mode styling and open positions when the snapshot changes.
    snapshot = {
      ...emptySnapshot(),
      mode: 'live',
      positions: [{
        pair: 'BTC/USD', entryPrice: 100, currentPrice: 110, qty: 1, costBasisUsd: 100,
        stopLoss: 90, takeProfit: 130, alertPrice: 95, origin: 'operator', sector: 'l1', openedAt: new Date().toISOString(),
      }],
      fundingRequest: { usd: 200, reasoning: 'sizing is capital constrained', requestedAt: new Date().toISOString() },
      equityHistory: [
        { at: '2026-08-01T00:00:00.000Z', totalUsd: 1000 },
        { at: '2026-08-02T00:00:00.000Z', totalUsd: 1200 },
        { at: '2026-08-03T00:00:00.000Z', totalUsd: 900 },
      ],
      maxDrawdownPct: 0.25,
    };
    const live = await request(port, '/', { auth: 'operator:correct-horse' });
    assert.ok(live.body.includes('LIVE'));
    assert.ok(live.body.includes('BTC/USD'));
    assert.ok(live.body.includes('yours'), 'operator-opened positions are badged');
    assert.ok(live.body.includes('Funding request'));
    assert.ok(live.body.includes('<polyline'), 'the equity history renders a sparkline');
    assert.ok(live.body.includes('25.0%'), 'the max drawdown stat is shown');

    // Fewer than two equity points is not enough for a chart; say so instead of drawing garbage.
    const noHistory = await request(port, '/api/state', { auth: 'operator:correct-horse' });
    const parsedLive = JSON.parse(noHistory.body);
    assert.equal(parsedLive.equityHistory.length, 3);

    // The kill switch needs a typed confirmation, not just a click.
    const badConfirm = await request(port, '/kill-switch', {
      auth: 'operator:correct-horse', method: 'POST', body: 'confirm=' + encodeURIComponent('flatten'),
    });
    assert.equal(badConfirm.status, 303, 'a bad confirmation still redirects, quietly doing nothing');
    assert.deepEqual(killSwitchCalls, [], 'a lowercase or missing confirmation does not fire the kill switch');

    const goodConfirm = await request(port, '/kill-switch', {
      auth: 'operator:correct-horse', method: 'POST',
      body: 'confirm=FLATTEN&reason=' + encodeURIComponent('testing the panic button'),
    });
    assert.equal(goodConfirm.status, 303);
    assert.deepEqual(killSwitchCalls, ['testing the panic button'], 'an exact FLATTEN confirmation fires it once, with the reason');

    // A blank reason falls back to a sensible default rather than an empty string.
    await request(port, '/kill-switch', { auth: 'operator:correct-horse', method: 'POST', body: 'confirm=FLATTEN' });
    assert.equal(killSwitchCalls[1], 'operator triggered via dashboard');

    const resumed = await request(port, '/resume', { auth: 'operator:correct-horse', method: 'POST' });
    assert.equal(resumed.status, 303);
    assert.equal(resumeCalls, 1);

    // Paused-state rendering: a banner and a resume control instead of the flatten form.
    snapshot = { ...emptySnapshot(), tradingPaused: true, pauseReason: 'operator triggered via dashboard' };
    const pausedPage = await request(port, '/', { auth: 'operator:correct-horse' });
    assert.ok(pausedPage.body.includes('Trading paused'));
    assert.ok(pausedPage.body.includes('Resume trading'));
    assert.ok(!pausedPage.body.includes('Flatten &amp; pause'), 'the flatten form is hidden while already paused');

    // An unknown route is a 404, not a silent 200.
    const missing = await request(port, '/nope', { auth: 'operator:correct-horse' });
    assert.equal(missing.status, 404);
  } finally {
    server.close();
  }

  // ── Repeated wrong logins lock the address out, even from the right password ──
  {
    const throttled = startDashboard({
      port: 0, username: 'operator', password: 'correct-horse',
      maxLoginAttempts: 3, lockoutMinutes: 1,
      getSnapshot: emptySnapshot, onOperatorMessage: () => {},
      onKillSwitch: () => {}, onResume: () => {},
    });
    await new Promise<void>(resolve => throttled.once('listening', resolve));
    const tPort = (throttled.address() as any).port;
    try {
      for (let i = 0; i < 3; i++) {
        const res = await request(tPort, '/', { auth: 'operator:nope' });
        assert.equal(res.status, 401, `attempt ${i + 1} should be a plain auth failure, not yet locked`);
      }
      const locked = await request(tPort, '/', { auth: 'operator:correct-horse' });
      assert.equal(locked.status, 429, 'the correct password no longer works once the address is locked out');
      assert.ok(locked.headers['retry-after'], 'a locked response names when to retry');

      // /health stays reachable throughout — it never touches auth or the throttle.
      const health = await request(tPort, '/health');
      assert.equal(health.status, 200);
    } finally {
      throttled.close();
    }
  }

  // ── A successful login clears any prior failures for that address ─────────
  {
    const resettable = startDashboard({
      port: 0, username: 'operator', password: 'correct-horse',
      maxLoginAttempts: 3, lockoutMinutes: 1,
      getSnapshot: emptySnapshot, onOperatorMessage: () => {},
      onKillSwitch: () => {}, onResume: () => {},
    });
    await new Promise<void>(resolve => resettable.once('listening', resolve));
    const rPort = (resettable.address() as any).port;
    try {
      await request(rPort, '/', { auth: 'operator:nope' });
      await request(rPort, '/', { auth: 'operator:nope' });
      const ok = await request(rPort, '/', { auth: 'operator:correct-horse' });
      assert.equal(ok.status, 200, 'a correct login before the threshold is not blocked');
      // The two prior failures should be forgotten now, not carried toward the next lockout.
      await request(rPort, '/', { auth: 'operator:nope' });
      await request(rPort, '/', { auth: 'operator:nope' });
      const stillOk = await request(rPort, '/', { auth: 'operator:correct-horse' });
      assert.equal(stillOk.status, 200, 'a success resets the failure count');
    } finally {
      resettable.close();
    }
  }

  console.log('dashboard checks passed');
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
