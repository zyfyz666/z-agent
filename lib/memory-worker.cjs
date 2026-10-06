'use strict';

const fs = require('node:fs');
const { executeMemoryOperation } = require('./memory-database');

try {
  const request = JSON.parse(fs.readFileSync(0, 'utf8'), (_key, value) => (
    value && Array.isArray(value.__memorySet) ? new Set(value.__memorySet) : value
  ));
  const result = executeMemoryOperation(request.dbPath, request.operation, request.args, request.options);
  process.stdout.write(JSON.stringify({ ok: true, result }));
} catch (error) {
  process.stdout.write(JSON.stringify({ ok: false, error: error.message, code: error.code }));
  process.exitCode = 1;
}
