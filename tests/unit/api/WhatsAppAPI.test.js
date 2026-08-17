'use strict';

jest.mock('axios');

const axios = require('axios');
const WhatsAppAPI = require('../../../src/api/WhatsAppAPI');

describe('WhatsAppAPI — per-recipient pair-rate-limit pacing', () => {
  const OLD_ENV = process.env;

  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers();
    process.env = { ...OLD_ENV };
    axios.post.mockResolvedValue({ data: { messages: [{ id: 'wamid.1' }] } });
  });

  afterEach(() => {
    jest.useRealTimers();
    process.env = OLD_ENV;
  });

  // Helper: run a promise-returning call while advancing fake timers so any
  // internal setTimeout-based wait resolves without a real-time sleep.
  async function runWithTimers(promise) {
    let settled = false;
    promise.finally(() => { settled = true; });
    // Flush microtasks + advance timers repeatedly until the promise settles.
    for (let i = 0; i < 50 && !settled; i++) {
      await Promise.resolve();
      jest.advanceTimersByTime(1000);
    }
    return promise;
  }

  test('defaults to a 2000ms minimum interval when WHATSAPP_MIN_SEND_INTERVAL_MS is unset', () => {
    delete process.env.WHATSAPP_MIN_SEND_INTERVAL_MS;
    const api = new WhatsAppAPI();
    expect(api.minSendIntervalMs).toBe(2000);
  });

  test('is configurable via WHATSAPP_MIN_SEND_INTERVAL_MS', () => {
    process.env.WHATSAPP_MIN_SEND_INTERVAL_MS = '500';
    const api = new WhatsAppAPI();
    expect(api.minSendIntervalMs).toBe(500);
  });

  test('a second send to the SAME recipient waits out the remaining interval before calling the API', async () => {
    process.env.WHATSAPP_MIN_SEND_INTERVAL_MS = '2000';
    const api = new WhatsAppAPI();

    await api.sendTextMessage('85290000001', 'first');
    expect(axios.post).toHaveBeenCalledTimes(1);

    const second = api.sendTextMessage('85290000001', 'second');
    // Not yet resolved immediately — still waiting out the pacing delay.
    await Promise.resolve();
    expect(axios.post).toHaveBeenCalledTimes(1);

    await runWithTimers(second);
    expect(axios.post).toHaveBeenCalledTimes(2);
  });

  test('sends to DIFFERENT recipients are never paced against each other', async () => {
    process.env.WHATSAPP_MIN_SEND_INTERVAL_MS = '2000';
    const api = new WhatsAppAPI();

    await api.sendTextMessage('85290000001', 'to A');
    await api.sendTextMessage('85290000002', 'to B'); // different recipient — no wait
    expect(axios.post).toHaveBeenCalledTimes(2);
  });

  test('the two legs of a text-then-interactive reply to the same recipient are paced apart (the observed 467ms-gap failure)', async () => {
    process.env.WHATSAPP_MIN_SEND_INTERVAL_MS = '2000';
    const api = new WhatsAppAPI();

    await api.sendTextMessage('85290000001', 'booking confirmed');
    const interactivePromise = api.sendInteractive('85290000001', { type: 'button', body: { text: 'Main menu' } });
    await Promise.resolve();
    expect(axios.post).toHaveBeenCalledTimes(1); // interactive leg is still being paced

    await runWithTimers(interactivePromise);
    expect(axios.post).toHaveBeenCalledTimes(2);
  });

  test('a value of 0 disables pacing entirely (no wait, immediate consecutive sends)', async () => {
    process.env.WHATSAPP_MIN_SEND_INTERVAL_MS = '0';
    const api = new WhatsAppAPI();

    await api.sendTextMessage('85290000001', 'first');
    await api.sendTextMessage('85290000001', 'second');
    expect(axios.post).toHaveBeenCalledTimes(2);
  });
});
