const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

describe('AXIOM v6 — Basic Tests', () => {
    it('should have a valid package.json', () => {
        const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
        assert.strictEqual(pkg.name, 'axiom-ide');
        assert.strictEqual(pkg.version, '6.0.0');
        assert.ok(pkg.dependencies['mysql2']);
        assert.ok(pkg.dependencies['node-pty']);
        assert.ok(pkg.dependencies['xterm']);
    });

    it('should have src/server.js with valid syntax', () => {
        const serverPath = path.join(__dirname, '..', 'src', 'server.js');
        assert.ok(fs.existsSync(serverPath));
        const { execSync } = require('child_process');
        assert.doesNotThrow(() => { execSync(`node -c "${serverPath}"`, { stdio: 'pipe' }); });
    });

    it('should have public/index.html', () => {
        assert.ok(fs.existsSync(path.join(__dirname, '..', 'public', 'index.html')));
    });

    it('should have migration files with required tables', () => {
        const sql = fs.readFileSync(path.join(__dirname, '..', 'migrations', '001_initial_schema.sql'), 'utf8');
        for (const table of ['users', 'payments', 'usage_log', 'audit_log', 'collab_sessions', 'user_settings']) {
            assert.ok(sql.includes(`CREATE TABLE IF NOT EXISTS ${table}`), `Missing table: ${table}`);
        }
    });

    it('should have .env.example with required variables', () => {
        const content = fs.readFileSync(path.join(__dirname, '..', '.env.example'), 'utf8');
        for (const v of ['PORT', 'DB_HOST', 'DB_USER', 'DB_PASS', 'DB_NAME', 'GITHUB_CLIENT_ID', 'ANTHROPIC_API_KEY']) {
            assert.ok(content.includes(v), `Missing env var: ${v}`);
        }
    });
});
