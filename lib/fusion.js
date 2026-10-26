'use strict';
const https = require('node:https');
const crypto = require('node:crypto');

function fault(code, message, statusCode) {
  return Object.assign(new Error(message), { code, safeMessage: message, statusCode });
}

// Never propagate provider response bodies, which can contain credentials/tokens.
function requestJson(url, method, headers, body, timeoutMs) {
  return new Promise((resolve, reject) => {
    const text = body === undefined ? undefined : JSON.stringify(body);
    const req = https.request(url, { method, headers: {
      Accept: 'application/json', ...headers,
      ...(text === undefined ? {} : { 'Content-Length': Buffer.byteLength(text) })
    } }, res => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', chunk => {
        data += chunk;
        if (data.length > 2 * 1024 * 1024) {
          req.destroy(fault('RESPONSE_TOO_LARGE', 'Fusion response exceeded the size limit.'));
        }
      });
      res.on('error', () => reject(fault('NETWORK_ERROR', 'Fusion response could not be read.')));
      res.on('end', () => {
        if (res.statusCode < 200 || res.statusCode >= 300) {
          return reject(fault('HTTP_ERROR', `Fusion returned HTTP ${res.statusCode}.`, res.statusCode));
        }
        try { resolve(JSON.parse(data)); }
        catch { reject(fault('INVALID_JSON', 'Fusion did not return valid JSON.')); }
      });
    });
    const timer = setTimeout(() => req.destroy(fault('REQUEST_TIMEOUT', 'Fusion request timed out.')), timeoutMs);
    req.on('close', () => clearTimeout(timer));
    req.on('error', error => reject(error.safeMessage ? error : fault('NETWORK_ERROR', 'Fusion could not be reached.')));
    req.end(text);
  });
}

function expiry(token) {
  try {
    const exp = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8')).exp;
    return typeof exp === 'number' && Number.isFinite(exp) ? exp * 1000 : null;
  } catch { return null; }
}

function deriveScope(hostname) {
  let pod;
  const demo = /^fa-(.+)-saasfademo\d+\.ds-fa\.oraclepdemos\.com$/i.exec(hostname);
  if (demo) pod = demo[1];
  else if (/^[^.]+\.fa\./i.test(hostname)) pod = hostname.split('.')[0];
  if (!pod) throw fault('CONFIG_ERROR', 'Cannot derive scope from this hostname; supply scope explicitly.');
  return `urn:opc:resource:fusion:${pod}:fusion-ai/`;
}

function normalizeAuth(input) {
  for (const key of ['baseUrl']) {
    if (typeof input[key] !== 'string' || !input[key].trim()) throw fault('CONFIG_ERROR', `Missing ${key}.`);
  }
  let url;
  try { url = new URL(input.baseUrl); } catch { throw fault('CONFIG_ERROR', 'Invalid baseUrl.'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || !['', '/'].includes(url.pathname)) {
    throw fault('CONFIG_ERROR', 'baseUrl must be an HTTPS origin without a path, credentials or query.');
  }
  const scope = input.scope || deriveScope(url.hostname);
  for (const key of ['username', 'password']) {
    if (typeof input[key] !== 'string' || !input[key].trim()) throw fault('CONFIG_ERROR', `Missing ${key}.`);
  }
  return { ...input, scope, baseUrl: url.origin };
}

function normalize(input) {
  const auth = normalizeAuth(input);
  if (typeof input.workflow !== 'string' || !input.workflow.trim()) throw fault('CONFIG_ERROR', 'Missing workflow.');
  let parameters = {};
  try { parameters = input.parameters ? (typeof input.parameters === 'string' ? JSON.parse(input.parameters) : input.parameters) : {}; }
  catch { throw fault('CONFIG_ERROR', 'parameters must contain a JSON object.'); }
  if (!parameters || Array.isArray(parameters) || typeof parameters !== 'object') {
    throw fault('CONFIG_ERROR', 'parameters must contain a JSON object.');
  }
  if (!input.jobId && (typeof input.message !== 'string' || !input.message.trim())) {
    throw fault('CONFIG_ERROR', 'message is required when starting a workflow.');
  }
  const waitSeconds = input.waitSeconds === undefined ? 15 : Number(input.waitSeconds);
  if (!Number.isFinite(waitSeconds) || waitSeconds < 0 || waitSeconds > 20) {
    throw fault('CONFIG_ERROR', 'waitSeconds must be between 0 and 20.');
  }
  return { ...auth, parameters, waitSeconds };
}

function createClient({ transport = requestJson, now = Date.now, sleep = ms => new Promise(r => setTimeout(r, ms)) } = {}) {
  const cache = new Map();
  const pending = new Map();
  const keyFor = c => crypto.createHash('sha256').update(JSON.stringify([c.baseUrl, c.scope, c.username, c.password])).digest('hex');
  async function token(c, deadline, rejectedToken) {
    const key = keyFor(c);
    const cached = cache.get(key);
    if (rejectedToken && cached && cached.value === rejectedToken) cache.delete(key);
    const current = cache.get(key);
    if (current && current.reuseUntil > now()) return current.value;
    if (pending.has(key)) return pending.get(key);
    cache.delete(key);
    const operation = (async () => {
      const response = await transport(c.baseUrl + '/crmRestApi/resources/latest/actionplans/action/getProcessAccessToken', 'POST', {
        Authorization: 'Basic ' + Buffer.from(c.username + ':' + c.password, 'utf8').toString('base64'),
        'Content-Type': 'application/vnd.oracle.adf.action+json', 'Override-Scope': c.scope
      }, {}, remaining(deadline));
      if (typeof response.result !== 'string' || !response.result.trim()) {
        throw fault('TOKEN_RESPONSE_ERROR', 'Fusion token response did not contain a result string.');
      }
      const expiresAt = expiry(response.result);
      // JWT decoding only schedules renewal; Fusion verifies the token signature.
      if (expiresAt && expiresAt > now()) {
        const margin = Math.min(60000, (expiresAt - now()) / 10);
        if (cache.size >= 100) cache.delete(cache.keys().next().value);
        cache.set(key, { value: response.result, reuseUntil: expiresAt - margin });
      }
      return response.result;
    })();
    pending.set(key, operation);
    try { return await operation; } finally { pending.delete(key); }
  }
  function remaining(deadline) {
    const ms = deadline - now();
    if (ms <= 0) throw fault('REQUEST_TIMEOUT', 'Fusion request deadline exceeded.');
    return Math.min(10000, ms);
  }
  async function call(c, path, method, body, deadline) {
    let bearer = await token(c, deadline);
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        return await transport(path, method, { Authorization: 'Bearer ' + bearer, 'Content-Type': 'application/json' }, body, remaining(deadline));
      } catch (error) {
        if (error.statusCode !== 401 || attempt === 1 || !c.username || !c.password) throw error;
        bearer = await token(c, deadline, bearer);
      }
    }
  }
  async function invoke(input) {
    const c = normalize(input);
    const deadline = now() + 25000;
    const agent = c.baseUrl + '/api/fusion-ai/orchestrator/agent/v2/' + encodeURIComponent(c.workflow);
    let job;
    if (c.jobId) {
      job = await call(c, agent + '/status/' + encodeURIComponent(c.jobId), 'GET', undefined, deadline);
    } else {
      const body = { message: c.message, parameters: c.parameters, streamOutput: false };
      if (c.conversationId) body.conversationId = c.conversationId;
      job = await call(c, agent + '/invokeAsync', 'POST', body, deadline);
    }
    const jobId = job.jobId || c.jobId;
    if (typeof jobId !== 'string' || !jobId) throw fault('JOB_RESPONSE_ERROR', 'Fusion response did not contain a jobId.');
    const conversationId = job.conversationId || c.conversationId || null;
    const waitUntil = Math.min(now() + c.waitSeconds * 1000, deadline - 1500);
    while (true) {
      const status = String(job.status || '').toUpperCase();
      if (status === 'COMPLETE') {
        if (job.error) throw fault('WORKFLOW_FAILED', 'Fusion reported a workflow error.');
        return { output: job.output == null ? '' : String(job.output), status, jobId,
          conversationId: job.conversationId || conversationId, workflow: c.workflow };
      }
      if (['FAILED', 'FAILURE', 'ERROR', 'CANCELLED', 'CANCELED'].includes(status) || job.error) {
        throw fault('WORKFLOW_FAILED', 'Fusion workflow did not complete successfully.');
      }
      if (!status) throw fault('JOB_RESPONSE_ERROR', 'Fusion response did not contain a status.');
      if (now() + 1000 >= waitUntil) {
        return { output: null, status, jobId, conversationId: job.conversationId || conversationId, workflow: c.workflow };
      }
      await sleep(1000);
      job = await call(c, agent + '/status/' + encodeURIComponent(jobId), 'GET', undefined, deadline);
    }
  }
  async function getToken(input) {
    const c = normalizeAuth(input);
    const value = await token(c, now() + 10000);
    const expiresAt = expiry(value);
    return { token: value, expiresAt: expiresAt ? new Date(expiresAt).toISOString() : null, scope: c.scope };
  }
  return { callAgent: invoke, getToken };
}

module.exports = { createClient, deriveScope, expiry, requestJson };
