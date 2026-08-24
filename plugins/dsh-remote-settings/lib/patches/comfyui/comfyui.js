/**
 * Minimal ComfyUI HTTP API client: queue a workflow, poll history for
 * completion, read object_info/system_stats, and fetch generated media.
 * Only the endpoints dsh-comfyui needs are implemented; the server's own
 * WebSocket progress channel is deliberately unused (history polling is
 * simpler and works across proxies and remote installs).
 */
import { randomUUID } from 'node:crypto';
/** Failure talking to the ComfyUI server. */
export class ComfyUIError extends Error {
    status;
    constructor(message, status) {
        super(message);
        this.status = status;
        this.name = 'ComfyUIError';
    }
}
function sleep(millis, signal) {
    return new Promise((resolve, reject) => {
        if (signal.aborted) {
            reject(new ComfyUIError('ComfyUI generation aborted'));
            return;
        }
        const timer = setTimeout(resolve, millis);
        signal.addEventListener('abort', () => {
            clearTimeout(timer);
            reject(new ComfyUIError('ComfyUI generation aborted'));
        }, { once: true });
    });
}
function guessContentType(filename) {
    const lower = filename.toLowerCase();
    if (lower.endsWith('.png'))
        return 'image/png';
    if (lower.endsWith('.jpg') || lower.endsWith('.jpeg'))
        return 'image/jpeg';
    if (lower.endsWith('.webp'))
        return 'image/webp';
    if (lower.endsWith('.gif'))
        return 'image/gif';
    if (lower.endsWith('.mp4'))
        return 'video/mp4';
    if (lower.endsWith('.webm'))
        return 'video/webm';
    if (lower.endsWith('.avi'))
        return 'video/x-msvideo';
    if (lower.endsWith('.mp3'))
        return 'audio/mpeg';
    if (lower.endsWith('.wav'))
        return 'audio/wav';
    if (lower.endsWith('.ogg'))
        return 'audio/ogg';
    if (lower.endsWith('.flac'))
        return 'audio/flac';
    if (lower.endsWith('.m4a'))
        return 'audio/mp4';
    if (lower.endsWith('.aac'))
        return 'audio/aac';
    if (lower.endsWith('.opus'))
        return 'audio/opus';
    return 'application/octet-stream';
}
/** The per-process client id ComfyUI uses to correlate queued prompts. */
export const CLIENT_ID = randomUUID();
/** HTTP client over the ComfyUI REST API. */
export class ComfyUIClient {
    baseUrl;
    apiKey;
    connectTimeoutMs;
    maxMediaBytes;
    constructor(baseUrl, apiKey, connectTimeoutMs, maxMediaBytes) {
        this.baseUrl = baseUrl;
        this.apiKey = apiKey;
        this.connectTimeoutMs = connectTimeoutMs;
        this.maxMediaBytes = maxMediaBytes;
    }
    endpoint(path) {
        return `${this.baseUrl.replace(/\/+$/, '')}${path}`;
    }
    async request(path, init = {}, timeoutMs) {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs ?? this.connectTimeoutMs);
        try {
            const headers = { ...init.headers };
            if (this.apiKey !== undefined)
                headers['Authorization'] = `Bearer ${this.apiKey}`;
            const response = await fetch(this.endpoint(path), { ...init, headers, signal: controller.signal });
            if (!response.ok) {
                const body = await response.text().catch(() => '');
                throw new ComfyUIError(`ComfyUI ${path} failed: HTTP ${response.status}${body !== '' ? ` — ${body.slice(0, 300)}` : ''}`, response.status);
            }
            const text = await response.text();
            if (text === '')
                return undefined;
            try {
                return JSON.parse(text);
            }
            catch {
                throw new ComfyUIError(`ComfyUI ${path} returned non-JSON body`);
            }
        }
        finally {
            clearTimeout(timer);
        }
    }
    /** Upload a file (multipart body forwarded verbatim) into ComfyUI's input directory. */
    async uploadFile(body, contentType) {
        const data = await this.request('/upload/image', {
            method: 'POST',
            headers: { 'content-type': contentType },
            body,
        });
        return data ?? {};
    }
    /** Queue one API-format workflow and return its prompt id. */
    async queuePrompt(workflow, options = {}) {
        const payload = { prompt: workflow, client_id: CLIENT_ID };
        if (options.promptId !== undefined)
            payload['prompt_id'] = options.promptId;
        if (options.front === true)
            payload['front'] = true;
        if (options.extraData !== undefined && Object.keys(options.extraData).length > 0) {
            payload['extra_data'] = options.extraData;
        }
        const data = await this.request('/prompt', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(payload),
        });
        if (typeof data.prompt_id !== 'string') {
            throw new ComfyUIError('ComfyUI /prompt returned no prompt_id');
        }
        return data.prompt_id;
    }
    /** Read one prompt's history entry; undefined while the prompt is unknown or evicted. */
    async getHistory(promptId) {
        const data = await this.request(`/history/${encodeURIComponent(promptId)}`);
        return data[promptId];
    }
    /** The server-side queue: running + pending prompts. */
    async getQueue() {
        // ComfyUI serializes each queue slot as [number, prompt_id, prompt, ...];
        // only the number and prompt_id are needed here.
        const raw = await this.request('/queue');
        const parse = (list) => {
            if (!Array.isArray(list))
                return [];
            const items = [];
            for (const entry of list) {
                if (Array.isArray(entry) && typeof entry[1] === 'string' && entry[1] !== '') {
                    items.push({ number: typeof entry[0] === 'number' ? entry[0] : 0, prompt_id: entry[1] });
                }
            }
            return items;
        };
        return { queue_running: parse(raw.queue_running), queue_pending: parse(raw.queue_pending) };
    }
    /** Unified job list with status filters, sorting, and pagination. */
    async getJobs(options = {}) {
        const params = new URLSearchParams();
        if (options.status !== undefined && options.status.length > 0)
            params.set('status', options.status.join(','));
        if (options.limit !== undefined)
            params.set('limit', String(options.limit));
        if (options.offset !== undefined)
            params.set('offset', String(options.offset));
        if (options.sortBy !== undefined)
            params.set('sort_by', options.sortBy);
        if (options.sortOrder !== undefined)
            params.set('sort_order', options.sortOrder);
        const query = params.toString();
        return this.request(`/api/jobs${query !== '' ? `?${query}` : ''}`);
    }
    /** One job by id, including its workflow prompt and outputs. */
    async getJob(jobId) {
        try {
            return await this.request(`/api/jobs/${encodeURIComponent(jobId)}`);
        }
        catch (error) {
            if (error instanceof ComfyUIError && error.status === 404)
                return undefined;
            throw error;
        }
    }
    /** Remove specific prompts from the pending queue. */
    async deleteQueueItems(promptIds) {
        await this.request('/queue', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ delete: promptIds }),
        });
    }
    /** Clear the entire pending queue (running job is unaffected). */
    async clearQueue() {
        await this.request('/queue', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ clear: true }),
        });
    }
    /** Interrupt the running prompt; without an id, interrupt globally. */
    async interruptPrompt(promptId) {
        await this.request('/interrupt', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(promptId !== undefined ? { prompt_id: promptId } : {}),
        });
    }
    /** Cancel one job regardless of state (running → interrupt, pending → dequeue). */
    async cancelJob(jobId) {
        return this.request(`/api/jobs/${encodeURIComponent(jobId)}/cancel`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: '{}',
        });
    }
    /** Best-effort batch cancel; finished or unknown ids are no-ops. */
    async cancelJobs(jobIds) {
        return this.request('/api/jobs/cancel', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ job_ids: jobIds }),
        });
    }
    /** Clear or selectively delete history entries. */
    async clearHistory() {
        await this.request('/history', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ clear: true }),
        });
    }
    /** Delete specific history entries. */
    async deleteHistory(promptIds) {
        await this.request('/history', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ delete: promptIds }),
        });
    }
    /** Ask ComfyUI to unload models / free memory (per /free flags). */
    async freeMemory(options = {}) {
        await this.request('/free', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ unload_models: options.unloadModels === true, free_memory: options.freeMemory === true }),
        });
    }
    /** List one user-data subdirectory (e.g. 'workflows') on the ComfyUI server. */
    async listUserData(subdir) {
        const data = await this.request(`/v2/userdata?path=${encodeURIComponent(subdir)}`);
        if (!Array.isArray(data))
            return [];
        if (typeof data[0] === 'string') {
            return data.map((name) => ({ name, path: `${subdir}/${name}`, type: 'file' }));
        }
        return data;
    }
    /** Read one user-data file (path relative to the user root, e.g. 'workflows/x.json'). */
    async getUserDataFile(relPath) {
        // The {file} route matches a single segment only, so the relative path is
        // URL-encoded (the handler unquotes it) — see app/user_manager.py.
        return this.request(`/userdata/${encodeURIComponent(relPath)}`);
    }
    /** Node definitions for workflow construction (comfyui_object_info). */
    async objectInfo() {
        return this.request('/object_info');
    }
    /** Server health/version probe. */
    async systemStats() {
        return this.request('/system_stats');
    }
    /** Ask ComfyUI to interrupt the running prompt. */
    async interrupt() {
        await this.request('/interrupt', { method: 'POST' });
    }
    /** Download one generated media file through GET /view. */
    async fetchView(ref) {
        const params = new URLSearchParams({ filename: ref.filename, subfolder: ref.subfolder, type: ref.type });
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), this.connectTimeoutMs);
        try {
            const headers = {};
            if (this.apiKey !== undefined)
                headers['Authorization'] = `Bearer ${this.apiKey}`;
            const response = await fetch(this.endpoint(`/view?${params.toString()}`), { headers, signal: controller.signal });
            if (!response.ok) {
                throw new ComfyUIError(`ComfyUI /view failed: HTTP ${response.status}`);
            }
            const bytes = new Uint8Array(await response.arrayBuffer());
            if (bytes.byteLength > this.maxMediaBytes) {
                throw new ComfyUIError(`ComfyUI media too large: ${bytes.byteLength} bytes exceeds maxMediaBytes ${this.maxMediaBytes}`);
            }
            return { bytes, contentType: response.headers.get('content-type') ?? guessContentType(ref.filename) };
        }
        finally {
            clearTimeout(timer);
        }
    }
    /**
     * Poll history until the prompt completes, fails, or the budget/signal ends.
     * Interrupts the server when the signal aborts before throwing.
     */
    async waitForCompletion(opts) {
        const { promptId, timeoutMs, pollIntervalMs, signal } = opts;
        const deadline = Date.now() + timeoutMs;
        for (;;) {
            if (signal.aborted) {
                await this.interrupt().catch(() => undefined);
                throw new ComfyUIError(`ComfyUI generation interrupted (prompt ${promptId})`);
            }
            const entry = await this.getHistory(promptId);
            if (entry !== undefined) {
                const status = entry.status;
                if (status?.status_str === 'success' || status?.completed === true || hasMedia(entry)) {
                    return entry;
                }
                if (status?.status_str === 'error') {
                    throw new ComfyUIError(historyErrorMessage(promptId, entry));
                }
            }
            if (Date.now() >= deadline) {
                throw new ComfyUIError(`ComfyUI generation timed out after ${timeoutMs} ms (prompt ${promptId})`);
            }
            await sleep(pollIntervalMs, signal);
        }
    }
}
export function hasMedia(entry) {
    for (const output of Object.values(entry.outputs ?? {})) {
        if ((output.images?.length ?? 0) > 0 || (output.videos?.length ?? 0) > 0 || (output.gifs?.length ?? 0) > 0) {
            return true;
        }
    }
    return false;
}
/** Compose a readable failure message from history status messages. */
export function historyErrorMessage(promptId, entry) {
    const details = [];
    for (const message of entry.status?.messages ?? []) {
        if (Array.isArray(message) && typeof message[0] === 'string') {
            const [, payload] = message;
            if (typeof payload === 'object' && payload !== null) {
                const record = payload;
                if (typeof record.exception_message === 'string') {
                    details.push(record.exception_message.slice(0, 500));
                }
                else if (typeof record.exception_type === 'string') {
                    details.push(record.exception_type);
                }
            }
        }
    }
    return `ComfyUI execution failed (prompt ${promptId}): ${details.join('; ') || 'unknown error'}`;
}
/**
 * Collect media items from a completed history entry, in node/output order,
 * capped by maxItems. The URL is the same-origin proxy route when a web
 * server is present, otherwise a ComfyUI /view URL (for headless hosts).
 */
export function collectMedia(opts) {
    const { promptId, entry, maxItems, proxyBase } = opts;
    const items = [];
    const AUDIO_EXT = /\.(mp3|wav|ogg|flac|m4a|aac|opus)$/i;
    const VIDEO_EXT = /\.(mp4|webm|mov|mkv|avi)$/i;
    for (const [node, output] of Object.entries(entry.outputs ?? {})) {
        const collections = [
            ['image', output.images],
            ['video', output.videos],
            // GIFs are displayable images (animated), not opaque "other".
            ['image', output.gifs],
        ];
        for (const [kind, refs] of collections) {
            for (const [index, ref] of (refs ?? []).entries()) {
                if (items.length >= maxItems)
                    return items;
                // Some nodes emit audio/video filenames through the image/video
                // arrays; classify them by extension so the card renders a player.
                const itemKind = AUDIO_EXT.test(ref.filename) ? 'audio' : VIDEO_EXT.test(ref.filename) ? 'video' : kind;
                const query = new URLSearchParams({ prompt: promptId, node, index: String(index) });
                items.push({
                    ...ref,
                    node,
                    index,
                    kind: itemKind,
                    url: proxyBase !== undefined ? `${proxyBase}/comfyui/media?${query.toString()}` : ref.filename,
                });
            }
        }
    }
    return items;
}
/**
 * Extract the generated prompt text for a completed history entry. ComfyUI does
 * not persist text-node outputs in /history, so text is taken first from the
 * WebSocket `executed` capture (`wsOutputs`, a Map(nodeId -> text)), then from
 * the history `outputs` (works for literal prompts and nodes that do persist).
 * @param {*} entry - a ComfyUI history entry.
 * @param {Map<string,string>} [wsOutputs] - nodeId -> text captured at runtime.
 * @returns {string | undefined} the generated prompt text.
 */
export function collectPromptText(entry, wsOutputs) {
    if (entry === null || entry === undefined)
        return undefined;
    const workflow = entry.prompt ?? {};
    const outputs = entry.outputs ?? {};
    // Node ids referenced by a text/prompt/positive input via a link.
    const fedBy = [];
    for (const [id, node] of Object.entries(workflow)) {
        const inputs = node?.inputs ?? {};
        for (const [key, value] of Object.entries(inputs)) {
            if (Array.isArray(value) && typeof value[0] === 'string'
                && /^(text|prompt|positive|prompt_text)$/i.test(key)) {
                fedBy.push(value[0]);
            }
        }
    }
    const seen = new Set();
    for (const nodeId of fedBy) {
        if (seen.has(nodeId))
            continue;
        seen.add(nodeId);
        if (wsOutputs instanceof Map) {
            const text = wsOutputs.get(nodeId);
            if (typeof text === 'string' && text.trim() !== '')
                return text;
        }
        const historyText = historyNodeText(outputs[nodeId]);
        if (historyText !== undefined)
            return historyText;
    }
    return undefined;
}
/** First string of a history node output, if it has one. */
function historyNodeText(output) {
    if (output === null || output === undefined)
        return undefined;
    const candidates = [
        output.text,
        output.string,
        typeof output.value === 'string' ? output.value : undefined,
        Array.isArray(output.ui?.text) ? output.ui.text[0] : undefined,
    ];
    for (const value of candidates) {
        if (typeof value === 'string' && value.trim() !== '')
            return value;
    }
    return undefined;
}
