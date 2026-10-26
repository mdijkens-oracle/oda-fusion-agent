'use strict';
const { component } = require('../lib/component');
module.exports = component('getToken', {
  connection: { type: 'map', required: true },
  resultVariable: { type: 'string', required: true }
}, ['success', 'failure']);
