import { vi } from 'vitest';

vi.mock('redis', () => ({
  createClient: vi.fn(() => ({
    on: vi.fn(),
    connect: vi.fn().mockResolvedValue(true),
    get: vi.fn().mockResolvedValue(null),
    set: vi.fn().mockResolvedValue('OK'),
    isOpen: true,
    ping: vi.fn().mockResolvedValue('PONG'),
  })),
}));

vi.mock('amqplib', () => {
  const mockChannel = {
    assertExchange: vi.fn().mockResolvedValue({}),
    assertQueue: vi.fn().mockResolvedValue({}),
    bindQueue: vi.fn().mockResolvedValue({}),
    // Confirm-channel publish: the callback reports the broker ack.
    sendToQueue: vi.fn((queue, body, options, cb) => { cb?.(null); return true; }),
    close: vi.fn().mockResolvedValue(undefined),
    on: vi.fn(),
    connection: {},
  };
  const mockConnection = {
    createChannel: vi.fn().mockResolvedValue(mockChannel),
    createConfirmChannel: vi.fn().mockResolvedValue(mockChannel),
    close: vi.fn(),
    on: vi.fn(),
  };
  return {
    default: {
      connect: vi.fn().mockResolvedValue(mockConnection),
    },
  };
});

// A judge /run that accepts everything: one passing result per test it was sent, with the
// expected value as the output (the reference solution "agrees" with every test).
global.fetch = vi.fn().mockImplementation(async (_url, init = {}) => {
  let tests = [];
  try {
    tests = JSON.parse(init.body || '{}').tests || [];
  } catch {
    tests = [];
  }
  return {
    ok: true,
    json: async () => ({
      schemaValid: true,
      typeValidation: true,
      wrapperGeneration: true,
      referenceSolutionPassed: true,
      errors: [],
      status: 'Accepted',
      passedCount: tests.length || 1,
      totalCount: tests.length || 1,
      details: tests.map((t, i) => ({ test: i + 1, passed: true, output: t.expected }))
    }),
  };
});
