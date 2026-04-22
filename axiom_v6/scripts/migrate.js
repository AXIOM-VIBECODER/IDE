#!/usr/bin/env node
'use strict';
const fs = require('fs');
const path = require('path');
const mysql = require('mysql2/promise');

const DB_CONFIG = {
    host: process.env.DB_HOST || 'localhost',
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASS || '',
    database: process.env.DB_NAME || 'axiom',
    multipleStatements: true,
    charset: 'utf8mb4',
};
const MIGRATIONS_DIR = path.join(__dirname, '..', 'migrations');
const MIGRATIONS_TABLE = '_migrations';

function log(msg) { console.log(`  [${new Date().toISOString().slice(11, 19)}] ${msg}`); }
function error(msg) { console.error(`  \x1b[31mERROR:\x1b[0m ${msg}`); }
function success(msg) { console.log(`  \x1b[32m${msg}\x1b[0m`); }
function warn(msg) { console.log(`  \x1b[33m${msg}\x1b[0m`); }

async function ensureMigrationsTable(conn) {
    await conn.query(`CREATE TABLE IF NOT EXISTS \`${MIGRATIONS_TABLE}\` (
        id INT AUTO_INCREMENT PRIMARY KEY, filename VARCHAR(255) NOT NULL UNIQUE,
        checksum VARCHAR(64), executed_at DATETIME DEFAULT CURRENT_TIMESTAMP, duration_ms INT DEFAULT 0
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
}

async function getExecutedMigrations(conn) {
    try { const [rows] = await conn.query(`SELECT filename, checksum, executed_at, duration_ms FROM \`${MIGRATIONS_TABLE}\` ORDER BY filename`); return rows; }
    catch (e) { return []; }
}

function getMigrationFiles() {
    if (!fs.existsSync(MIGRATIONS_DIR)) { error(`Migrations directory not found: ${MIGRATIONS_DIR}`); process.exit(1); }
    return fs.readdirSync(MIGRATIONS_DIR).filter(f => f.endsWith('.sql')).sort();
}

function checksum(content) { return require('crypto').createHash('sha256').update(content).digest('hex').slice(0, 16); }

async function runMigrations(conn) {
    const files = getMigrationFiles();
    const executed = await getExecutedMigrations(conn);
    const executedSet = new Set(executed.map(r => r.filename));
    const pending = files.filter(f => !executedSet.has(f));
    if (pending.length === 0) { success('All migrations are up to date.'); return; }
    log(`Found ${pending.length} pending migration(s):\n`);
    for (const filename of pending) {
        const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, filename), 'utf8').trim();
        if (!sql) { warn(`  Skipping empty: ${filename}`); continue; }
        const hash = checksum(sql); const start = Date.now();
        log(`Running: ${filename} ...`);
        try {
            await conn.query(sql);
            const duration = Date.now() - start;
            await conn.query(`INSERT INTO \`${MIGRATIONS_TABLE}\` (filename, checksum, duration_ms) VALUES (?, ?, ?)`, [filename, hash, duration]);
            success(`  Completed: ${filename} (${duration}ms)`);
        } catch (e) { error(`Failed on ${filename}: ${e.message}`); if (e.sqlMessage) console.error(`  SQL: ${e.sqlMessage}`); process.exit(1); }
    }
    success(`\nAll ${pending.length} migration(s) applied.`);
}

async function showStatus(conn) {
    const files = getMigrationFiles();
    const executed = await getExecutedMigrations(conn);
    const executedMap = new Map(executed.map(r => [r.filename, r]));
    console.log('\n  Migration Status\n  ' + '='.repeat(70));
    console.log('  ' + 'File'.padEnd(40) + 'Status'.padEnd(12) + 'Executed At');
    console.log('  ' + '-'.repeat(70));
    for (const filename of files) {
        const record = executedMap.get(filename);
        if (record) { const date = new Date(record.executed_at).toISOString().slice(0, 19).replace('T', ' ');
            console.log('  ' + filename.padEnd(40) + '\x1b[32mApplied\x1b[0m'.padEnd(21) + date);
        } else { console.log('  ' + filename.padEnd(40) + '\x1b[33mPending\x1b[0m'.padEnd(21) + '-'); }
    }
    console.log('  ' + '='.repeat(70));
    const pendingCount = files.length - executed.length;
    if (pendingCount > 0) warn(`\n  ${pendingCount} pending. Run \`npm run migrate\` to apply.`);
    else success('\n  All up to date.');
}

async function freshMigrations(conn) {
    warn('WARNING: DROP ALL TABLES in 3 seconds... Ctrl+C to cancel');
    await new Promise(r => setTimeout(r, 3000));
    await conn.query('SET FOREIGN_KEY_CHECKS = 0');
    const [tables] = await conn.query('SHOW TABLES');
    for (const row of tables) { const t = Object.values(row)[0]; log(`  Dropping: ${t}`); await conn.query(`DROP TABLE IF EXISTS \`${t}\``); }
    await conn.query('SET FOREIGN_KEY_CHECKS = 1');
    success('All tables dropped.\n');
    await ensureMigrationsTable(conn);
    await runMigrations(conn);
}

async function rollback(conn) {
    const executed = await getExecutedMigrations(conn);
    if (!executed.length) { warn('Nothing to rollback.'); return; }
    const last = executed[executed.length - 1];
    warn(`Rolling back: ${last.filename}`);
    const sqlFile = path.join(MIGRATIONS_DIR, last.filename);
    if (!fs.existsSync(sqlFile)) { error(`Migration file not found: ${last.filename}`); process.exit(1); }
    // For SQL migrations, we remove the record so it can be re-run
    // For actual reversal, you'd need a corresponding down migration
    const downFile = path.join(MIGRATIONS_DIR, last.filename.replace('.sql', '.down.sql'));
    if (fs.existsSync(downFile)) {
        const sql = fs.readFileSync(downFile, 'utf8').trim();
        if (sql) {
            log(`  Running rollback SQL: ${downFile}`);
            try { await conn.query(sql); success(`  Rollback SQL executed.`); }
            catch (e) { error(`Rollback SQL failed: ${e.message}`); }
        }
    } else {
        warn(`  No .down.sql file found. Removing migration record only.`);
    }
    await conn.query(`DELETE FROM \`${MIGRATIONS_TABLE}\` WHERE filename = ?`, [last.filename]);
    success(`Rolled back: ${last.filename}`);
}

async function main() {
    const command = process.argv[2] || 'run';
    console.log('\n  AXIOM v6 — Database Migration Runner\n  ' + '='.repeat(40));
    log(`Connecting to ${DB_CONFIG.host}/${DB_CONFIG.database} ...`);
    let conn;
    try { conn = await mysql.createConnection(DB_CONFIG); success('Connected.\n'); }
    catch (e) { error(`Cannot connect: ${e.message}`); process.exit(1); }
    try {
        await ensureMigrationsTable(conn);
        if (command === '--status' || command === 'status') await showStatus(conn);
        else if (command === '--fresh' || command === 'fresh') await freshMigrations(conn);
        else if (command === '--rollback' || command === 'rollback') await rollback(conn);
        else await runMigrations(conn);
    } finally { await conn.end(); }
    process.exit(0);
}
main().catch(e => { error(e.message); process.exit(1); });
