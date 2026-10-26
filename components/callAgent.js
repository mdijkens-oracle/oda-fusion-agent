'use strict';
const { component } = require('../lib/component');
module.exports = component('callAgent', {
  connection: { type: 'map', required: true },
  workflow: { type: 'string', required: true },
  resultVariable: { type: 'string', required: true },
  message: { type: 'string', required: false },
  options: { type: 'map', required: false }
}, ['success', 'pending', 'failure']);
