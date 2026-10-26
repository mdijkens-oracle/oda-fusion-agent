'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createClient } = require('../lib/fusion');
const config = { baseUrl: 'https://fusion.example.invalid', scope: 'fusion-ai/', username: 'demo', password: 'demo-password', workflow: 'DEMO', message: 'test' };
const jwt = (exp, id = '') => 'header.' + Buffer.from(JSON.stringify({ exp, id })).toString('base64url') + '.signature';
const complete = { status: 'COMPLETE', jobId: 'job1', conversationId: 'conv1', output: 'اختبار TEST OK' };

test('uses the action media type, passes input, polls, and preserves Unicode output', async () => {
  const calls = [];
  const client = createClient({ transport: async (...args) => {
    calls.push(args);
    if (args[0].endsWith('getProcessAccessToken')) return { result: jwt(Date.now() / 1000 + 3600) };
    if (args[0].endsWith('invokeAsync')) return { status: 'RUNNING', jobId: 'job1', conversationId: 'conv1' };
    return complete;
  }, sleep: async () => {} });
  const result = await client.callAgent({ ...config, conversationId: 'prior', parameters: '{"id":42}' });
  assert.equal(calls[0][2]['Content-Type'], 'application/vnd.oracle.adf.action+json');
  assert.equal(calls[0][2]['Override-Scope'], config.scope);
  assert.equal(calls[0][2].Authorization, 'Basic ' + Buffer.from('demo:demo-password').toString('base64'));
  assert.deepEqual(calls[1][3], { message: 'test', parameters: { id: 42 }, streamOutput: false, conversationId: 'prior' });
  assert.equal(result.output, complete.output);
  assert.equal(result.conversationId, 'conv1');
  assert.equal(JSON.stringify(result).includes('signature'), false);
});

test('reuses tokens, renews before expiry, and isolates password/scope/environment/login', async () => {
  let time = 1700000000000;
  let issued = 0;
  const client = createClient({ now: () => time, transport: async url => {
    if (url.endsWith('getProcessAccessToken')) return { result: jwt(time / 1000 + 100, ++issued) };
    return complete;
  } });
  await client.callAgent(config);
  time += 89000;
  await client.callAgent(config);
  assert.equal(issued, 1);
  time += 2000;
  await client.callAgent(config);
  assert.equal(issued, 2);
  for (const change of [{ password: 'changed' }, { scope: 'other/' }, { baseUrl: 'https://other.example.invalid' }, { username: 'other' }]) {
    await client.callAgent({ ...config, ...change });
  }
  assert.equal(issued, 6);
});

test('concurrent calls share token acquisition', async () => {
  let issued = 0;
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const client = createClient({ transport: async url => {
    if (url.endsWith('getProcessAccessToken')) {
      issued++;
      await gate;
      return { result: jwt(Date.now() / 1000 + 3600) };
    }
    return complete;
  } });
  const first = client.callAgent(config);
  const second = client.callAgent(config);
  release();
  await Promise.all([first, second]);
  assert.equal(issued, 1);
});

test('401 refreshes once, then propagates persistent rejection without an endless retry', async () => {
  let issued = 0;
  let attempts = 0;
  const client = createClient({ transport: async url => {
    if (url.endsWith('getProcessAccessToken')) return { result: jwt(Date.now() / 1000 + 3600, ++issued) };
    attempts++;
    if (attempts === 1 || attempts >= 3) throw Object.assign(new Error('rejected'), { statusCode: 401 });
    return complete;
  } });
  assert.equal((await client.callAgent(config)).status, 'COMPLETE');
  assert.equal(issued, 2);
  await assert.rejects(client.callAgent(config), error => error.statusCode === 401);
  assert.equal(attempts, 4);
  assert.equal(issued, 3);
});

test('pending jobs can resume without invoking a duplicate workflow', async () => {
  let invokes = 0;
  const client = createClient({ transport: async url => {
    if (url.endsWith('getProcessAccessToken')) return { result: jwt(Date.now() / 1000 + 3600) };
    if (url.endsWith('invokeAsync')) { invokes++; return { status: 'RUNNING', jobId: 'job1', conversationId: 'conv1' }; }
    return complete;
  } });
  const pending = await client.callAgent({ ...config, waitSeconds: 0 });
  assert.equal(pending.status, 'RUNNING');
  const result = await client.callAgent({ ...config, message: undefined, jobId: pending.jobId });
  assert.equal(result.status, 'COMPLETE');
  assert.equal(invokes, 1);
});

test('tokens with unknown expiry are not cached, and invalid config makes no network call', async () => {
  let issued = 0;
  const client = createClient({ transport: async url => {
    if (url.endsWith('getProcessAccessToken')) { issued++; return { result: 'opaque' }; }
    return complete;
  } });
  await client.callAgent(config);
  await client.callAgent(config);
  assert.equal(issued, 2);
  await assert.rejects(client.callAgent({ ...config, baseUrl: 'http://fusion.example.invalid' }), /HTTPS/);
  await assert.rejects(client.callAgent({ ...config, parameters: '[]' }), /JSON object/);
  assert.equal(issued, 2);
});

test('Fusion workflow errors and malformed token replies fail explicitly', async () => {
  const client = createClient({ transport: async url => url.endsWith('getProcessAccessToken')
    ? { result: jwt(Date.now() / 1000 + 3600) } : { ...complete, error: { message: 'provider detail' } } });
  await assert.rejects(client.callAgent(config), error => error.code === 'WORKFLOW_FAILED' && !error.message.includes('provider detail'));
  const broken = createClient({ transport: async () => ({ result: null }) });
  await assert.rejects(broken.callAgent(config), error => error.code === 'TOKEN_RESPONSE_ERROR');
});
