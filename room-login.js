'use strict';

const express = require('express');
const { randomBytes, scrypt, timingSafeEqual, createHash } = require('node:crypto');
const { readFile } = require('node:fs/promises');
const path = require('node:path');
const { promisify } = require('node:util');
const derive = promisify(scrypt);

const ACCOUNT_FILE = path.join(__dirname, 'data', 'login-account.json');
const LOGIN_DIR = path.join(__dirname, 'login');
const SESSION_MS = 12 * 60 * 60 * 1000;
const RATE_MS = 5 * 60 * 1000;
const SESSION_LIMIT = 128;
const MAX_FAILED = 10;
const MIN_PASSWORD_LENGTH = 8;
const LOCAL_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]']);
const LOCAL_PEERS = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

function validUsername(value) {
    return typeof value === 'string' && /^[a-zA-Z0-9._-]{1,64}$/.test(value);
}

function validPassword(value) {
    return typeof value === 'string' && Buffer.byteLength(value, 'utf8') > 0 && Buffer.byteLength(value, 'utf8') <= 256;
}

function passwordHash(password, salt) {
    return derive(password, salt, 32, { N: 2 ** 15, r: 8, p: 3, maxmem: 64 * 1024 * 1024 });
}

async function makeLoginAccount(username, password) {
    if (!validUsername(username) || !validPassword(password) || [...password].length < MIN_PASSWORD_LENGTH) {
        throw new Error(`ชื่อผู้ใช้ต้องเป็นอักษรอังกฤษ ตัวเลข จุด ขีด หรือขีดล่าง และรหัสผ่านต้องยาว ${MIN_PASSWORD_LENGTH} ตัวขึ้นไป`);
    }
    const salt = randomBytes(16);
    const hash = await passwordHash(password, salt);
    return { version: 1, username, salt: salt.toString('hex'), hash: hash.toString('hex') };
}

async function readLoginAccount(filename) {
    try {
        const data = JSON.parse(await readFile(filename, 'utf8'));
        if (data?.version === 1 && validUsername(data.username) && typeof data.salt === 'string' &&
            /^[a-f0-9]{32}$/.test(data.salt) && typeof data.hash === 'string' && /^[a-f0-9]{64}$/.test(data.hash)) return data;
    } catch (_) { /* Login stays closed when the local account file is absent or unreadable. */ }
    return null;
}

function scope(req) {
    const host = req.get('host');
    if (!host || !/^[a-z0-9.:[\]-]+$/i.test(host)) return null;
    try {
        const destination = new URL('https://' + host);
        // Only the machine's direct loopback URL uses the local development
        // cookie. The public hostname gets a Secure cookie behind the tunnel.
        const local = LOCAL_HOSTS.has(destination.hostname) && LOCAL_PEERS.has(req.socket.remoteAddress);
        const origin = new URL((local ? 'http://' : 'https://') + host).origin;
        return { origin, cookie: local ? 'bimclub_session' : '__Host-bimclub_session', secure: !local };
    } catch (_) { return null; }
}

function sameOrigin(req, origin) {
    const site = req.get('Sec-Fetch-Site');
    if (site && site !== 'same-origin' && site !== 'none') return false;
    if (req.get('origin')) return req.get('origin') === origin;
    try { return new URL(req.get('referer')).origin === origin; }
    catch (_) { return false; }
}

function sessionKey(req, name) {
    const pairs = (req.get('cookie') || '').split(';').map(pair => pair.trim());
    const matching = pairs.filter(pair => pair.startsWith(name + '='));
    if (matching.length !== 1) return null;
    const token = matching[0].slice(name.length + 1);
    return /^[A-Za-z0-9_-]{43}$/.test(token) ? createHash('sha256').update(token).digest('hex') : null;
}

function installRoomLogin(app, { accountFile = ACCOUNT_FILE, now = Date.now } = {}) {
    const sessions = new Map();
    let accountHash = null, activeChecks = 0;
    const attempts = new Map();
    const sessionOptions = secure => ({ httpOnly: true, secure, sameSite: 'lax', path: '/' });
    const form = express.urlencoded({ extended: false, limit: '4kb', parameterLimit: 3 });
    const expire = () => {
        for (const [id, session] of sessions) if (now() >= session.expiresAt) sessions.delete(id);
        for (const [peer, limit] of attempts) if (now() >= limit.until) attempts.delete(peer);
    };
    const lookup = req => {
        const host = scope(req);
        const key = host && sessionKey(req, host.cookie);
        const session = key && sessions.get(key);
        return session && session.origin === host.origin && now() < session.expiresAt ? key : null;
    };
    const load = async () => {
        const account = await readLoginAccount(accountFile);
        const hash = account?.hash ?? null;
        if (accountHash !== hash) {
            accountHash = hash;
            sessions.clear();
        }
        return account;
    };
    const page = async (res, status = 200, message = '') => {
        const template = await readFile(path.join(LOGIN_DIR, 'login.html'), 'utf8');
        // Every message below is a constant supplied by the server.
        res.set('Content-Security-Policy', "default-src 'none'; style-src 'self'; img-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'");
        res.status(status).type('html').send(template.replace('<!--LOGIN_MESSAGE-->', message));
    };
    const setup = '<p>ยังไม่ได้ตั้งบัญชีผู้ดูแล กรุณาตั้งบัญชีจากหน้าต่าง Terminal บนเครื่องเซิร์ฟเวอร์</p>';
    const wrong = '<p>ชื่อผู้ใช้หรือรหัสผ่านไม่ถูกต้อง</p>';

    app.disable('x-powered-by');
    app.use((req, res, next) => {
        res.set({
            'Cache-Control': 'private, no-store',
            'Referrer-Policy': 'same-origin',
            'X-Content-Type-Options': 'nosniff',
            'X-Frame-Options': 'DENY'
        });
        next();
    });
    app.get('/login.css', (_req, res) => res.sendFile(path.join(LOGIN_DIR, 'login.css'), { cacheControl: false }));
    app.get('/login', async (req, res) => {
        if (lookup(req)) return res.redirect(303, '/');
        if (!await load()) return page(res, 503, setup);
        return page(res);
    });
    app.post('/login', (req, res, next) => {
        const host = scope(req);
        if (!host || !sameOrigin(req, host.origin)) return res.sendStatus(403);
        if (!req.is('application/x-www-form-urlencoded')) return res.sendStatus(415);
        next();
    }, form, async (req, res) => {
        expire();
        const peer = req.socket.remoteAddress;
        let limit = attempts.get(peer);
        if (activeChecks >= 2 || limit?.count >= MAX_FAILED || (!limit && attempts.size >= 256)) {
            const remaining = limit?.count >= MAX_FAILED ? Math.ceil((limit.until - now()) / 1000) : 5;
            res.set('Retry-After', String(Math.max(1, remaining)));
            return page(res, 429, '<p>ลองเข้าสู่ระบบหลายครั้ง กรุณารอสักครู่แล้วลองใหม่</p>');
        }
        const { username, password } = req.body || {};
        if (!limit) {
            limit = { count: 0, until: now() + RATE_MS };
            attempts.set(peer, limit);
        }
        // Reserve a slot before awaiting I/O or a hash. This also bounds the
        // number of expensive concurrent scrypt calls on the room server.
        limit.count++;
        activeChecks++;
        try {
            const account = await load();
            if (!account) return page(res, 503, setup);
            if (!validUsername(username) || !validPassword(password)) return page(res, 401, wrong);
            const actual = await passwordHash(password, Buffer.from(account.salt, 'hex'));
            if (!timingSafeEqual(actual, Buffer.from(account.hash, 'hex')) || username !== account.username || accountHash !== account.hash) {
                return page(res, 401, wrong);
            }
            const host = scope(req);
            const previous = sessionKey(req, host.cookie);
            if (previous) sessions.delete(previous);
            if (sessions.size >= SESSION_LIMIT) sessions.delete(sessions.keys().next().value);
            const token = randomBytes(32).toString('base64url');
            sessions.set(createHash('sha256').update(token).digest('hex'), { origin: host.origin, expiresAt: now() + SESSION_MS });
            attempts.delete(peer);
            res.cookie(host.cookie, token, { ...sessionOptions(host.secure), maxAge: SESSION_MS });
            return res.redirect(303, '/');
        } finally { activeChecks--; }
    });
    app.use((req, res, next) => {
        const key = lookup(req);
        if (!key) {
            if (['GET', 'HEAD'].includes(req.method) && (req.path === '/' || req.path === '/index.html' ||
                (req.get('Sec-Fetch-Mode') === 'navigate' && !/^\/api(?:\/|$)/i.test(req.path)))) return res.redirect(303, '/login');
            return res.status(401).json({ success: false, message: 'กรุณาเข้าสู่ระบบ' });
        }
        const host = scope(req);
        if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method) && !sameOrigin(req, host.origin)) return res.sendStatus(403);
        res.locals.loginSession = key;
        return next();
    });
    app.get('/api/auth/session', (_req, res) => res.sendStatus(204));
    app.post('/logout', (req, res) => {
        const host = scope(req);
        sessions.delete(res.locals.loginSession);
        res.clearCookie(host.cookie, sessionOptions(host.secure));
        return res.redirect(303, '/login');
    });
}

module.exports = { ACCOUNT_FILE, MIN_PASSWORD_LENGTH, makeLoginAccount, installRoomLogin };
