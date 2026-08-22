import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

// The state directory is resolved when the module loads, so it has to be pointed
// at a scratch directory before the bot is imported.
const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kai-state-'));
process.env.DATA_DIR = stateDir;

async function main() {
  const bot = await import('../src/index');
  const { Memory, setConfig, loadConfig } = bot;
  setConfig(loadConfig());

  const fresh = () => new Memory();
  const reset = () => {
    for (const file of fs.readdirSync(stateDir)) fs.rmSync(path.join(stateDir, file), { force: true });
  };

  // ── A clean close books the whole position ─────────────────────────────────
  reset();
  {
    const mem = fresh();
    mem.openPosition('AAA/USD', 10, 10, 9, 12, 'ai', 'setup', 'reasoning', 1);
    assert.equal(mem.positions['AAA/USD'].costBasisUsd, 101, 'fees belong in the cost basis');
    assert.equal(mem.positions['AAA/USD'].initialStopLoss, 9);
    assert.equal(mem.positions['AAA/USD'].highWaterMark, 10);

    const closed = mem.closePosition('AAA/USD', 12, 'target', 1)!;
    assert.equal(closed.exitValueUsd, 119);
    assert.equal(closed.pnlUsd, 18);
    assert.equal(closed.pnlPct, 17.82);
    assert.equal(mem.state.totalPnl, 18);
    assert.equal(mem.state.wins, 1);
    assert.equal(mem.state.losses, 0);
    assert.equal(mem.realizedPnlToday(), 18);
    assert.equal(mem.state.sectorStats.ai.trades, 1);
    assert.equal(mem.state.recentTrades.length, 1);
    assert.equal(mem.state.recentTrades[0].pair, 'AAA/USD');
    assert.equal(mem.closePosition('AAA/USD', 12, 'again'), null, 'a closed position cannot close twice');
  }

  // ── A partial fill must not invent P/L on coins that never sold ────────────
  reset();
  {
    const mem = fresh();
    mem.openPosition('BBB/USD', 10, 10, 9, 12, 'defi', 'setup', 'reasoning');
    // Only 4 of 10 units filled, and the rest is dust worth abandoning.
    const closed = mem.closePosition('BBB/USD', 12, 'stop', 0, 4)!;
    assert.equal(closed.exitValueUsd, 48, 'proceeds come from the quantity that actually sold');
    assert.equal(closed.pnlUsd, -52);
    assert.equal(mem.state.losses, 1);
  }

  // ── A meaningful residual stays open, with its share booked now ────────────
  reset();
  {
    const mem = fresh();
    mem.openPosition('CCC/USD', 10, 10, 9, 12, 'l1', 'setup', 'reasoning');
    const booked = mem.reducePosition('CCC/USD', 4, 12, 0);
    assert.equal(booked, 8, '4 units bought at 10 and sold at 12');
    const position = mem.positions['CCC/USD'];
    assert.equal(position.status, 'open');
    assert.equal(position.qty, 6);
    assert.equal(position.costBasisUsd, 60);
    assert.equal(position.bookedPnlUsd, 8);
    assert.equal(mem.state.totalPnl, 8);
    assert.equal(mem.state.totalTrades, 0, 'a partial exit is not a separate trade');

    // Closing the remainder at 11 books only the remainder's P/L; the total across
    // both legs equals the true result of (4 @ 12) + (6 @ 11) against a basis of 100.
    const closed = mem.closePosition('CCC/USD', 11, 'target')!;
    assert.equal(closed.pnlUsd, 6);
    assert.equal(mem.state.totalPnl, 14);
    assert.equal(48 + 66 - 100, 14);
    assert.equal(mem.state.totalTrades, 1);

    assert.equal(mem.reducePosition('CCC/USD', 1, 11), null, 'a closed position cannot be reduced');
  }

  // ── Break-even is neither a win nor a loss ─────────────────────────────────
  reset();
  {
    const mem = fresh();
    mem.openPosition('DDD/USD', 1, 100, 90, 120, 'rwa', 'setup', 'reasoning');
    mem.closePosition('DDD/USD', 100, 'flat');
    assert.equal(mem.state.wins, 0);
    assert.equal(mem.state.losses, 0);
    assert.equal(mem.state.totalTrades, 1);
    assert.equal(mem.winRate(), 0);

    mem.openPosition('EEE/USD', 1, 100, 90, 120, 'rwa', 'setup', 'reasoning');
    mem.closePosition('EEE/USD', 110, 'target');
    assert.equal(mem.winRate(), 100, 'win rate is measured over decided trades only');
  }

  // ── Sub-cent positions keep a usable cost basis ────────────────────────────
  reset();
  {
    const mem = fresh();
    mem.openPosition('BONK/USD', 100_000, 0.000023, 0.00002, 0.00003, 'momentum', 'setup', 'reasoning');
    const position = mem.positions['BONK/USD'];
    // Rounding the basis to cents used to leave 0 here and make every percentage
    // Infinity or NaN downstream.
    assert.ok(Math.abs(position.costBasisUsd - 2.3) < 1e-9);
    const closed = mem.closePosition('BONK/USD', 0.000025, 'target')!;
    assert.ok(Number.isFinite(closed.pnlPct));
    assert.equal(closed.pnlPct, 8.7);
  }

  // ── High-water mark tracks the peak, not the latest tick ───────────────────
  reset();
  {
    const mem = fresh();
    mem.openPosition('FFF/USD', 1, 100, 90, 120, 'ai', 'setup', 'reasoning');
    mem.updatePrices({ 'FFF/USD': 130 });
    mem.updatePrices({ 'FFF/USD': 110 });
    assert.equal(mem.positions['FFF/USD'].currentPrice, 110);
    assert.equal(mem.positions['FFF/USD'].highWaterMark, 130);
    mem.updatePrices({ 'FFF/USD': Number.NaN });
    assert.equal(mem.positions['FFF/USD'].currentPrice, 110, 'a bad tick is ignored');
  }

  // ── Paper cash compounds instead of resetting every cycle ──────────────────
  reset();
  {
    const mem = fresh();
    const start = mem.paperCash();
    assert.ok(start > 0);
    mem.adjustPaperCash(-50);
    assert.equal(mem.paperCash(), start - 50);
    assert.equal(fresh().paperCash(), start - 50, 'paper cash survives a restart');
    mem.adjustPaperCash(-1e9);
    assert.equal(mem.paperCash(), 0, 'paper cash never goes negative');
  }

  // ── State survives a restart, and corruption never silently wipes it ───────
  reset();
  {
    const mem = fresh();
    mem.openPosition('GGG/USD', 2, 50, 45, 60, 'defi', 'setup', 'reasoning');
    mem.closePosition('GGG/USD', 55, 'target');
    const reloaded = fresh();
    assert.equal(reloaded.state.totalPnl, 10);
    assert.equal(reloaded.state.recentTrades.length, 1);
    assert.equal(reloaded.state.sectorStats.defi.wins, 1);

    fs.writeFileSync(path.join(stateDir, 'positions.json'), '{"AAA/USD": {truncated');
    const recovered = fresh();
    assert.deepEqual(recovered.positions, {}, 'unreadable state falls back to empty');
    const backups = fs.readdirSync(stateDir).filter(f => f.includes('positions.json.corrupt-'));
    assert.equal(backups.length, 1, 'the unreadable file is preserved for recovery');
    assert.match(fs.readFileSync(path.join(stateDir, backups[0]), 'utf-8'), /truncated/);
  }

  // ── Trade history stays bounded ────────────────────────────────────────────
  reset();
  {
    const mem = fresh();
    for (let i = 0; i < 40; i++) {
      mem.openPosition(`P${i}/USD`, 1, 100, 90, 120, 'ai', 'setup', 'reasoning');
      mem.closePosition(`P${i}/USD`, 101, 'target');
    }
    assert.equal(mem.state.recentTrades.length, 25);
    assert.equal(mem.state.recentTrades[24].pair, 'P39/USD');
    assert.equal(mem.state.totalTrades, 40);
    assert.ok(mem.getContextSummary().includes('P39/USD'));
    assert.ok(mem.getContextSummary().includes('SECTOR PERFORMANCE'));
  }

  // ── The trade log stays parseable when the AI writes prose ────────────────
  reset();
  {
    const mem = fresh();
    mem.logTrade({
      timestamp: '2026-01-01T00:00:00.000Z', pair: 'HHH/USD', side: 'BUY',
      price: 1, qty: 1, costBasisUsd: 1, stopLoss: 0.9, takeProfit: 1.2,
      pnlUsd: 0, pnlPct: 0, status: 'open', sector: 'ai',
      reason: 'RSI=29, near support', aiVerdict: 'BUY', aiConfidence: 8,
    });
    const rows = fs.readFileSync(path.join(stateDir, 'trades.csv'), 'utf-8').trim().split('\n');
    assert.equal(rows.length, 2);
    const header = rows[0].split(',');
    // Unescaped commas in AI text used to shift every column after "reason".
    const cells = rows[1].match(/("([^"]|"")*"|[^,]*)/g)!.filter((_, i) => i % 2 === 0);
    assert.equal(cells.length, header.length);
    assert.equal(cells[header.indexOf('reason')], '"RSI=29, near support"');
    assert.equal(cells[header.indexOf('ai_verdict')], 'BUY');
    assert.equal(cells[header.indexOf('ai_confidence')], '8');
  }

  // ── Chat log: two-way correspondence, bounded and unread-tracked ──────────
  reset();
  {
    const mem = fresh();
    const posted = mem.postOperatorMessage('  Should I add more funds?  ');
    assert.equal(posted.from, 'operator');
    assert.equal(posted.text, 'Should I add more funds?', 'the message is trimmed');
    assert.equal(mem.state.chatLog.length, 1);
    assert.ok(mem.state.chatLog[0].id, 'every message gets an id');

    assert.equal(mem.unreadOperatorMessages().length, 1, 'a fresh operator message is unread');
    mem.postAiMessage('Not yet — current book is well funded.', 'reply');
    assert.equal(mem.unreadOperatorMessages().length, 0, 'an AI reply marks prior messages read');

    mem.postOperatorMessage('Ok, thanks.');
    assert.equal(mem.unreadOperatorMessages().length, 1, 'a later message is unread again');
    assert.equal(mem.unreadOperatorMessages()[0].text, 'Ok, thanks.');

    // A restart must not lose the conversation.
    const reloaded = fresh();
    assert.equal(reloaded.state.chatLog.length, 3);
    assert.equal(reloaded.unreadOperatorMessages().length, 1);

    // The log is bounded so it cannot grow state.json or prompt cost forever.
    for (let i = 0; i < 50; i++) mem.postOperatorMessage(`message ${i}`);
    assert.ok(mem.state.chatLog.length <= 40, `chat log grew to ${mem.state.chatLog.length}`);
    assert.equal(mem.state.chatLog[mem.state.chatLog.length - 1].text, 'message 49',
      'the newest messages are kept, not the oldest');

    // An operator message is never treated as instructions to run.
    const huge = 'x'.repeat(5000);
    const capped = mem.postOperatorMessage(huge);
    assert.ok(capped.text.length <= 2000, 'message length is bounded');
  }

  // ── The account snapshot is cached, not fetched fresh by a viewer ─────────
  reset();
  {
    const mem = fresh();
    assert.equal(mem.state.lastAccountSnapshot, null, 'nothing cached before the first cycle');
    mem.recordAccountSnapshot({ totalUsd: 1000, cashUsd: 100, tradableUsd: 400, stakedUsd: 600 });
    assert.equal(mem.state.lastAccountSnapshot?.totalUsd, 1000);
    assert.ok(mem.state.lastAccountSnapshot?.asOf, 'the snapshot is timestamped');
    const reloaded = fresh();
    assert.equal(reloaded.state.lastAccountSnapshot?.cashUsd, 100, 'the snapshot survives a restart');
  }

  fs.rmSync(stateDir, { recursive: true, force: true });
  console.log('memory checks passed');
}

main().catch(e => {
  fs.rmSync(stateDir, { recursive: true, force: true });
  console.error(e);
  process.exit(1);
});
