const unavailableMessage = 'เชื่อมต่อเซิร์ฟเวอร์ BimClub ไม่ได้ในขณะนี้ กรุณาลองใหม่อีกครั้ง';

function unavailable(request, pathname) {
    const api = pathname === '/api' || pathname.startsWith('/api/');
    const body = api ? JSON.stringify({ success: false, message: unavailableMessage }) : unavailableMessage;
    return new Response(request.method === 'HEAD' ? null : body, {
        status: 503,
        headers: {
            'Content-Type': api ? 'application/json; charset=utf-8' : 'text/plain; charset=utf-8',
            'Cache-Control': 'private, no-store',
            'Retry-After': '15'
        }
    });
}

export default {
    async fetch(request, env) {
        // The VPC Service fixes the destination to Windows. The URL's public
        // hostname becomes Host at Express, matching the browser's Origin.
        const target = new URL(request.url);
        target.protocol = 'http:';
        if (!env.BIMCLUB_ORIGIN) return unavailable(request, target.pathname);

        try {
            const response = await env.BIMCLUB_ORIGIN.fetch(new Request(target, {
                method: request.method,
                headers: request.headers,
                body: request.body,
                duplex: 'half',
                redirect: 'manual',
                signal: request.signal
            }));
            if (response.status === 502 || (response.status >= 520 && response.status <= 530)) {
                // These gateway errors do not come from the BimClub API.
                if (response.body) await response.body.cancel();
                return unavailable(request, target.pathname);
            }
            // Preserve relative redirects, Set-Cookie and the origin's no-store policy.
            return response;
        } catch (_) {
            return unavailable(request, target.pathname);
        }
    }
};
