import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kai-ai-'));
process.env.DATA_DIR = stateDir;
process.env.AI_API_KEY = 'test-key';
process.env.AI_MAX_TOKENS = '1000';
process.env.AI_REASONING_EFFORT = 'low';

type Reply = {
  content?: string;
  reasoning?: string;
  finish_reason?: string;
  throws?: { status?: number; message: string };
};

/** Records what was sent and replays scripted provider responses. */
function fakeClient(replies: Reply[]) {
  const sent: any[] = [];
  let index = 0;
  return {
    sent,
    chat: {
      completions: {
        create: async (params: any) => {
          sent.push(params);
          const reply = replies[Math.min(index++, replies.length - 1)];
          if (reply.throws) {
            const error: any = new Error(reply.throws.message);
            error.status = reply.throws.status;
            throw error;
          }
          return {
            choices: [{
              finish_reason: reply.finish_reason ?? 'stop',
              message: { content: reply.content ?? '', reasoning: reply.reasoning },
            }],
          };
        },
      },
    },
  };
}

const VALID = '{"verdict":"BUY","confidence":7,"reasoning":"oversold at support","position_size_pct":10,"adjusted_stop":null,"adjusted_target":null}';
// Exactly the shape production was producing: cut off mid-string.
const TRUNCATED = '{"verdict":"BUY","confidence":7,"reasoning":"oversold near the lower band and the higher timefr';

async function main() {
  const bot = await import('../src/index');
  const { AiBrain, Memory, setConfig, loadConfig, isTruncated, reportPreflight } = bot;
  setConfig(loadConfig());
  const mem = new Memory();

  const brainWith = (replies: Reply[]) => {
    const brain = new AiBrain(mem);
    const client = fakeClient(replies);
    (brain as any).client = client;
    return { brain, client };
  };

  // ── Truncation detection ───────────────────────────────────────────────────
  assert.equal(isTruncated('length'), true);
  assert.equal(isTruncated('max_tokens'), true);
  assert.equal(isTruncated('MAX_OUTPUT_TOKENS'), true);
  assert.equal(isTruncated('stop'), false);
  assert.equal(isTruncated(undefined), false);

  // ── A clean reply is used as-is ────────────────────────────────────────────
  {
    const { brain, client } = brainWith([{ content: VALID }]);
    const d = await (brain as any).call('probe', 'AAA/USD');
    assert.equal(d.verdict, 'BUY');
    assert.equal(d.confidence, 7);
    assert.equal(d.positionSizePct, 10);
    assert.equal(client.sent.length, 1, 'no retry is needed');
    // Reasoning effort is capped so the completion budget is left for the JSON.
    assert.deepEqual(client.sent[0].reasoning, { effort: 'low' });
    assert.deepEqual(client.sent[0].response_format, { type: 'json_object' });
    assert.equal(client.sent[0].max_tokens, 1000);
  }

  // ── Truncation raises the budget and retries, instead of falling back ──────
  // This is the production failure: replies cut off mid-JSON, every decision
  // silently becoming HOLD. Asking the model again at the same budget cannot fix
  // it; only more room can.
  {
    const { brain, client } = brainWith([
      { content: TRUNCATED, finish_reason: 'length' },
      { content: VALID, finish_reason: 'stop' },
    ]);
    const d = await (brain as any).call('probe', 'BBB/USD');
    assert.equal(d.verdict, 'BUY');
    assert.equal(d.positionSizePct, 10, 'the retried reply carries a real size, not a salvaged zero');
    assert.equal(client.sent.length, 2);
    assert.equal(client.sent[0].max_tokens, 1000);
    assert.equal(client.sent[1].max_tokens, 2000, 'the budget doubled after truncation');
  }

  // ── The raised budget persists for the rest of the run ─────────────────────
  {
    const { brain, client } = brainWith([
      { content: TRUNCATED, finish_reason: 'length' },
      { content: VALID },
    ]);
    await (brain as any).call('probe', 'CCC/USD');
    await (brain as any).call('probe', 'DDD/USD');
    assert.equal(client.sent[client.sent.length - 1].max_tokens, 2000,
      'a later pair does not pay the truncation cost again');
  }

  // ── A truncated reply with no retry left still salvages the verdict ────────
  {
    const { brain } = brainWith([{ content: TRUNCATED, finish_reason: 'length' }]);
    const d = await (brain as any).call('probe', 'EEE/USD');
    assert.equal(d.verdict, 'BUY', 'the verdict survives even when the JSON does not');
    assert.equal(d.positionSizePct, 0, 'but a salvaged reply never sizes a position');
    assert.equal(d.adjustedStop, null);
  }

  // ── Reasoning models that answer only in the reasoning channel ─────────────
  {
    const { brain } = brainWith([{ content: '', reasoning: VALID }]);
    const d = await (brain as any).call('probe', 'FFF/USD');
    assert.equal(d.verdict, 'BUY');
  }

  // ── Providers that reject the extra parameters are handled, once ───────────
  {
    const { brain, client } = brainWith([
      { throws: { status: 400, message: 'Unrecognized request argument: reasoning' } },
      { content: VALID },
    ]);
    const d = await (brain as any).call('probe', 'GGG/USD');
    assert.equal(d.verdict, 'BUY');
    assert.equal(client.sent[0].reasoning !== undefined, true);
    assert.equal(client.sent[1].reasoning, undefined, 'the rejected parameter is dropped');
    assert.deepEqual(client.sent[1].response_format, { type: 'json_object' });
  }
  {
    const { brain, client } = brainWith([
      { throws: { status: 400, message: 'response_format is not supported by this model' } },
      { content: VALID },
    ]);
    await (brain as any).call('probe', 'HHH/USD');
    assert.equal(client.sent[1].response_format, undefined);
  }

  // ── Errors that cannot succeed are not retried three times ────────────────
  {
    const { brain, client } = brainWith([{ throws: { status: 401, message: 'invalid api key' } }]);
    const d = await (brain as any).call('probe', 'III/USD');
    assert.equal(d.verdict, 'HOLD', 'an unusable model falls back to doing nothing');
    assert.ok(client.sent.length <= 3, `bad credentials retried ${client.sent.length} times`);
  }

  // ── The self-test reports what production is actually doing ───────────────
  {
    const { brain } = brainWith([{ content: VALID }, { content: VALID }]);
    const healthy = await brain.selfTest(2);
    assert.equal(healthy.valid, 2);
    assert.equal(healthy.salvaged, 0);
    assert.deepEqual(healthy.finishReasons, { stop: 2 });
    assert.ok(healthy.budget >= 1000);
  }
  {
    // Reproduces the deployed failure: nothing usable comes back at all.
    const { brain } = brainWith([{ content: '', finish_reason: 'length' }]);
    const broken = await brain.selfTest(3);
    assert.equal(broken.valid, 0);
    assert.equal(broken.salvaged, 0);
    assert.equal(broken.total, 3);
    assert.equal(broken.finishReasons.length, 3);
    assert.ok(broken.budget > 1000, 'the probe itself discovers the budget is too small');
  }

  // ── Preflight reporting distinguishes fatal from merely worrying ───────────
  assert.equal(reportPreflight([
    { name: 'a', ok: true, detail: 'fine', critical: false },
    { name: 'b', ok: false, detail: 'odd', critical: false },
  ]), true, 'warnings do not stop the bot');
  assert.equal(reportPreflight([
    { name: 'a', ok: false, detail: 'no exchange', critical: true },
  ]), false, 'critical failures do');

  fs.rmSync(stateDir, { recursive: true, force: true });
  console.log('ai checks passed');
}

main().catch(e => {
  fs.rmSync(stateDir, { recursive: true, force: true });
  console.error(e);
  process.exit(1);
});
