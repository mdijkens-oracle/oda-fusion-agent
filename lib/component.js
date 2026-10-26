'use strict';
const client = require('./client');
const { inputs } = require('./inputs');

function component(operation, properties, actions, service = client) {
  return {
    metadata: () => ({ name: `mdFusionAgent.${operation}`, properties, supportedActions: actions }),
    invoke: async context => {
      let p;
      let stage = 'input';
      const log = message => {
        try { if (context.logger) context.logger().info(`[mdFusionAgent ${operation}] ${message}`); } catch { /* Logging is optional. */ }
      };
      log(`started; Node ${process.version}`);
      try {
        p = context.properties();
        if (!p || typeof p.resultVariable !== 'string' || !/^[A-Za-z_][A-Za-z0-9_.]*$/.test(p.resultVariable)) {
          log('invalid resultVariable: expected a literal variable name, not an expression or value');
          context.reply('mdFusionAgent: vul bij resultVariable de variabelenaam als tekst in, bijvoorbeeld skill.result (zonder ${...}).');
          context.keepTurn(true);
          context.transition('failure');
          return;
        }
        stage = 'clear-result';
        context.variable(p.resultVariable, null);
        stage = 'input';
        const input = inputs(p);
        stage = 'fusion-call';
        log('calling Fusion');
        const result = await service[operation](input);
        stage = 'write-result';
        context.variable(p.resultVariable, result);
        log(operation === 'getToken' ? 'token ready (value hidden)' : `completed with status ${result.status}`);
        stage = 'transition';
        context.keepTurn(true);
        context.transition(operation === 'getToken' || result.status === 'COMPLETE' ? 'success' : 'pending');
      } catch (error) {
        // Do not log raw exceptions, inputs, credentials, tokens or provider bodies.
        log(`failed; stage=${stage}; code=${error.safeMessage ? error.code : 'COMPONENT_ERROR'}; httpStatus=${error.statusCode || 'none'}`);
        const failure = { error: {
          code: error.code || 'FUSION_ERROR', message: error.safeMessage || 'Fusion call failed.', httpStatus: error.statusCode || null
        } };
        failure.error.stage = stage;
        try {
          if (!p || typeof p.resultVariable !== 'string') throw new Error('Missing variable name');
          context.variable(p.resultVariable, failure);
        } catch {
          log('cannot write resultVariable; check variable name and Map type');
          context.reply('mdFusionAgent: kan de resultaatvariabele niet schrijven. Controleer de variabelenaam en het type Map.');
        }
        context.keepTurn(true);
        context.transition('failure');
      }
    }
  };
}

module.exports = { component };
