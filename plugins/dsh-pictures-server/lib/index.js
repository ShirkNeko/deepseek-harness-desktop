/**
 * dsh-pictures-server — serve the Pictures workspace at /pictures/* on the
 * DSH Web origin.
 *
 * The web host listens on 127.0.0.1:3080 and the public reverse proxy
 * (dsh-passwords serve-gateway) forwards every request there. This host-half
 * plugin registers a prefix route so /pictures/<file> serves files from the
 * configured root, making generated images reachable at the public path, e.g.
 *   https://<domain>/pictures/output/loli_silver_hair_sailor.png
 *
 * Root is configurable via the plugin config `root` or the PICTURES_DIR env
 * var; it defaults to D:\agent\Pictures.
 */
import { resolve, normalize, join, sep, extname } from 'node:path'
import { createReadStream, statSync } from 'node:fs'

export const name = 'dsh-pictures-server'

/** Requires the webserver route registry before this plugin runs. */
export const inject = ['webServer']

/** Extension -> Content-Type map (falls back to octet-stream). */
const MIME = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.json': 'application/json',
  '.txt': 'text/plain; charset=utf-8',
}

/**
 * Register the /pictures prefix route.
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {object} config - { root?: string }
 */
export function apply(ctx, config = {}) {
  const root = resolve(config.root || process.env.PICTURES_DIR || 'D:\\agent\\Pictures')

  ctx.effect(() => ctx.webServer.register({
    kind: 'prefix',
    path: '/pictures',
    handler(req, res) {
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        res.writeHead(405)
        res.end()
        return
      }
      let pathname
      try {
        pathname = decodeURIComponent(new URL(req.url ?? '/', 'http://x').pathname)
      } catch {
        res.writeHead(400)
        res.end()
        return
      }
      const rel = pathname.startsWith('/pictures/') ? pathname.slice('/pictures/'.length) : ''
      const target = resolve(normalize(join(root, rel)))
      // Traversal guard: must be root itself ('/') or stay under it. `sep`, not
      // '/', because resolve() emits backslash paths on Windows.
      if (rel === '' || (target !== root && !target.startsWith(root + sep))) {
        res.writeHead(403)
        res.end()
        return
      }
      let stat
      try {
        stat = statSync(target)
      } catch {
        res.writeHead(404)
        res.end()
        return
      }
      if (!stat.isFile()) {
        res.writeHead(404)
        res.end()
        return
      }
      const type = MIME[extname(target).toLowerCase()] ?? 'application/octet-stream'
      res.writeHead(200, {
        'content-type': type,
        'content-length': stat.size,
        'cache-control': 'no-cache',
        'access-control-allow-origin': '*',
      })
      if (req.method === 'HEAD') {
        res.end()
        return
      }
      createReadStream(target).pipe(res)
    },
  }), 'dsh-pictures-server: /pictures route')
}
