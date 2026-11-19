'use strict';

const { readFile } = require('node:fs/promises');
const path = require('node:path');
const { Pool } = require('pg');
const DEFAULT_ACCOUNT = Object.freeze(require('./default-login-account.json'));

function validAccount(value) {
    return value?.version === 1 && typeof value.username === 'string' && /^[a-zA-Z0-9._-]{1,64}$/.test(value.username) &&
        typeof value.salt === 'string' && /^[a-f0-9]{32}$/.test(value.salt) &&
        typeof value.hash === 'string' && /^[a-f0-9]{64}$/.test(value.hash);
}

async function readAccount(file) {
    try {
        const account = JSON.parse(await readFile(file, 'utf8'));
        return validAccount(account) ? account : null;
    } catch (_) { return null; }
}

class FileAuthStore {
    constructor(file) { this.file = file; this.sessions = new Map(); this.hash = null; this.database = false; this.storage = 'file'; }
    async getAccount() {
        const account = await readAccount(this.file);
        if ((account?.hash ?? null) !== this.hash) {
            this.hash = account?.hash ?? null;
            this.sessions.clear();
        }
        return account;
    }
    async findSession(key, origin, now) {
        await this.getAccount();
        const session = this.sessions.get(key);
        return session?.origin === origin && now < session.expiresAt ? key : null;
    }
    async createSession(key, session, hash, now) {
        const account = await this.getAccount();
        if (account?.hash !== hash) return false;
        for (const [id, saved] of this.sessions) if (now >= saved.expiresAt) this.sessions.delete(id);
        if (this.sessions.size >= 128) this.sessions.delete(this.sessions.keys().next().value);
        this.sessions.set(key, session);
        return true;
    }
    async deleteSession(key) { this.sessions.delete(key); }
    async close() {}
}

class FixedAuthStore extends FileAuthStore {
    constructor() {
        super(null);
        if (!validAccount(DEFAULT_ACCOUNT)) throw new Error('ข้อมูลบัญชีเริ่มต้นไม่ถูกต้อง');
        this.storage = 'fixed';
        this.hash = DEFAULT_ACCOUNT.hash;
    }
    async getAccount() { return DEFAULT_ACCOUNT; }
}

function databaseUnavailable() {
    return Object.assign(new Error('ติดต่อฐานข้อมูลบัญชีกลางไม่ได้ กรุณาตรวจ DATABASE_URL และการเชื่อมต่ออินเทอร์เน็ต'), {
        code: 'AUTH_DATABASE_UNAVAILABLE', status: 503
    });
}

class PostgresAuthStore {
    constructor({ connectionString, accountFile, pool }) {
        this.accountFile = accountFile;
        this.database = true;
        this.storage = 'postgres';
        if (pool) this.pool = pool;
        else {
            let url;
            try { url = new URL(connectionString); }
            catch (_) { throw new Error('DATABASE_URL ของ PostgreSQL ไม่ถูกต้อง'); }
            if (!['postgres:', 'postgresql:'].includes(url.protocol)) throw new Error('DATABASE_URL ต้องเป็น PostgreSQL');
            const sslMode = url.searchParams.get('sslmode');
            const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
            const ssl = sslMode === 'disable' || (local && !sslMode) ? false : { rejectUnauthorized: true };
            // Keep certificate verification explicit when the URL uses sslmode=require.
            // The provider's public certificate is checked by Node's trusted CAs.
            url.searchParams.delete('sslmode');
            this.pool = new Pool({ connectionString: url.toString(), ssl, max: 5, allowExitOnIdle: true,
                connectionTimeoutMillis: 10000, statement_timeout: 8000, query_timeout: 10000 });
        }
        this.pool.on('error', () => {});
    }
    async transaction(operation) {
        let client;
        try {
            client = await this.pool.connect();
            await client.query('BEGIN');
            await client.query('SELECT pg_advisory_xact_lock(824631, 1)');
            const result = await operation(client);
            await client.query('COMMIT');
            return result;
        } catch (error) {
            if (client) await client.query('ROLLBACK').catch(() => {});
            if (error.code === 'ACCOUNT_EXISTS') throw error;
            throw databaseUnavailable();
        } finally { client?.release(); }
    }
    async initialize() {
        if (!this.ready) {
            this.ready = this.transaction(async client => {
                const sql = await readFile(path.join(__dirname, 'database/auth.sql'), 'utf8');
                await client.query(sql);
                const previous = this.accountFile && await readAccount(this.accountFile);
                if (previous) await client.query(
                    'INSERT INTO bimclub_auth.admin_account (id, username, salt, hash) VALUES (1,$1,$2,$3) ON CONFLICT (id) DO NOTHING',
                    [previous.username, previous.salt, previous.hash]);
            }).catch(error => { this.ready = null; throw error; });
        }
        return this.ready;
    }
    async query(sql, values) {
        await this.initialize();
        try { return await this.pool.query(sql, values); }
        catch (_) { throw databaseUnavailable(); }
    }
    async getAccount() {
        const result = await this.query('SELECT username,salt,hash FROM bimclub_auth.admin_account WHERE id=1');
        return result.rows[0] ? { version: 1, ...result.rows[0] } : null;
    }
    async saveAccount(account, reset = false) {
        if (!validAccount(account)) throw new Error('ข้อมูลบัญชีไม่ถูกต้อง');
        await this.initialize();
        return this.transaction(async client => {
            const result = await client.query(
                'INSERT INTO bimclub_auth.admin_account (id,username,salt,hash) VALUES (1,$1,$2,$3) ' +
                (reset ? 'ON CONFLICT (id) DO UPDATE SET username=EXCLUDED.username,salt=EXCLUDED.salt,hash=EXCLUDED.hash RETURNING id'
                    : 'ON CONFLICT (id) DO NOTHING RETURNING id'), [account.username, account.salt, account.hash]);
            if (!result.rowCount) throw Object.assign(new Error('ฐานข้อมูลกลางมีบัญชีแล้ว ใช้บัญชีเดิมเข้าสู่ระบบได้เลย'), { code: 'ACCOUNT_EXISTS' });
            await client.query('DELETE FROM bimclub_auth.sessions');
        });
    }
    async findSession(key, origin, now) {
        const result = await this.query(
            'SELECT s.token_hash FROM bimclub_auth.sessions s JOIN bimclub_auth.admin_account a ON a.hash=s.account_hash ' +
            'WHERE s.token_hash=$1 AND s.origin=$2 AND s.expires_at>$3', [key, origin, now]);
        return result.rowCount ? key : null;
    }
    async createSession(key, session, hash, now) {
        await this.initialize();
        return this.transaction(async client => {
            const account = await client.query('SELECT hash FROM bimclub_auth.admin_account WHERE id=1');
            if (account.rows[0]?.hash !== hash) return false;
            await client.query('DELETE FROM bimclub_auth.sessions WHERE expires_at<=$1', [now]);
            await client.query('DELETE FROM bimclub_auth.sessions WHERE token_hash IN ' +
                '(SELECT token_hash FROM bimclub_auth.sessions ORDER BY created_at DESC,token_hash OFFSET 127)');
            await client.query('INSERT INTO bimclub_auth.sessions (token_hash,origin,account_hash,expires_at,created_at) VALUES ($1,$2,$3,$4,$5)',
                [key, session.origin, hash, session.expiresAt, now]);
            return true;
        });
    }
    async deleteSession(key) { await this.query('DELETE FROM bimclub_auth.sessions WHERE token_hash=$1', [key]); }
    async close() { await this.pool.end(); }
}

function createAuthStore({ accountFile, connectionString = process.env.DATABASE_URL,
    mode = process.env.BIMCLUB_AUTH_MODE || 'fixed' } = {}) {
    // The bundled account is ready on every machine. Old database.env files and
    // imported accounts only take effect when their storage mode is selected.
    if (mode === 'fixed') return new FixedAuthStore();
    const file = accountFile || path.join(__dirname, 'data', 'login-account.json');
    if (mode === 'file') return new FileAuthStore(file);
    if (mode !== 'postgres') throw new Error('BIMCLUB_AUTH_MODE ต้องเป็น fixed, file หรือ postgres');
    if (!connectionString) throw new Error('กรุณาตั้ง DATABASE_URL ของฐานข้อมูลกลางใน database.env');
    return new PostgresAuthStore({ connectionString, accountFile: file });
}

module.exports = { createAuthStore, FileAuthStore, FixedAuthStore, PostgresAuthStore, validAccount };
