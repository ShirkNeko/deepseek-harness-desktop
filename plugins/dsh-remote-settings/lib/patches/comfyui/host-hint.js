import { networkInterfaces } from 'node:os';
/**
 * Host hint: remember the origin browsers use to reach this web server, so
 * generated media URLs (tool results) point at an address the requesting
 * browser can actually load. The hint is derived from the Host header, the
 * Referer and the reverse-proxy `x-forwarded-*` headers of every /comfyui/*
 * request the browser makes.
 *
 * The selected base follows this priority (see createHostHint#resolveMediaBase):
 *   1. explicit `mediaHost` config (handled by the caller);
 *   2. the browser-accessed origin: `x-forwarded-host` proto/host/port first
 *      (reverse proxy / public segment), else the non-loopback Host or Referer;
 *   3. if no browser origin has been seen yet, probe the three address
 *      segments for reachability — all LAN IPv4 origins, then loopback — and
 *      use the first that actually answers `/comfyui/ping` (cached for a short
 *      window). Loopback is a last resort only.
 *
 * Loopback origins never displace an already-seen external origin, so
 * server-side tool calls / local debug requests cannot overwrite the address
 * remote browsers use.
 */

/** First non-empty value of a header (arrays or comma lists). */
function firstValue(value) {
    if (Array.isArray(value))
        return value[0] ?? undefined;
    if (typeof value === 'string')
        return value.split(',')[0]?.trim() || undefined;
    return undefined;
}
/** Whether a Host header value names the local machine. */
function isLoopback(host) {
    const bare = host.replace(/^\[/, '').replace(/\].*$/, '').replace(/:\d+$/, '').toLowerCase();
    return bare === '127.0.0.1' || bare === 'localhost' || bare === '::1';
}
/** Extract the http(s) origin of a Referer header value, or undefined. */
function parseRefererOrigin(referer) {
    const raw = Array.isArray(referer) ? referer[0] : referer;
    if (typeof raw !== 'string' || raw === '')
        return undefined;
    try {
        const url = new URL(raw);
        if (url.protocol !== 'http:' && url.protocol !== 'https:')
            return undefined;
        return `${url.protocol}//${url.host}`.replace(/\/+$/, '');
    }
    catch {
        return undefined;
    }
}
/** Whether an origin string names the local machine. */
function isLoopbackOrigin(origin) {
    const match = origin.match(/^https?:\/\/([^/:]+)/);
    return match === null || isLoopback(match[1] ?? '');
}
/** Build an http(s) origin from a proto/host/port triple, or undefined. */
function buildOrigin(proto, host, port) {
    const scheme = proto === 'https' ? 'https' : 'http';
    const hostPart = (host ?? '').trim();
    if (hostPart === '')
        return undefined;
    // Host already carries a port, or is IPv6-ish; keep as-is.
    const bare = hostPart.replace(/^\[/, '').replace(/\].*$/, '');
    if (/:\d+$/.test(bare))
        return `${scheme}://${hostPart}`.replace(/\/+$/, '');
    if (port !== undefined && port !== '' && port !== '80' && port !== '443')
        return `${scheme}://${hostPart}:${port}`.replace(/\/+$/, '');
    return `${scheme}://${hostPart}`.replace(/\/+$/, '');
}
/**
 * The server's own first reachable LAN origin (e.g. http://192.168.1.5:3080),
 * used as a media-URL candidate before loopback. Picks the first non-internal
 * IPv4 that is not loopback or link-local. Returns undefined when no such
 * address exists (no network interface).
 */
export function detectLanOrigin(port) {
    for (const list of Object.values(networkInterfaces())) {
        if (list === undefined)
            continue;
        for (const net of list) {
            if (net.family !== 'IPv4' || net.internal)
                continue;
            const ip = net.address;
            if (ip === '127.0.0.1' || ip.startsWith('169.254.'))
                continue;
            return `http://${ip}:${port}`;
        }
    }
    return undefined;
}
/** Whether an origin answers `/comfyui/ping` with `{ ok: true }`. */
async function isOriginReachable(origin) {
    try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 1500);
        const response = await fetch(`${origin}/comfyui/ping`, {
            method: 'GET',
            redirect: 'follow',
            signal: controller.signal,
            headers: { accept: 'application/json' },
        });
        clearTimeout(timer);
        if (!response.ok)
            return false;
        const data = await response.json().catch(() => null);
        return data?.ok === true;
    }
    catch {
        return false;
    }
}
/** Create a host hint accumulator. */
export function createHostHint() {
    let forwarded; // public origin derived from x-forwarded-host/proto/port
    let external; // non-loopback origin from Host/Referer
    let loopback; // loopback origin
    let probeCache; // { base, ttl } for the reachability probe result
    return {
        record(request) {
            const host = request.headers.host;
            // Reverse-proxy forwarded headers: the client-facing (public) origin.
            const forwardedProto = firstValue(request.headers['x-forwarded-proto']);
            const forwardedHost = firstValue(request.headers['x-forwarded-host']);
            const forwardedPort = firstValue(request.headers['x-forwarded-port']);
            if (forwardedHost !== undefined && forwardedHost !== '') {
                const forwardedOrigin = buildOrigin(forwardedProto ?? 'https', forwardedHost, forwardedPort);
                if (forwardedOrigin !== undefined && !isLoopbackOrigin(forwardedOrigin))
                    forwarded = forwardedOrigin;
            }
            const proto = typeof forwardedProto === 'string'
                ? (forwardedProto.split(',')[0]?.trim() || 'http')
                : 'http';
            const hostOrigin = typeof host === 'string' && host !== ''
                ? `${proto}://${host}`.replace(/\/+$/, '')
                : undefined;
            if (hostOrigin !== undefined) {
                if (isLoopbackOrigin(hostOrigin))
                    loopback = hostOrigin;
                else
                    external = hostOrigin;
            }
            const refererOrigin = parseRefererOrigin(request.headers.referer);
            if (refererOrigin !== undefined && !isLoopbackOrigin(refererOrigin) && external === undefined)
                external = refererOrigin;
        },
        /** The browser-accessed origin (reverse-proxy public first, else Host/Referer). */
        externalOrigin() {
            return forwarded ?? external;
        },
        /** The loopback origin seen so far, or undefined. */
        loopbackOrigin() {
            return loopback;
        },
        /** Back-compat alias: the best-known non-loopback origin. */
        origin() {
            return forwarded ?? external;
        },
        /**
         * Ordered candidates for the reachability probe: all LAN IPv4 origins,
         * then loopback. Deduplicated. The public/forwarded origin is not
         * probed here — when present it is chosen directly as "browser address".
         */
        probeCandidates(port) {
            const candidates = [];
            for (const list of Object.values(networkInterfaces())) {
                if (list === undefined)
                    continue;
                for (const net of list) {
                    if (net.family !== 'IPv4' || net.internal)
                        continue;
                    const ip = net.address;
                    if (ip === '127.0.0.1' || ip.startsWith('169.254.'))
                        continue;
                    candidates.push(`http://${ip}:${port}`);
                }
            }
            candidates.push(`http://127.0.0.1:${port}`, `http://localhost:${port}`);
            return [...new Set(candidates)];
        },
        /**
         * Resolve the media base for chat URLs. Prefers the browser-accessed
         * origin; otherwise probes the three address segments and caches the
         * first reachable one for a short window; loopback is the last resort.
         */
        async resolveMediaBase(port) {
            const preferred = forwarded ?? external;
            if (preferred !== undefined)
                return preferred;
            if (probeCache !== undefined && probeCache.ttl > Date.now())
                return probeCache.base;
            for (const origin of this.probeCandidates(port)) {
                if (await isOriginReachable(origin)) {
                    probeCache = { base: origin, ttl: Date.now() + 60_000 };
                    return origin;
                }
            }
            const fallback = loopback ?? `http://127.0.0.1:${port}`;
            probeCache = { base: fallback, ttl: Date.now() + 60_000 };
            return fallback;
        },
    };
}
