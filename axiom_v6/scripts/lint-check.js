#!/usr/bin/env node
'use strict';
/**
 * AXIOM v6 — Zero-dependency lint checker
 * Checks for common code quality issues without requiring ESLint.
 */
const fs = require('fs');
const path = require('path');

const ERRORS = [];
const WARNINGS = [];
const red = s => `\x1b[31m${s}\x1b[0m`;
const yellow = s => `\x1b[33m${s}\x1b[0m`;
const green = s => `\x1b[32m${s}\x1b[0m`;

function checkFile(filePath, label) {
    const content = fs.readFileSync(filePath, 'utf8');
    const lines = content.split('\n');

    lines.forEach((line, i) => {
        const ln = i + 1;
        // Check for hardcoded passwords/secrets
        if (/password\s*[:=]\s*['"][^'"]{4,}['"]/i.test(line) && !/process\.env|\.env|example|test|mock/i.test(line)) {
            ERRORS.push(`${label}:${ln} Possible hardcoded password`);
        }
        // Check for console.log in production code (warn only)
        if (/\bconsole\.log\b/.test(line) && !filePath.includes('test') && !filePath.includes('migrate')) {
            WARNINGS.push(`${label}:${ln} console.log (consider logInfo/logWarn)`);
        }
        // Check for eval()
        if (/\beval\s*\(/.test(line) && !/test|regex|match|includes|\.test\(|problems\.push|'eval/.test(line)) {
            ERRORS.push(`${label}:${ln} eval() usage detected`);
        }
        // Check for TODO/FIXME
        if (/\/\/\s*(TODO|FIXME|HACK|XXX)\b/.test(line)) {
            WARNINGS.push(`${label}:${ln} ${line.trim().slice(0, 80)}`);
        }
    });
}

// Check server
const serverPath = path.join(__dirname, '..', 'src', 'server.js');
if (fs.existsSync(serverPath)) checkFile(serverPath, 'src/server.js');

// Check migration scripts
const scriptsDir = path.join(__dirname);
fs.readdirSync(scriptsDir).filter(f => f.endsWith('.js') && f !== 'lint-check.js').forEach(f => {
    checkFile(path.join(scriptsDir, f), `scripts/${f}`);
});

console.log('\n  AXIOM v6 — Lint Check\n  ' + '='.repeat(40));

if (ERRORS.length) {
    console.log('\n  ' + red(`${ERRORS.length} error(s):`));
    ERRORS.forEach(e => console.log('    ' + red('✗ ') + e));
}
if (WARNINGS.length) {
    console.log('\n  ' + yellow(`${WARNINGS.length} warning(s):`));
    WARNINGS.slice(0, 20).forEach(w => console.log('    ' + yellow('⚠ ') + w));
    if (WARNINGS.length > 20) console.log(`    ... and ${WARNINGS.length - 20} more`);
}
if (!ERRORS.length && !WARNINGS.length) {
    console.log('\n  ' + green('All checks passed.'));
}

console.log('');
process.exit(ERRORS.length > 0 ? 1 : 0);
