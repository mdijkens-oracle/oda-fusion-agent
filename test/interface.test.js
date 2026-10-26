'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createClient, deriveScope } = require('../lib/fusion');
const { callAgent, getToken } = require('../lib/client');
const callComponent = require('../components/callAgent');
const tokenComponent = require('../components/getToken');
const config = { baseUrl: 'https://fa-yourpod-saasfademo1.ds-fa.oraclepdemos.com', username: 'demo', password: 'demo-password' };

test('derives the tested demo scope and standard pod scope; custom URLs need an override', () => {
  assert.equal(deriveScope(new URL(config.baseUrl).hostname), 'urn:opc:resource:fusion:yourpod:fusion-ai/');
  assert.equal(deriveScope('mypod-test.fa.em2.oraclecloud.com'), 'urn:opc:resource:fusion:mypod-test:fusion-ai/');
  assert.throws(() => deriveScope('custom.example.com'), /supply scope explicitly/);
});

test('getToken and callAgent share cached tokens, including explicit equivalent scope', async () => {
  let issued = 0;
  let capturedScope;
  const value = 'h.' + Buffer.from(JSON.stringify({ exp: Date.now() / 1000 + 3600 })).toString('base64url') + '.s';
  const client = createClient({ transport: async (url, method, headers) => {
    if (url.endsWith('getProcessAccessToken')) { issued++; capturedScope = headers['Override-Scope']; return { result: value }; }
    return { status: 'COMPLETE', jobId: 'job', output: 'OK' };
  } });
  const token = await client.getToken(config);
  assert.equal(token.token, value);
  assert.equal(token.scope, 'urn:opc:resource:fusion:yourpod:fusion-ai/');
  assert.ok(Date.parse(token.expiresAt) > Date.now());
  await client.callAgent({ ...config, workflow: 'DEMO', message: 'hello', parameters: '{"test":true}' });
  await client.getToken({ ...config, scope: token.scope });
  assert.equal(capturedScope, token.scope);
  assert.equal(issued, 1);
});

test('metadata lists required properties first and uses the requested public names', () => {
  for (const component of [callComponent, tokenComponent]) {
    let optionalSeen = false;
    for (const property of Object.values(component.metadata().properties)) {
      if (!property.required) optionalSeen = true;
      if (property.required) assert.equal(optionalSeen, false);
    }
  }
  assert.equal(callComponent.metadata().name, 'mdFusionAgent.callAgent');
  assert.equal(tokenComponent.metadata().name, 'mdFusionAgent.getToken');
  assert.equal(typeof callAgent, 'function');
  assert.equal(typeof getToken, 'function');
  assert.equal(callComponent.metadata().properties.options.required, false);
  assert.ok(callComponent.metadata().properties.workflow);
  assert.deepEqual(Object.keys(callComponent.metadata().properties), ['connection', 'workflow', 'resultVariable', 'message', 'options']);
  assert.deepEqual(Object.keys(tokenComponent.metadata().properties), ['connection', 'resultVariable']);
  assert.equal(callComponent.metadata().properties.workflowCode, undefined);
});

test('ODA failure clears stale success output and writes an error to the same Map', async () => {
  const variables = new Map([['result', { output: 'old' }]]);
  let action;
  await callComponent.invoke({
    properties: () => ({ resultVariable: 'result' }),
    variable: (key, value) => variables.set(key, value),
    keepTurn: value => assert.equal(value, true),
    transition: value => { action = value; }
  });
  assert.equal(action, 'failure');
  assert.deepEqual(variables.get('result'), { error: { code: 'CONFIG_ERROR', message: 'connection must be a JSON object or Map.', httpStatus: null, stage: 'input' } });
});

test('null or expression resultVariable returns a readable configuration error instead of HTTP 500', async () => {
  for (const name of [null, undefined, '${skill.result}', {}]) {
    let reply;
    let action;
    await callComponent.invoke({
      properties: () => ({ resultVariable: name }),
      variable: () => { throw new Error('Should not write invalid variable'); },
      reply: text => { reply = text; },
      keepTurn: value => assert.equal(value, true),
      transition: value => { action = value; }
    });
    assert.equal(action, 'failure');
    assert.match(reply, /skill.result/);
  }
});

test('variable-write errors are caught without leaking property values in logs', async () => {
  const logs = [];
  let action;
  let reply;
  await callComponent.invoke({
    properties: () => ({ ...config, password: 'SECRET-MARKER', resultVariable: 'skill.result' }),
    logger: () => ({ info: text => logs.push(text) }),
    variable: () => { throw new Error('SDK variable error with SECRET-MARKER'); },
    reply: text => { reply = text; },
    keepTurn: () => {},
    transition: value => { action = value; }
  });
  assert.equal(action, 'failure');
  assert.match(reply, /Map/);
  assert.ok(logs.some(text => text.includes('stage=clear-result')));
  assert.equal(logs.join('').includes('SECRET-MARKER'), false);
});

