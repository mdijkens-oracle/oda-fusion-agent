'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { inputs } = require('../lib/inputs');
const { component } = require('../lib/component');
const config = { baseUrl: 'https://pod.fa.example.invalid', username: 'demo', password: 'demo-password' };

test('connection and options accept Map objects and equivalent JSON text', () => {
  const options = { parameters: { id: 42 }, conversationId: 'conv', jobId: 'job', waitSeconds: 5, scope: 'custom/' };
  const expected = { ...config, scope: 'custom/', workflow: 'DEMO', message: 'question', ...options };
  for (const stringify of [value => value, JSON.stringify]) {
    const result = inputs({ connection: stringify(config), options: stringify(options), workflow: 'DEMO', message: 'question' });
    assert.deepEqual(result, expected);
  }
});

test('options cannot replace credentials, message, workflow or result destination', () => {
  const result = inputs({ connection: config, workflow: 'DEMO', message: 'question', options: {
    baseUrl: 'https://other.invalid', username: 'other', password: 'other', workflow: 'other', message: 'other', resultVariable: 'other'
  } });
  assert.equal(result.baseUrl, config.baseUrl);
  assert.equal(result.username, config.username);
  assert.equal(result.password, config.password);
  assert.equal(result.workflow, 'DEMO');
  assert.equal(result.message, 'question');
  assert.equal(result.resultVariable, undefined);
});

test('optional options, connection scope, and malformed configuration have clear behavior', () => {
  for (const options of [undefined, null, '']) {
    assert.equal(inputs({ connection: { ...config, scope: 'connection-scope/' }, options }).scope, 'connection-scope/');
  }
  for (const connection of [undefined, null, [], 'bad', '[]']) {
    assert.throws(() => inputs({ connection }), error => error.code === 'CONFIG_ERROR' && !error.message.includes('demo-password'));
  }
  assert.throws(() => inputs({ connection: config, options: 'bad' }), /options must/);
});

test('ODA adapter forwards grouped inputs and writes success, pending and getToken outputs', async () => {
  for (const [operation, status, action] of [['callAgent', 'COMPLETE', 'success'], ['callAgent', 'RUNNING', 'pending'], ['getToken', undefined, 'success']]) {
    const expected = operation === 'getToken' ? { token: 'test-token', expiresAt: null, scope: 'demo/' } : { status, output: status === 'COMPLETE' ? 'OK' : null, jobId: 'job' };
    let captured;
    const service = { [operation]: async value => { captured = value; return expected; } };
    const adapter = component(operation, {}, [], service);
    const variables = new Map();
    let transition;
    await adapter.invoke({
      properties: () => ({ connection: config, workflow: 'DEMO', message: 'hello', options: { parameters: { id: 1 } }, resultVariable: 'skill.result' }),
      variable: (name, value) => variables.set(name, value),
      keepTurn: value => assert.equal(value, true),
      transition: value => { transition = value; }
    });
    assert.deepEqual(variables.get('skill.result'), expected);
    assert.equal(transition, action);
    assert.equal(captured.username, config.username);
    assert.deepEqual(captured.parameters, { id: 1 });
  }
});
