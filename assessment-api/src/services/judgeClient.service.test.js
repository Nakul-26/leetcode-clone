import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// JUDGE_FIX_PLAN M1: /run and /raw-run go over RabbitMQ when a judge consumes the request
// queue, and over HTTP otherwise (no consumer yet, broker down, JUDGE_RPC=off, or a judge
// with no free container).

let consumerCount = 1;
let replyStatus = 200;
let consumeHandler = null;
const sent = [];
const fakeChannel = {
  on: vi.fn(),
  assertQueue: vi.fn(async () => ({ consumerCount })),
  consume: vi.fn(async (_queue, handler) => { consumeHandler = handler; }),
  sendToQueue: vi.fn((queue, content, props) => {
    sent.push({ queue, request: JSON.parse(content.toString()), props });
    // The judge answers on the reply-to queue with the request's correlation id.
    setTimeout(() => consumeHandler({
      properties: { correlationId: props.correlationId },
      content: Buffer.from(JSON.stringify({ status: replyStatus, body: '{"status":"Accepted"}' })),
    }), 5);
    return true;
  }),
};
let brokerDown = false;
vi.mock('../config/rabbit.js', () => ({
  initRabbit: vi.fn(async () => { if (brokerDown) throw new Error('ECONNREFUSED'); }),
  getConnection: () => ({ createChannel: async () => fakeChannel }),
}));

const { judgeFetch, _resetJudgeClient, JUDGE_RPC_QUEUE } = await import('./judgeClient.service.js');

describe('judgeFetch (M1)', () => {
  const realFetch = global.fetch;
  beforeEach(() => {
    _resetJudgeClient();
    sent.length = 0;
    consumerCount = 1;
    replyStatus = 200;
    brokerDown = false;
    delete process.env.JUDGE_RPC;
    global.fetch = vi.fn(async () => new Response('{"status":"via http"}', { status: 200 }));
  });
  afterEach(() => { global.fetch = realFetch; });

  it('sends the request over the queue when a judge consumes it, and returns its reply', async () => {
    const res = await judgeFetch('/run', { body: '{"code":"x"}', timeoutMs: 2000 });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: 'Accepted' });
    expect(sent).toHaveLength(1);
    expect(sent[0].queue).toBe(JUDGE_RPC_QUEUE);
    expect(sent[0].request).toEqual({ path: '/run', body: '{"code":"x"}' });
    expect(sent[0].props.replyTo).toBe('amq.rabbitmq.reply-to');
    expect(sent[0].props.expiration).toBe('2000');
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('uses HTTP when no judge consumes the queue yet (an older judge)', async () => {
    consumerCount = 0;
    const res = await judgeFetch('/raw-run', { body: '{}' });
    expect(await res.json()).toEqual({ status: 'via http' });
    expect(sent).toHaveLength(0);
    expect(global.fetch.mock.calls[0][0]).toMatch(/\/raw-run$/);
  });

  it('uses HTTP when RabbitMQ is unreachable or JUDGE_RPC=off', async () => {
    brokerDown = true;
    expect(await (await judgeFetch('/run', { body: '{}' })).json()).toEqual({ status: 'via http' });
    brokerDown = false;
    _resetJudgeClient();
    process.env.JUDGE_RPC = 'off';
    expect(await (await judgeFetch('/run', { body: '{}' })).json()).toEqual({ status: 'via http' });
    expect(sent).toHaveLength(0);
  });

  it('tries HTTP when the queued judge had no free container (503)', async () => {
    replyStatus = 503;
    const res = await judgeFetch('/run', { body: '{}' });
    expect(sent).toHaveLength(1);
    expect(await res.json()).toEqual({ status: 'via http' });
  });

  it('passes other judge errors through unchanged', async () => {
    replyStatus = 400;
    const res = await judgeFetch('/run', { body: '{}' });
    expect(res.ok).toBe(false);
    expect(res.status).toBe(400);
    expect(global.fetch).not.toHaveBeenCalled();
  });
});
