import dotenv from 'dotenv';
import * as readline from 'readline';

dotenv.config();

// ============================================================
// CLI — a terminal front end for the dashboard's HTTP API.
//
// Talks to the same /api/state and /message routes the web dashboard uses;
// it does not touch the exchange, config, or state files directly. Anything
// it can do, the web dashboard can also do — this is just a second way in,
// for a terminal instead of a browser.
// ============================================================

const url = (process.env.DASHBOARD_URL || '').replace(/\/+$/, '');
const username = process.env.DASHBOARD_USERNAME || 'operator';
const password = process.env.DASHBOARD_PASSWORD || '';

function authHeader(): string {
  return 'Basic ' + Buffer.from(`${username}:${password}`).toString('base64');
}

async function fetchState(): Promise<any> {
  const res = await fetch(`${url}/api/state`, { headers: { Authorization: authHeader() } });
  if (!res.ok) throw new Error(`GET /api/state -> ${res.status} ${(await res.text()).slice(0, 200)}`);
  return res.json();
}

async function postMessage(text: string): Promise<void> {
  const res = await fetch(`${url}/message`, {
    method: 'POST',
    headers: { Authorization: authHeader(), 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `text=${encodeURIComponent(text)}`,
    redirect: 'manual',
  });
  // A successful POST redirects (303) back to "/"; anything else is a real failure.
  if (res.status !== 303 && !res.ok) throw new Error(`POST /message -> ${res.status} ${(await res.text()).slice(0, 200)}`);
}

function fmtUsd(n: number): string {
  if (!Number.isFinite(n)) return '$n/a';
  return `$${n.toFixed(2)}`;
}

function fmtPct(n: number): string {
  return `${n >= 0 ? '+' : ''}${n.toFixed(1)}%`;
}

function printBalance(state: any) {
  console.log(`\n${String(state.mode).toUpperCase()} | cycle ${state.cycleCount} | last scan ${state.lastScan || 'n/a'} | ${state.model}`);
  if (state.account) {
    console.log(`Total: ${fmtUsd(state.account.totalUsd)}  Cash: ${fmtUsd(state.account.cashUsd)}  Tradable: ${fmtUsd(state.account.tradableUsd)}  Staked/reserved: ${fmtUsd(state.account.stakedUsd)}`);
    console.log(`  (as of ${state.account.asOf})`);
  } else {
    console.log('No account snapshot yet — the bot has not completed a cycle.');
  }
  console.log(`Realised P/L: ${fmtUsd(state.totalPnl)}  Win rate: ${state.winRatePct.toFixed(0)}% (${state.wins}/${state.wins + state.losses})`);
  if (state.fundingRequest) {
    console.log(`\n[FUNDING REQUEST] ${fmtUsd(state.fundingRequest.usd)} — ${state.fundingRequest.reasoning}`);
  }
  console.log(`\nOpen positions (${state.positions.length}):`);
  if (state.positions.length === 0) console.log('  none');
  for (const p of state.positions) {
    const pnl = (p.currentPrice - p.entryPrice) * p.qty;
    const pnlPct = p.costBasisUsd > 0 ? (pnl / p.costBasisUsd) * 100 : 0;
    console.log(`  ${p.pair.padEnd(10)} [${p.origin}] entry ${fmtUsd(p.entryPrice)} now ${fmtUsd(p.currentPrice)}  P/L ${fmtUsd(pnl)} (${fmtPct(pnlPct)})  stop ${fmtUsd(p.stopLoss)}  target ${fmtUsd(p.takeProfit)}`);
  }
  if (state.stance) {
    console.log(`\nLatest stance: ${state.stance.stance} (${state.stance.confidence}/10) — ${state.stance.reasoning}`);
  }
}

async function runBalance() {
  printBalance(await fetchState());
}

async function runChat() {
  const state = await fetchState();
  console.log('--- Recent chat ---');
  const recent = (state.chat || []).slice(-15);
  if (recent.length === 0) console.log('  (no messages yet)');
  for (const m of recent) {
    const who = m.from === 'operator' ? 'You' : 'GLM';
    console.log(`[${String(m.at).slice(0, 16).replace('T', ' ')}] ${who}: ${m.text}`);
  }
  console.log('\nType a message and press Enter to send. It reads unread messages on its next');
  console.log('portfolio review — sending one triggers that scan immediately instead of waiting');
  console.log('for the interval. Replies land in this same log, not instantly. Ctrl+C to quit.\n');

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, prompt: 'You> ' });
  let pending = Promise.resolve();
  rl.prompt();
  rl.on('line', line => {
    const text = line.trim();
    if (text) {
      pending = pending.then(async () => {
        try {
          await postMessage(text);
          console.log('  (sent — the bot is scanning now; run "npm run cli -- chat" again to see a reply)');
        } catch (e: any) {
          console.error(`  (failed to send: ${e.message})`);
        }
      });
    }
    rl.prompt();
  });
  // A closed stdin can race an in-flight send (e.g. piped input); wait for it first.
  rl.on('close', () => { pending.then(() => process.exit(0)); });
}

async function main() {
  if (!url) {
    console.error('Missing DASHBOARD_URL, e.g. https://your-app.up.railway.app');
    console.error('Set it in .env or the environment, alongside DASHBOARD_PASSWORD.');
    process.exit(1);
  }
  if (!password) {
    console.error('Missing DASHBOARD_PASSWORD.');
    process.exit(1);
  }
  const cmd = process.argv[2];
  if (cmd === 'balance') await runBalance();
  else if (cmd === 'chat') await runChat();
  else {
    console.log('Usage: npm run cli -- balance | chat');
    console.log('Requires DASHBOARD_URL and DASHBOARD_PASSWORD (DASHBOARD_USERNAME defaults to "operator").');
    process.exit(1);
  }
}

main().catch(e => {
  console.error(e.message || e);
  process.exit(1);
});
