'use strict';
const { TextDecoder } = require('node:util');
const { POSE_MAX_BODY_BYTES } = require('./cira-pose-bridge');
const utf8 = new TextDecoder('utf-8', { fatal: true });

// Limit just the pose ingress before Node-RED/Express parses the JSON.
// Do not lower apiMaxLength globally: it also applies to editor flow deploys.
function httpNodeMiddleware(req, res, next) {
    if (req.method !== 'POST' || !/^\/cira-pose-frame\/?$/i.test(req.path)) return next();
    const reject = (status, code) => res.status(status).set('cache-control', 'no-store').json({ ok: false, code });
    if (!['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket?.remoteAddress) || req.headers.origin || req.headers['sec-fetch-site']) {
        return reject(403, 'LOCAL_ONLY');
    }
    if (!/^application\/json(?:\s*;\s*charset\s*=\s*"?utf-8"?)?\s*$/i.test(req.headers['content-type'] || '') ||
        !/^(?:identity)?$/i.test(req.headers['content-encoding'] || '')) return reject(415, 'CONTENT_TYPE');
    const length = Number(req.headers['content-length']);
    if (length > POSE_MAX_BODY_BYTES) return reject(413, 'TOO_LARGE');
    if (!Number.isSafeInteger(length) || length <= 0 || req.headers['transfer-encoding']) return reject(411, 'LENGTH_REQUIRED');
    // Node-RED may already have consumed the JSON stream in its editor API
    // middleware when the admin and HTTP roots share "/".
    if (req.readableEnded && req._body) return next();
    const chunks = [];
    let received = 0, completed = false;
    req.on('data', chunk => {
        if (completed) return;
        received += chunk.length;
        if (received > length || received > POSE_MAX_BODY_BYTES) {
            completed = true;
            reject(413, 'TOO_LARGE');
        } else chunks.push(chunk);
    });
    req.on('error', () => { if (!completed) { completed = true; reject(400, 'INVALID_JSON'); } });
    req.on('end', () => {
        if (completed) return;
        completed = true;
        try {
            if (received !== length) return reject(400, 'INVALID_JSON');
            req.body = JSON.parse(utf8.decode(Buffer.concat(chunks, received)));
        } catch (_) { return reject(400, 'INVALID_JSON'); }
        // Body is already parsed. Prevent Node-RED's following body-parser
        // and raw parser middleware from trying to read the stream again.
        req._body = true;
        req.skipRawBodyParser = true;
        return next();
    });
}

module.exports = {
    uiPort: Number(process.env.NODE_RED_PORT || 1880),
    uiHost: '127.0.0.1',
    flowFile: 'flows.json',
    flowFilePretty: true,
    httpAdminMiddleware: httpNodeMiddleware,
    httpNodeMiddleware,
    mqttReconnectTime: 5000,
    contextStorage: { default: { module: 'memory' } },
    functionExternalModules: false,
    logging: { console: { level: 'info', metrics: false, audit: false } },
    editorTheme: { projects: { enabled: false } }
};
