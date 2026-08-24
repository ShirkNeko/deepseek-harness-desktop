/**
 * Live generation progress, fed by ComfyUI's WebSocket. The server broadcasts
 * `progress` events ({value, max, node, prompt_id}) to every connected client,
 * so one shared socket tracks progress for all queue tasks — including ones
 * the plugin did not submit. Progress is best-effort: a remote server behind
 * an authenticating proxy (or one that never connects) simply shows queue
 * tasks without a progress bar. Reconnects on drop until dispose.
 */
export class ProgressTracker {
    progress = new Map();
    /** prompt_id -> Map(nodeId -> text) captured from `executed` ws events. */
    promptText = new Map();
    socket = null;
    retryTimer = null;
    stopped = true;
    /** Provider of the current ws URL, re-evaluated on every (re)connect. */
    _getUrl = null;
    /** Current progress for one prompt, if the server reported any. */
    get(promptId) {
        return this.progress.get(promptId);
    }
    /** Text outputs captured from the `executed` ws event for one prompt. */
    promptOutputs(promptId) {
        return this.promptText.get(promptId);
    }
    /** Start listening on the server's /ws endpoint. Accepts a url string or a provider. */
    attach(getUrl) {
        this.stopped = false;
        this._getUrl = typeof getUrl === 'function' ? getUrl : () => getUrl;
        this.connect();
    }
    connect() {
        if (this.stopped)
            return;
        const wsUrl = this._getUrl();
        let socket;
        try {
            socket = new WebSocket(wsUrl);
        }
        catch {
            this.scheduleRetry();
            return;
        }
        this.socket = socket;
        socket.addEventListener('message', (event) => this.onMessage(event.data));
        socket.addEventListener('close', () => {
            if (this.socket === socket)
                this.socket = null;
            this.scheduleRetry();
        });
        socket.addEventListener('error', () => {
            try {
                socket.close();
            }
            catch {
                // close already in flight
            }
        });
    }
    onMessage(data) {
        let message = null;
        try {
            message = JSON.parse(String(data));
        }
        catch {
            return;
        }
        // `executed` events carry a completed node's output, including the text
        // produced by prompt-generating nodes (e.g. TextGenerate). ComfyUI does
        // NOT persist that text in /history, so capture it here (best-effort;
        // some servers only emit `executed` for UI-output nodes such as images).
        if (message?.type === 'executed' && isObject(message.data)) {
            const promptId = message.data.prompt_id;
            const node = message.data.node;
            const text = firstText(message.data.output);
            if (typeof promptId === 'string' && promptId !== '' && text !== undefined) {
                let map = this.promptText.get(promptId);
                if (map === undefined) {
                    map = new Map();
                    this.promptText.set(promptId, map);
                }
                if (!map.has(node))
                    map.set(node, text);
            }
            return;
        }
        if (message?.type !== 'progress' || !isObject(message.data))
            return;
        const promptId = message.data.prompt_id;
        const value = message.data.value;
        const max = message.data.max;
        if (typeof promptId !== 'string' || promptId === '' || typeof value !== 'number' || typeof max !== 'number')
            return;
        this.progress.set(promptId, {
            value,
            max,
            node: typeof message.data.node === 'number' ? message.data.node : null,
        });
    }
    scheduleRetry() {
        if (this.stopped || this.retryTimer !== null)
            return;
        this.retryTimer = setTimeout(() => {
            this.retryTimer = null;
            this.connect();
        }, 3_000);
    }
    dispose() {
        this.stopped = true;
        if (this.retryTimer !== null) {
            clearTimeout(this.retryTimer);
            this.retryTimer = null;
        }
        if (this.socket !== null) {
            try {
                this.socket.close();
            }
            catch {
                // already closed
            }
            this.socket = null;
        }
    }
}
function isObject(value) {
    return typeof value === 'object' && value !== null;
}
/** First string-ish value of an `executed` node output (recursive). */
function firstText(output) {
    const found = firstString(output);
    return found !== undefined && found.trim() !== '' ? found : undefined;
}
/** Deeply find the first non-empty string in any nested value. */
function firstString(value) {
    if (typeof value === 'string')
        return value;
    if (value === null || value === undefined)
        return undefined;
    if (Array.isArray(value)) {
        for (const item of value) {
            const text = firstString(item);
            if (text !== undefined)
                return text;
        }
        return undefined;
    }
    if (isObject(value)) {
        for (const key of ['text', 'string', 'value', 's', '0', '1', 'output']) {
            const text = firstString(value[key]);
            if (text !== undefined)
                return text;
        }
        for (const item of Object.values(value)) {
            const text = firstString(item);
            if (text !== undefined)
                return text;
        }
    }
    return undefined;
}
