import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHmac } from 'node:crypto'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import {
  COMFYUI_PACKAGE,
  COMFYUI_INDEX_FILE,
  COMFYUI_HOSTHINT_FILE,
  COMFYUI_TOOLS_FILE,
  COMFYUI_ROUTES_FILE,
  COMFYUI_CLIENT_FILE,
  COMFYUI_PROGRESS_FILE,
  COMFYUI_COMFYUI_FILE,
  patchComfyuiMediaBase,
  statusComfyuiMediaBase,
  rollbackComfyuiMediaBase,
  patchComfyuiClient,
  statusComfyuiClient,
  rollbackComfyuiClient,
  patchComfyuiPromptSurface,
  statusComfyuiPromptSurface,
  rollbackComfyuiPromptSurface,
  QQCHAT_PACKAGE,
  QQCHAT_SENDTOOL_FILE,
  patchQqchatComfyuiBase,
  statusQqchatComfyuiBase,
  rollbackQqchatComfyuiBase,
} from '../lib/patch.js'

/** Build a fake `node_modules/<pkg>/<relative>` tree and return its root. */
function makeTree(pkg, relative, content) {
  const root = mkdtempSync(path.join(tmpdir(), 'dsh-patch-comfyui-qqchat-'))
  const pkgDir = path.join(root, 'node_modules', pkg)
  mkdirSync(path.dirname(path.join(pkgDir, relative)), { recursive: true })
  writeFileSync(path.join(pkgDir, relative), content)
  return root
}
function targetPath(root, pkg, relative) {
  return path.join(root, 'node_modules', pkg, relative)
}

// ---- Original (unpatched) content fixtures ----------------------------------
// host-hint.js: the original createHostHint (external ?? loopback short-circuit).
const HOSTHINT_ORIG = [
  "import { networkInterfaces } from 'node:os';",
  'export function detectLanOrigin(port) {',
  '    return undefined;',
  '}',
  'export function createHostHint() {',
  '    let loopback;',
  '    let external;',
  '    return {',
  '        record(request) {',
  '            const host = request.headers.host;',
  '            const hostOrigin = typeof host === "string" && host !== "" ? `http://${host}` : undefined;',
  '            if (hostOrigin !== undefined && hostOrigin.startsWith("http://127.0.0.1")) loopback = hostOrigin;',
  '            else external = hostOrigin;',
  '        },',
  '        origin() { return external ?? loopback; },',
  '    };',
  '}',
].join('\n')

// index.js: the original proxyBase (sync, hostHint.origin() + detectLanOrigin) + import + sweep.
// Body indentation must match the transform anchor verbatim (12-space body / 16-space nested).
const INDEX_ORIG = [
  "import { createHostHint, detectLanOrigin } from './host-hint.js';",
  'const runtime = {',
  '    proxyBase: () => {',
  "        const explicit = (resolved.mediaHost ?? '').trim().replace(/\\/+$/, '');",
  "        if (explicit !== '') return explicit;",
  '            const hinted = hostHint.origin();',
  '            if (hinted !== undefined)',
  '                return hinted;',
  "            const ws = ctx.get('webServer');",
  '            if (ws === undefined || ws.port === undefined)',
  '                return undefined;',
  '            const lan = detectLanOrigin(ws.port);',
  '            if (lan !== undefined)',
  '                return lan;',
  "            const host = ws.host === '0.0.0.0' ? '127.0.0.1' : ws.host ?? '127.0.0.1';",
  '            return `http://${host}:${ws.port}`;',
  '    },',
  '    sweep: async () => {',
  '        return tracker.sweep({ client, store, maxItems: resolved.maxMediaItems, proxyBase: runtime.proxyBase() });',
  '    },',
  '};',
].join('\n')

// tools.js / routes.js: a single collectMedia call using the sync proxybase.
const AWAIT_ORIG = [
  'const items = collectMedia({ promptId, entry, maxItems: config.maxMediaItems, proxyBase: runtime.proxyBase() });',
  'return items;',
].join('\n')

// qqchat send-tool.js: original fetch(URL) block + import.
const QQCHAT_ORIG = [
  "import { defineTool } from '@deepseek-ai/dsh-tools';",
  'export function registerQQSendImageTool(ctx, db, api, isAllowed = () => true) {',
  '    const definition = defineTool({',
  '        async execute(args, exec) {',
  '            const source = String(args.image || \'\');',
  '            if (source.startsWith(\'data:\')) {',
  "                fileData = source.slice(source.indexOf(',') + 1);",
  '            } else if (/^https?:\\/\\//i.test(source)) {',
  '                const response = await fetch(source, { signal: AbortSignal.timeout(30_000) });',
  '                if (!response.ok) return { ok: false, error: `图片下载失败: HTTP ${response.status}` };',
  '                const bytes = new Uint8Array(await response.arrayBuffer());',
  "                fileData = Buffer.from(bytes).toString('base64');",
  '            }',
  '        },',
  '    });',
  '}',
].join('\n')

// comfyui client.js: the unpatched card/lightbox uses the baked URL verbatim.
const CLIENT_ORIG = [
  '\t\tfunction MediaItem({ item, t, onOpen }) {',
  '\t\t\tconst media = item.kind === "video" ? h("video", {',
  '\t\t\t\tsrc: item.url,',
  '\t\t\t\tcontrols: true',
  '\t\t\t}) : item.kind === "image" ? h("img", {',
  '\t\t\t\tsrc: item.url,',
  '\t\t\t\talt: item.filename',
  '\t\t\t}) : h("span", {});',
  '\t\t\treturn h("div", {}, media, h("a", {',
  '\t\t\t\thref: item.url,',
  '\t\t\t\tdownload: item.filename',
  '\t\t\t}, "dl"));',
  '\t\t}',
  '\t\tconst src = images[index];',
].join('\n')

test('comfyui media-base patch: full original -> patched -> rollback chain', () => {
  const hosts = makeTree(COMFYUI_PACKAGE, COMFYUI_HOSTHINT_FILE, HOSTHINT_ORIG)
  const idx = makeTree(COMFYUI_PACKAGE, COMFYUI_INDEX_FILE, INDEX_ORIG)
  const tools = makeTree(COMFYUI_PACKAGE, COMFYUI_TOOLS_FILE, AWAIT_ORIG)
  const routes = makeTree(COMFYUI_PACKAGE, COMFYUI_ROUTES_FILE, AWAIT_ORIG)
  const anchors = [hosts, idx, tools, routes]
  try {
    // Disabled before patching.
    let status = statusComfyuiMediaBase(anchors)
    assert.equal(status.length, 4)
    assert.ok(status.every((s) => s.found && !s.enabled))

    const patched = patchComfyuiMediaBase(anchors)
    assert.ok(patched.applied >= 1)

    // host-hint.js now carries the three-address resolver + probe marker.
    const hostHintPatched = readFileSync(targetPath(hosts, COMFYUI_PACKAGE, COMFYUI_HOSTHINT_FILE), 'utf8')
    assert.ok(hostHintPatched.includes('resolveMediaBase(port)'))
    assert.ok(hostHintPatched.includes('externalOrigin()'))
    assert.ok(hostHintPatched.includes('probeCandidates(port)'))

    // index.js is now async and calls resolveMediaBase; import + sweep updated.
    const indexPatched = readFileSync(targetPath(idx, COMFYUI_PACKAGE, COMFYUI_INDEX_FILE), 'utf8')
    assert.ok(indexPatched.includes('proxyBase: async () => {'))
    assert.ok(indexPatched.includes('return hostHint.resolveMediaBase(ws.port);'))
    assert.ok(indexPatched.includes("import { createHostHint } from './host-hint.js';"))
    assert.ok(indexPatched.includes('proxyBase: await runtime.proxyBase()'))

    // tools.js / routes.js await the async proxybase.
    for (const root of [tools, routes]) {
      const content = readFileSync(targetPath(root, COMFYUI_PACKAGE, root === tools ? COMFYUI_TOOLS_FILE : COMFYUI_ROUTES_FILE), 'utf8')
      assert.ok(content.includes('proxyBase: await runtime.proxyBase()'))
    }

    assert.ok(statusComfyuiMediaBase(anchors).every((s) => s.enabled))

    // Idempotent second apply.
    const again = patchComfyuiMediaBase(anchors)
    assert.equal(again.applied, 0)
    assert.ok(again.unchanged >= 4)

    // Rollback restores each original exactly.
    const rolled = rollbackComfyuiMediaBase(anchors)
    assert.equal(rolled.rolledBack, 4)
    assert.equal(readFileSync(targetPath(hosts, COMFYUI_PACKAGE, COMFYUI_HOSTHINT_FILE), 'utf8'), HOSTHINT_ORIG)
    assert.equal(readFileSync(targetPath(idx, COMFYUI_PACKAGE, COMFYUI_INDEX_FILE), 'utf8'), INDEX_ORIG)
    assert.equal(readFileSync(targetPath(tools, COMFYUI_PACKAGE, COMFYUI_TOOLS_FILE), 'utf8'), AWAIT_ORIG)
    assert.equal(readFileSync(targetPath(routes, COMFYUI_PACKAGE, COMFYUI_ROUTES_FILE), 'utf8'), AWAIT_ORIG)
  } finally {
    for (const r of [hosts, idx, tools, routes]) rmSync(r, { recursive: true, force: true })
  }
})

test('comfyui client patch rewrites loopback media URLs to the browser origin', () => {
  const cl = makeTree(COMFYUI_PACKAGE, COMFYUI_CLIENT_FILE, CLIENT_ORIG)
  try {
    const before = statusComfyuiClient([cl])
    assert.ok(before[0].found && !before[0].enabled)

    const patched = patchComfyuiClient([cl])
    assert.equal(patched.applied, 1)
    const content = readFileSync(targetPath(cl, COMFYUI_PACKAGE, COMFYUI_CLIENT_FILE), 'utf8')
    // mediaSrc helper injected + card img/video/audio + download + lightbox all use it.
    assert.ok(content.includes('function mediaSrc(url)'))
    assert.ok(content.includes('src: mediaSrc(item.url),'))
    assert.ok(content.includes('href: mediaSrc(item.url),'))
    assert.ok(content.includes('const src = mediaSrc(images[index]);'))
    assert.ok(statusComfyuiClient([cl])[0].enabled)

    // Idempotent.
    const again = patchComfyuiClient([cl])
    assert.equal(again.applied, 0)
    assert.equal(again.unchanged, 1)

    const rolled = rollbackComfyuiClient([cl])
    assert.equal(rolled.rolledBack, 1)
    assert.equal(readFileSync(targetPath(cl, COMFYUI_PACKAGE, COMFYUI_CLIENT_FILE), 'utf8'), CLIENT_ORIG)
  } finally {
    rmSync(cl, { recursive: true, force: true })
  }
})

test('comfyui prompt-surface patch: adds prompt to results (via ws + history graph)', () => {
  const comfyuiOrig = "import { collectMedia, hasMedia } from './comfyui.js';\nexport function collectMedia(opts) { return []; }\nexport function historyErrorMessage(a,b){ return 'x'; }\n"
  const progressOrig = "export class ProgressTracker {\n  progress = new Map();\n  get(promptId) { return this.progress.get(promptId); }\n  onMessage(data) { return; }\n}\n"
  const toolsOrig = "import { collectMedia } from './comfyui.js';\nconst result = {\n  media: items,\n  summary: summarizeMedia(items),\n};\nreturn result;\n"
  const indexOrig = "const runtime = {\n  queueProgress: (promptId) => progress.get(promptId),\n  sweep: async () => { return tracker.sweep({ client, store, maxItems, proxyBase: runtime.proxyBase() }); },\n};\nctx.effect(() => {\n        const wsUrl = resolved.baseUrl.replace(/^http:/, 'ws:').replace(/^https:/, 'wss:').replace(/\\/$/, '') + `/ws?clientId=${CLIENT_ID}`;\n        progress.attach(wsUrl);\n        return () => progress.dispose();\n}, 'dsh-comfyui: progress');\n"

  const c = makeTree(COMFYUI_PACKAGE, COMFYUI_COMFYUI_FILE, comfyuiOrig)
  const p = makeTree(COMFYUI_PACKAGE, COMFYUI_PROGRESS_FILE, progressOrig)
  const t = makeTree(COMFYUI_PACKAGE, COMFYUI_TOOLS_FILE, toolsOrig)
  const i = makeTree(COMFYUI_PACKAGE, COMFYUI_INDEX_FILE, indexOrig)
  const anchors = [c, p, t, i]
  try {
    const before = statusComfyuiPromptSurface(anchors)
    assert.equal(before.length, 4)
    assert.ok(before.every((s) => s.found && !s.enabled))

    const patched = patchComfyuiPromptSurface(anchors)
    assert.ok(patched.applied >= 1)

    // comfyui.js now has collectPromptText (whole-file rewrite).
    assert.ok(readFileSync(targetPath(c, COMFYUI_PACKAGE, COMFYUI_COMFYUI_FILE), 'utf8').includes('export function collectPromptText'))
    // progress.js captures executed text outputs.
    assert.ok(readFileSync(targetPath(p, COMFYUI_PACKAGE, COMFYUI_PROGRESS_FILE), 'utf8').includes("promptOutputs(promptId)"))
    // tools.js result carries the prompt field + import.
    const toolsPatched = readFileSync(targetPath(t, COMFYUI_PACKAGE, COMFYUI_TOOLS_FILE), 'utf8')
    assert.ok(toolsPatched.includes('import { collectMedia, collectPromptText }'))
    assert.ok(toolsPatched.includes('prompt: collectPromptText(entry, runtime.queuedPromptOutputs(promptId)),'))
    // index.js exposes queuedPromptOutputs + passes wsOutputs to sweep.
    const indexPatched = readFileSync(targetPath(i, COMFYUI_PACKAGE, COMFYUI_INDEX_FILE), 'utf8')
    assert.ok(indexPatched.includes('queuedPromptOutputs: (promptId) => progress.promptOutputs(promptId),'))
    assert.ok(indexPatched.includes('wsOutputs: runtime.queuedPromptOutputs'))

    assert.ok(statusComfyuiPromptSurface(anchors).every((s) => s.enabled))

    const again = patchComfyuiPromptSurface(anchors)
    assert.equal(again.applied, 0)
    const rolled = rollbackComfyuiPromptSurface(anchors)
    assert.equal(rolled.rolledBack, 4)
    assert.equal(readFileSync(targetPath(c, COMFYUI_PACKAGE, COMFYUI_COMFYUI_FILE), 'utf8'), comfyuiOrig)
    assert.equal(readFileSync(targetPath(p, COMFYUI_PACKAGE, COMFYUI_PROGRESS_FILE), 'utf8'), progressOrig)
    assert.equal(readFileSync(targetPath(t, COMFYUI_PACKAGE, COMFYUI_TOOLS_FILE), 'utf8'), toolsOrig)
    assert.equal(readFileSync(targetPath(i, COMFYUI_PACKAGE, COMFYUI_INDEX_FILE), 'utf8'), indexOrig)
  } finally {
    for (const r of [c, p, t, i]) rmSync(r, { recursive: true, force: true })
  }
})

test('qqchat ComfyUI base patch appends a short-lived signed ?token= (bypass gateway)', () => {
  const qq = makeTree(QQCHAT_PACKAGE, QQCHAT_SENDTOOL_FILE, QQCHAT_ORIG)
  try {
    const before = statusQqchatComfyuiBase([qq])
    assert.ok(before[0].found && !before[0].enabled)

    const patched = patchQqchatComfyuiBase([qq])
    assert.equal(patched.applied, 1)
    const content = readFileSync(targetPath(qq, QQCHAT_PACKAGE, QQCHAT_SENDTOOL_FILE), 'utf8')
    // Helper injected + fetch uses it.
    assert.ok(content.includes('function resolveComfyuiMediaUrl(source)'))
    assert.ok(content.includes('fetch(resolveComfyuiMediaUrl(source), { signal: AbortSignal.timeout(30_000) })'))
    assert.ok(content.includes("import { createHmac } from 'node:crypto';"))
    assert.ok(statusQqchatComfyuiBase([qq])[0].enabled)

    // With the shared secret set, the helper appends a signed ?token= to comfyui
    // media URLs; non-media URLs and media without a secret are left unchanged. A
    // /comfyui/media URL on the same path always gets a token (the gateway
    // validates it), so the fetch gets past the dsh-passwords login page.
    const fnSrc = content.match(/function resolveComfyuiMediaUrl\(source\) \{[\s\S]*?\n\}/)
    assert.ok(fnSrc)
    const fn = new Function('createHmac', `return (${fnSrc[0]})`)(createHmac)
    const prev = process.env.DSH_GATEWAY_MEDIA_TOKEN_SECRET
    process.env.DSH_GATEWAY_MEDIA_TOKEN_SECRET = 'test-secret'
    const out = fn('https://dsh.neko.shirkneko.cn:10014/comfyui/media?prompt=p&node=9&index=0')
    assert.ok(out.startsWith('https://dsh.neko.shirkneko.cn:10014/comfyui/media?prompt=p&node=9&index=0&token='))
    const token = decodeURIComponent(out.split('token=')[1])
    const [b64, exp, ] = token.split('.')
    assert.equal(Buffer.from(b64, 'base64url').toString('utf8'), '/comfyui/media')
    assert.ok(Number(exp) > Date.now())
    assert.equal(fn('https://example.com/foo.png'), 'https://example.com/foo.png')
    delete process.env.DSH_GATEWAY_MEDIA_TOKEN_SECRET
    // Without the secret the bypass is disabled (URL unchanged).
    assert.equal(
      fn('https://dsh.neko.shirkneko.cn:10014/comfyui/media?prompt=p&node=9&index=0'),
      'https://dsh.neko.shirkneko.cn:10014/comfyui/media?prompt=p&node=9&index=0',
    )
    if (prev === undefined) delete process.env.DSH_GATEWAY_MEDIA_TOKEN_SECRET
    else process.env.DSH_GATEWAY_MEDIA_TOKEN_SECRET = prev

    // Idempotent.
    const again = patchQqchatComfyuiBase([qq])
    assert.equal(again.applied, 0)
    assert.equal(again.unchanged, 1)

    const rolled = rollbackQqchatComfyuiBase([qq])
    assert.equal(rolled.rolledBack, 1)
    assert.equal(readFileSync(targetPath(qq, QQCHAT_PACKAGE, QQCHAT_SENDTOOL_FILE), 'utf8'), QQCHAT_ORIG)
  } finally {
    rmSync(qq, { recursive: true, force: true })
  }
})
