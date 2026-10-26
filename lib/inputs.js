'use strict';

function object(value, name, optional = false) {
  if (optional && (value === undefined || value === null || value === '')) return {};
  try {
    const parsed = typeof value === 'string' ? JSON.parse(value) : value;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
  } catch { /* Never include raw configuration in errors. */ }
  throw Object.assign(new Error(`${name} must be a JSON object or Map.`), {
    code: 'CONFIG_ERROR', safeMessage: `${name} must be a JSON object or Map.`
  });
}

function inputs(p) {
  const c = object(p.connection, 'connection');
  const o = object(p.options, 'options', true);
  return {
    baseUrl: c.baseUrl, username: c.username, password: c.password,
    scope: o.scope || c.scope,
    workflow: p.workflow, message: p.message,
    parameters: o.parameters, conversationId: o.conversationId,
    jobId: o.jobId, waitSeconds: o.waitSeconds
  };
}

module.exports = { inputs };
