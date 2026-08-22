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
    port: 0, username: 'operator', password: '', getSnapshot: emptySnapshot, onOperatorMessage: () => {},
  }), /password/);

  let snapshot = emptySnapshot();
  const messages: string[] = [];
  const server = startDashboard({
    port: 0, username: 'operator', password: 'correct-horse',
    getSnapshot: () => snapshot,
    onOperatorMessage: (text: string) => { messages.push(text); },
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
    };
    const live = await request(port, '/', { auth: 'operator:correct-horse' });
    assert.ok(live.body.includes('LIVE'));
    assert.ok(live.body.includes('BTC/USD'));
    assert.ok(live.body.includes('yours'), 'operator-opened positions are badged');
    assert.ok(live.body.includes('Funding request'));

    // An unknown route is a 404, not a silent 200.
    const missing = await request(port, '/nope', { auth: 'operator:correct-horse' });
    assert.equal(missing.status, 404);
  } finally {
    server.close();
  }

  console.log('dashboard checks passed');
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
