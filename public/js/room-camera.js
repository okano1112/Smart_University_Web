(function () {
    'use strict';

    const button = document.getElementById('camera-toggle');
    const video = document.getElementById('camera-video');
    const status = document.getElementById('camera-status');
    if (!button || !video || !status) return;

    const source = '/camera/classroom/index.m3u8';
    const offline = 'ติดต่อสตรีมกล้องไม่ได้ กรุณาตรวจการเชื่อมต่อของเซิร์ฟเวอร์แล้วลองอีกครั้ง';
    let view = null;
    let loadingLibrary = null;

    function showStatus(text) {
        if (status.textContent !== text) status.textContent = text;
        status.hidden = !text;
    }

    function loadHls() {
        if (window.Hls) return Promise.resolve(window.Hls);
        loadingLibrary ??= new Promise((resolve, reject) => {
            const script = document.createElement('script');
            script.src = '/vendor/hls.min.js';
            const fail = () => { script.remove(); reject(new Error('HLS library unavailable')); };
            script.onload = () => window.Hls ? resolve(window.Hls) : fail();
            script.onerror = fail;
            document.head.append(script);
        }).catch(error => {
            loadingLibrary = null;
            throw error;
        });
        return loadingLibrary;
    }

    function stop(message = '') {
        const previous = view;
        view = null;
        clearTimeout(previous?.timer);
        if (previous) {
            previous.hls?.destroy();
            video.pause();
            video.removeAttribute('src');
            video.load();
        }
        video.hidden = true;
        button.textContent = 'เปิดภาพสด';
        button.setAttribute('aria-expanded', 'false');
        showStatus(message);
    }

    function waitForVideo(current) {
        showStatus('กำลังรอภาพจากกล้อง…');
        current.timer ??= setTimeout(() => { if (view === current) stop(offline); }, 30000);
    }

    function play(current) {
        video.play().catch(error => {
            if (view !== current || error.name === 'AbortError') return;
            if (error.name === 'NotAllowedError') {
                clearTimeout(current.timer);
                current.timer = null;
                showStatus('กดเล่นบนวิดีโอเพื่อดูภาพสด');
            } else stop(offline);
        });
    }

    async function start() {
        const current = { hls: null, timer: null };
        view = current;
        video.hidden = false;
        video.muted = true;
        button.textContent = 'ปิดภาพสด';
        button.setAttribute('aria-expanded', 'true');
        waitForVideo(current);

        try {
            if (video.canPlayType('application/vnd.apple.mpegurl')) {
                video.src = source;
                play(current);
                return;
            }
            const Hls = await loadHls();
            if (view !== current) return;
            if (!Hls.isSupported()) {
                stop('เบราว์เซอร์นี้เล่นภาพสดแบบ HLS ไม่ได้');
                return;
            }
            const hls = new Hls();
            current.hls = hls;
            hls.on(Hls.Events.MANIFEST_PARSED, () => { if (view === current) play(current); });
            hls.on(Hls.Events.ERROR, (_event, data) => {
                if (view !== current || !data.fatal) return;
                const code = data.response?.code;
                stop(code === 401 || code === 403 ? 'กรุณาเข้าสู่ระบบใหม่เพื่อดูภาพสด' : offline);
            });
            hls.loadSource(source);
            hls.attachMedia(video);
        } catch (_) {
            if (view === current) stop(offline);
        }
    }

    button.addEventListener('click', () => { if (view) stop(); else void start(); });
    video.addEventListener('playing', () => {
        if (!view) return;
        clearTimeout(view.timer);
        view.timer = null;
        showStatus('กำลังแสดงภาพสด');
    });
    video.addEventListener('waiting', () => { if (view) waitForVideo(view); });
    video.addEventListener('error', () => { if (view && !view.hls) stop(offline); });
    window.addEventListener('pagehide', () => stop());
})();
