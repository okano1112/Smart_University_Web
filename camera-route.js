'use strict';

const { request } = require('node:http');
const { pipeline } = require('node:stream');
const express = require('express');

const FILE = /^[a-z0-9][a-z0-9_.-]{0,127}\.(m3u8|mp4|m4s|ts|aac)$/i;
const RANGE = /^bytes=(?:\d{1,16}-\d{0,16}|-\d{1,16})$/;
const SESSION = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MEDIA_TYPES = {
    m3u8: 'application/vnd.apple.mpegurl',
    mp4: 'video/mp4',
    m4s: 'video/mp4',
    ts: 'video/mp2t',
    aac: 'audio/aac'
};

function mediaQuery(query, file, format) {
    const params = new URLSearchParams();
    // MediaMTX checks for an HLS cookie on the master playlist. We never
    // forward cookies to it, so select its query-session fallback directly.
    if (file === 'index.m3u8') params.set('cookieCheck', '1');
    if (typeof query.session === 'string' && SESSION.test(query.session)) params.set('session', query.session);
    if (format === 'm3u8') {
        for (const key of ['_HLS_msn', '_HLS_part']) {
            const value = query[key];
            if (typeof value === 'string' && /^\d{1,15}$/.test(value)) params.set(key, value);
        }
        if (query._HLS_skip === 'YES' || query._HLS_skip === 'v2') params.set('_HLS_skip', query._HLS_skip);
    }
    const search = params.toString();
    return search ? `?${search}` : '';
}

function createCameraRouter({ port = 8888, timeoutMs = 18_000 } = {}) {
    const router = express.Router();
    router.use((_req, res, next) => {
        res.set({
            'Cache-Control': 'private, no-store',
            'Cloudflare-CDN-Cache-Control': 'no-store',
            'Cross-Origin-Resource-Policy': 'same-origin'
        });
        next();
    });
    router.get('/:file', (req, res) => {
        const match = FILE.exec(req.params.file);
        if (!match) return res.sendStatus(404);
        const site = req.get('Sec-Fetch-Site');
        if (site && site !== 'same-origin' && site !== 'none') return res.sendStatus(403);
        if (res.destroyed) return;

        const format = match[1].toLowerCase();
        const range = req.get('Range');
        const headers = { 'Accept-Encoding': 'identity' };
        if (RANGE.test(range || '')) headers.Range = range;
        // Only the local MediaMTX HLS listener is reachable through this route.
        // Session credentials are checked by the app and stay at the app.
        // MediaMTX only handles GET. For HEAD, use its headers and release the body.
        const upstream = request({
            hostname: '127.0.0.1', port, method: 'GET',
            path: `/classroom/${req.params.file}${mediaQuery(req.query, req.params.file, format)}`,
            headers
        }, media => {
            if (media.statusCode !== 200 && media.statusCode !== 206) {
                media.resume();
                if (media.statusCode === 416 && media.headers['content-range']) {
                    res.set('Content-Range', media.headers['content-range']);
                }
                return res.sendStatus([404, 416].includes(media.statusCode) ? media.statusCode : 503);
            }

            res.status(media.statusCode).set('Content-Type', MEDIA_TYPES[format]);
            for (const header of ['content-length', 'content-range', 'accept-ranges']) {
                if (media.headers[header] !== undefined) res.set(header, media.headers[header]);
            }
            if (req.method === 'HEAD') {
                res.end();
                media.destroy();
                return;
            }
            pipeline(media, res, () => {});
        });
        let expired = false;
        const timer = setTimeout(() => {
            expired = true;
            upstream.destroy(new Error('MediaMTX response timed out'));
        }, timeoutMs);
        timer.unref();
        res.once('close', () => {
            clearTimeout(timer);
            upstream.destroy();
        });
        upstream.on('error', () => {
            if (res.destroyed || res.writableEnded) return;
            if (res.headersSent) res.destroy();
            else res.sendStatus(expired ? 504 : 503);
        });
        upstream.end();
    });
    router.use((_req, res) => res.sendStatus(404));
    return router;
}

module.exports = { createCameraRouter };
