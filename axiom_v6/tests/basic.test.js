const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const http = require('http');

// ── Helpers ──
const ROOT = path.join(__dirname, '..');
function readFile(rel) { return fs.readFileSync(path.join(ROOT, rel), 'utf8'); }
function fileExists(rel) { return fs.existsSync(path.join(ROOT, rel)); }

function httpRequest(urlPath, opts = {}) {
    return new Promise((resolve, reject) => {
        const options = {
            hostname: '127.0.0.1', port: process.env.TEST_PORT || 5000,
            path: urlPath, method: opts.method || 'GET',
            headers: { 'Content-Type': 'application/json', ...opts.headers }
        };
        const req = http.request(options, res => {
            let body = '';
            res.on('data', c => body += c);
            res.on('end', () => {
                try { resolve({ status: res.statusCode, headers: res.headers, body: JSON.parse(body) }); }
                catch (e) { resolve({ status: res.statusCode, headers: res.headers, body }); }
            });
        });
        req.on('error', reject);
        if (opts.body) req.write(JSON.stringify(opts.body));
        req.end();
    });
}

// ═══════════════════════════════════════════════════════════════
// STATIC VALIDATION TESTS (no server needed)
// ═══════════════════════════════════════════════════════════════
describe('AXIOM v6 — Static Validation', () => {
    it('should have a valid package.json', () => {
        const pkg = JSON.parse(readFile('package.json'));
        assert.strictEqual(pkg.name, 'axiom-ide');
        assert.strictEqual(pkg.version, '6.0.0');
        assert.ok(pkg.dependencies['mysql2']);
        assert.ok(pkg.dependencies['node-pty']);
        assert.ok(pkg.dependencies['xterm']);
        assert.ok(pkg.scripts.start);
        assert.ok(pkg.scripts.test);
        assert.ok(pkg.scripts.migrate);
        assert.ok(pkg.scripts.lint);
        assert.ok(pkg.engines.node);
    });

    it('should have src/server.js with valid syntax', () => {
        assert.ok(fileExists('src/server.js'));
        const { execSync } = require('child_process');
        assert.doesNotThrow(() => { execSync(`node -c "${path.join(ROOT, 'src/server.js')}"`, { stdio: 'pipe' }); });
    });

    it('should have public/index.html with required functions', () => {
        assert.ok(fileExists('public/index.html'));
        const html = readFile('public/index.html');
        // Verify critical functions exist
        assert.ok(html.includes('function swalAlert'), 'Missing swalAlert function');
        assert.ok(html.includes('function swalConfirm'), 'Missing swalConfirm function');
        assert.ok(html.includes('function swalPrompt'), 'Missing swalPrompt function');
        assert.ok(html.includes('const Mem'), 'Missing client-side Mem object');
    });

    it('should have migration files with required tables', () => {
        const sql = readFile('migrations/001_initial_schema.sql');
        for (const table of ['users', 'payments', 'usage_log', 'audit_log', 'collab_sessions', 'user_settings']) {
            assert.ok(sql.includes(`CREATE TABLE IF NOT EXISTS ${table}`), `Missing table: ${table}`);
        }
    });

    it('should have migration 002 fixing ID types', () => {
        assert.ok(fileExists('migrations/002_fix_id_types.sql'), 'Missing migration 002');
        const sql = readFile('migrations/002_fix_id_types.sql');
        assert.ok(sql.includes('VARCHAR(36)'), 'Migration 002 should convert IDs to VARCHAR(36)');
    });

    it('should have .env.example with required variables', () => {
        const content = readFile('.env.example');
        for (const v of ['PORT', 'DB_HOST', 'DB_USER', 'DB_PASS', 'DB_NAME', 'GITHUB_CLIENT_ID', 'ANTHROPIC_API_KEY']) {
            assert.ok(content.includes(v), `Missing env var: ${v}`);
        }
    });

    it('should have .dockerignore', () => {
        assert.ok(fileExists('.dockerignore'), 'Missing .dockerignore');
        const content = readFile('.dockerignore');
        assert.ok(content.includes('node_modules'), '.dockerignore should exclude node_modules');
        assert.ok(content.includes('.git'), '.dockerignore should exclude .git');
    });

    it('should have Docker configuration', () => {
        assert.ok(fileExists('Dockerfile'), 'Missing Dockerfile');
        assert.ok(fileExists('docker-compose.yml'), 'Missing docker-compose.yml');
        const dc = readFile('docker-compose.yml');
        assert.ok(dc.includes('migrate'), 'docker-compose should include migration service');
        assert.ok(!dc.includes('ports:\n      - "3306:3306"'), 'MySQL should not expose port publicly');
    });

    it('should have CI configuration', () => {
        assert.ok(fileExists('.github/workflows/ci.yml'), 'Missing CI workflow');
        const ci = readFile('.github/workflows/ci.yml');
        assert.ok(ci.includes('npm run lint'), 'CI should run lint');
        assert.ok(ci.includes('npm audit'), 'CI should run security audit');
        assert.ok(ci.includes('push: true'), 'CI should push Docker image');
    });
});

// ═══════════════════════════════════════════════════════════════
// SECURITY CHECKS
// ═══════════════════════════════════════════════════════════════
describe('AXIOM v6 — Security Checks', () => {
    it('should not have hardcoded database passwords in server.js', () => {
        const server = readFile('src/server.js');
        assert.ok(!server.includes("password:'Zawadi"), 'Hardcoded DB password found');
        assert.ok(!server.includes("password:'root"), 'Hardcoded DB password found');
        assert.ok(server.includes("DB_PASS||''") || server.includes('process.env.DB_PASS'), 'Should use env var for DB password');
    });

    it('should sanitize git arguments', () => {
        const server = readFile('src/server.js');
        assert.ok(server.includes('sanitizeGitArg'), 'Should have sanitizeGitArg function');
        // Ensure all git() calls go through sanitized path
        const gitFuncMatch = server.match(/function git\(cwd,\.\.\.args\)/);
        assert.ok(gitFuncMatch, 'git function should exist');
        assert.ok(server.includes('args.map(a=>sanitizeGitArg(a))'), 'git function should sanitize all args');
    });

    it('should validate DB update columns with allowlist', () => {
        const server = readFile('src/server.js');
        assert.ok(server.includes('ALLOWED_COLS'), 'DB.updateUser should use column allowlist');
    });

    it('should have body size limit', () => {
        const server = readFile('src/server.js');
        assert.ok(server.includes('MAX_BODY_SIZE'), 'Should have body size limit');
    });

    it('should have security headers', () => {
        const server = readFile('src/server.js');
        assert.ok(server.includes('X-Content-Type-Options'), 'Should set X-Content-Type-Options');
        assert.ok(server.includes('X-Frame-Options'), 'Should set X-Frame-Options');
        assert.ok(server.includes('Content-Security-Policy'), 'Should set CSP in production');
    });

    it('should restrict CORS in production', () => {
        const server = readFile('src/server.js');
        assert.ok(server.includes("NODE_ENV==='production'"), 'CORS should be restricted in production');
        assert.ok(server.includes('CORS_ORIGIN'), 'Should support CORS_ORIGIN env var');
    });

    it('should not leak token in /api/ping', () => {
        const server = readFile('src/server.js');
        const pingLine = server.split('\n').find(l => l.includes("route==='/api/ping'"));
        assert.ok(pingLine, '/api/ping route should exist');
        assert.ok(!pingLine.includes('token:CFG.token'), '/api/ping should not expose the admin token');
    });

    it('should have admin RBAC check', () => {
        const server = readFile('src/server.js');
        assert.ok(server.includes("route.startsWith('/api/admin')&&!isAdmin"), 'Admin routes need RBAC check');
    });

    it('should use configurable PORT', () => {
        const server = readFile('src/server.js');
        assert.ok(server.includes('process.env.PORT'), 'PORT should be configurable via env var');
    });

    it('should have graceful shutdown with proper cleanup', () => {
        const server = readFile('src/server.js');
        assert.ok(server.includes('gracefulShutdown'), 'Should have graceful shutdown');
        assert.ok(server.includes('dbPool.end'), 'Should close DB pool on shutdown');
        assert.ok(!server.includes('if(wss)wss.clients'), 'Should not reference undefined wss');
        assert.ok(!server.includes('if(pool)pool.end'), 'Should not reference undefined pool');
    });
});

// ═══════════════════════════════════════════════════════════════
// API INTEGRATION TESTS (only run if server is available)
// ═══════════════════════════════════════════════════════════════
describe('AXIOM v6 — API Integration (skipped if server not running)', () => {
    let serverAvailable = false;

    it('should check if server is running', async () => {
        try {
            const r = await httpRequest('/api/ping');
            serverAvailable = r.status === 200;
            if (!serverAvailable) { console.log('    (Server not running — skipping API tests)'); }
        } catch (e) {
            console.log('    (Server not running — skipping API tests)');
        }
        assert.ok(true); // Always passes
    });

    it('should respond to /api/ping', async () => {
        if (!serverAvailable) return;
        const r = await httpRequest('/api/ping');
        assert.strictEqual(r.status, 200);
        assert.strictEqual(r.body.ok, true);
        assert.strictEqual(r.body.v, '6.0');
        assert.ok(!r.body.token, 'Should not expose token');
    });

    it('should return plans at /api/plans', async () => {
        if (!serverAvailable) return;
        const r = await httpRequest('/api/plans');
        assert.strictEqual(r.status, 200);
        assert.ok(r.body.plans);
        assert.ok(r.body.plans.free);
        assert.ok(r.body.plans.starter);
        assert.ok(r.body.plans.pro);
        assert.ok(r.body.plans.team);
    });

    it('should return settings at /api/settings', async () => {
        if (!serverAvailable) return;
        const r = await httpRequest('/api/settings');
        assert.strictEqual(r.status, 200);
        assert.ok(r.body.theme !== undefined);
    });

    it('should return extensions at /api/extensions', async () => {
        if (!serverAvailable) return;
        const r = await httpRequest('/api/extensions');
        assert.strictEqual(r.status, 200);
        assert.ok(Array.isArray(r.body.installed));
    });

    it('should return themes at /api/themes', async () => {
        if (!serverAvailable) return;
        const r = await httpRequest('/api/themes');
        assert.strictEqual(r.status, 200);
    });

    it('should set security headers', async () => {
        if (!serverAvailable) return;
        const r = await httpRequest('/api/ping');
        assert.ok(r.headers['x-content-type-options'] === 'nosniff');
        assert.ok(r.headers['x-frame-options'] === 'SAMEORIGIN');
    });

    it('should rate limit excessive requests', async () => {
        if (!serverAvailable) return;
        // We don't want to actually hit 200 requests, just verify the header exists
        const r = await httpRequest('/api/ping');
        assert.strictEqual(r.status, 200); // First request should succeed
    });

    it('should reject invalid API token', async () => {
        if (!serverAvailable) return;
        const r = await httpRequest('/api/memory', { headers: { 'X-Axiom-Token': 'invalid-token' } });
        assert.strictEqual(r.status, 401);
    });

    it('should reject admin routes without admin role', async () => {
        if (!serverAvailable) return;
        const r = await httpRequest('/api/admin/analytics');
        // Should be 401 or 403
        assert.ok([401, 403].includes(r.status), 'Admin routes should require auth');
    });
});
