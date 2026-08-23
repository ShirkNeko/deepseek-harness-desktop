/**
 * dsh-system-monitor 主机半区。
 *
 * 采集本机遥测数据并通过只读路由 /api/system-monitor 提供给浏览器底部栏：
 *   - CPU：温度 / 占用率 / 预计功耗（Windows 性能计数器 + RAPL）
 *   - GPU：温度 / 占用率 / 功耗 / 显存 / 显存频率（nvidia-smi）
 *   - 内存：占用百分比与已用/总量（Node os）
 *
 * 这是非官方插件，不修改 DSH 官方源码包，只通过 patch-layer bundle 注入。
 */
import { spawn } from 'node:child_process'
import * as os from 'node:os'

/** 稳定插件名。 */
export const name = 'dsh-system-monitor'

/** 插件启动前等待的服务。 */
export const inject = ['webServer']

const ROUTE_PATH = '/api/system-monitor'
const ROUTE_PROXY_PATH = '/api/system-monitor/proxy'

/** 使用绝对路径，避免桌面进程 PATH 被裁剪后找不到系统命令。 */
const SYSTEM_ROOT = process.env.SystemRoot ?? 'C:\\Windows'
const POWERSHELL_EXE = `${SYSTEM_ROOT}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`
const NVIDIA_SMI_EXE = `${SYSTEM_ROOT}\\System32\\nvidia-smi.exe`

/** Windows 性能计数器：一次 Get-Counter 采样 CPU / 热区 / RAPL。 */
const WINDOWS_COUNTERS_SCRIPT = [
  '$ErrorActionPreference = "SilentlyContinue"',
  '$samples = Get-Counter -Counter @("\\Processor(_Total)\\% Processor Time", "\\Thermal Zone Information(*)\\Temperature", "\\Energy Meter(*)\\Power") -SampleInterval 1 -MaxSamples 1',
  '$cpu = ($samples.CounterSamples | Where-Object { $_.Path -match "processor\\(_total\\)\\\\% processor time" } | Select-Object -First 1).CookedValue',
  '$tempMax = ($samples.CounterSamples | Where-Object { $_.Path -match "thermal zone information" } | Measure-Object -Property CookedValue -Maximum).Maximum',
  '$powerPkg = ($samples.CounterSamples | Where-Object { $_.Path -match "energy meter\\(rapl_package0_pkg\\)" } | Measure-Object -Property CookedValue -Average).Average',
  '$out = [ordered]@{',
  '  cpu = if ($null -eq $cpu) { $null } else { [math]::Round($cpu, 2) }',
  '  tempC = if ($null -eq $tempMax) { $null } else { [math]::Round(($tempMax / 10), 2) }',
  '  powerW = if ($null -eq $powerPkg) { $null } else { [math]::Round(($powerPkg / 1000), 2) }',
  '}',
  '$out | ConvertTo-Json -Compress',
].join('\n')

/** 运行命令并返回 stdout；超时或出错返回空字符串。 */
function runCommand(command, args, timeoutMs = 5000) {
  return new Promise((resolve) => {
    const child = spawn(command, [...args], {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'ignore'],
    })
    let stdout = ''
    const timer = setTimeout(() => {
      child.kill()
      resolve('')
    }, timeoutMs)
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk) => { stdout += chunk })
    child.stdout.resume()
    child.on('error', () => {
      clearTimeout(timer)
      resolve('')
    })
    child.on('close', () => {
      clearTimeout(timer)
      resolve(stdout)
    })
  })
}

/** Windows CPU/热区/功耗采样。 */
async function sampleWindowsCpu() {
  let stdout = await runCommand(
    POWERSHELL_EXE,
    ['-NoProfile', '-NonInteractive', '-Command', WINDOWS_COUNTERS_SCRIPT],
    8000,
  )
  if (stdout === '') {
    stdout = await runCommand(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', WINDOWS_COUNTERS_SCRIPT],
      8000,
    )
  }
  if (stdout === '') return { cpu: null, tempC: null, powerW: null }
  try {
    const lines = stdout.trim().split(/\r?\n/u)
    const parsed = JSON.parse(lines[lines.length - 1] ?? '')
    return {
      cpu: typeof parsed.cpu === 'number' ? parsed.cpu : null,
      tempC: typeof parsed.tempC === 'number' ? parsed.tempC : null,
      powerW: typeof parsed.powerW === 'number' ? parsed.powerW : null,
    }
  } catch {
    return { cpu: null, tempC: null, powerW: null }
  }
}

/** 解析 nvidia-smi CSV 行。 */
function parseNvidiaCsv(line) {
  const parts = line.split(',').map((part) => part.trim())
  const gpu = {
    available: true,
    tempC: parseFloat(parts[1] ?? ''),
    utilizationPercent: parseFloat(parts[2] ?? ''),
    powerW: parseFloat(parts[3] ?? ''),
    memoryUsedMb: parseFloat(parts[4] ?? ''),
    memoryTotalMb: parseFloat(parts[5] ?? ''),
    coreClockMHz: parseFloat(parts[6] ?? ''),
    memoryClockMHz: parseFloat(parts[7] ?? ''),
  }
  const name = parts[0]
  if (name !== undefined && name !== '') gpu.name = name
  return gpu
}

/** NVIDIA GPU 采样；没有 nvidia-smi 时返回 available:false。 */
async function sampleNvidia() {
  let stdout = await runCommand(
    NVIDIA_SMI_EXE,
    [
      '--query-gpu=name,temperature.gpu,utilization.gpu,power.draw,memory.used,memory.total,clocks.sm,clocks.mem',
      '--format=csv,noheader,nounits',
    ],
    5000,
  )
  if (stdout === '') {
    stdout = await runCommand(
      'nvidia-smi',
      [
        '--query-gpu=name,temperature.gpu,utilization.gpu,power.draw,memory.used,memory.total,clocks.sm,clocks.mem',
        '--format=csv,noheader,nounits',
      ],
      5000,
    )
  }
  const line = stdout.trim().split(/\r?\n/u).find((part) => part.trim() !== '')
  if (line === undefined) return { available: false }
  return parseNvidiaCsv(line)
}

function cpuTimes() {
  return os.cpus().map((cpu) => {
    const times = cpu.times
    return {
      idle: times.idle,
      total: times.user + times.nice + times.sys + times.idle + times.irq,
    }
  })
}

function sampleMemory() {
  const totalBytes = os.totalmem()
  const freeBytes = os.freemem()
  const usedBytes = totalBytes - freeBytes
  return {
    usedBytes,
    totalBytes,
    usagePercent: totalBytes === 0 ? 0 : (usedBytes / totalBytes) * 100,
  }
}

/** 增量采集器：记录上一次 CPU times，用于计算占用率。 */
class MetricCollector {
  constructor() {
    this.lastCpuTimes = cpuTimes()
  }

  sampleCpuUsage() {
    const current = cpuTimes()
    if (current.length !== this.lastCpuTimes.length) {
      this.lastCpuTimes = current
      return null
    }
    let idleDelta = 0
    let totalDelta = 0
    for (let i = 0; i < current.length; i += 1) {
      idleDelta += current[i].idle - this.lastCpuTimes[i].idle
      totalDelta += current[i].total - this.lastCpuTimes[i].total
    }
    this.lastCpuTimes = current
    if (totalDelta <= 0) return null
    return Math.max(0, 100 - (idleDelta / totalDelta) * 100)
  }

  async sample() {
    const errors = []
    const [windowsCpu, gpu] = await Promise.all([
      sampleWindowsCpu().catch((error) => {
        errors.push(`windows: ${error instanceof Error ? error.message : String(error)}`)
        return { cpu: null, tempC: null, powerW: null }
      }),
      sampleNvidia().catch((error) => {
        errors.push(`nvidia: ${error instanceof Error ? error.message : String(error)}`)
        return { available: false }
      }),
    ])
    return {
      cpu: {
        name: os.cpus()[0]?.model,
        usagePercent: this.sampleCpuUsage(),
        tempC: windowsCpu.tempC,
        powerW: windowsCpu.powerW,
      },
      gpu,
      memory: sampleMemory(),
      timestamp: Date.now(),
      errors,
    }
  }
}

/** 代理远端 DSH 的 /api/system-monitor，浏览器端跨域取数由本机转发。 */
async function proxyRemote(req, res) {
  const parsedUrl = new URL(req.url ?? '/', 'http://localhost')
  const target = parsedUrl.searchParams.get('url')
  if (target === null || target === '') {
    res.writeHead(400)
    res.end('missing url')
    return
  }
  let remote
  try {
    remote = new URL(target)
    if (remote.protocol !== 'http:' && remote.protocol !== 'https:') throw new Error('bad protocol')
  } catch {
    res.writeHead(400)
    res.end('invalid url')
    return
  }
  try {
    const response = await fetch(remote, {
      signal: AbortSignal.timeout(5000),
    })
    if (!response.ok) {
      res.writeHead(502)
      res.end(`upstream ${String(response.status)}`)
      return
    }
    const text = await response.text()
    res.writeHead(200, {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
    })
    res.end(text)
  } catch {
    res.writeHead(502)
    res.end('proxy failed')
  }
}



/**
 * 注册只读遥测路由。
 * @param {import('@deepseek-ai/cordis').Context} ctx - 主机上下文。
 */
export function apply(ctx) {
  const collector = new MetricCollector()
  let lastMetrics
  let lastRun
  const refresh = () => {
    lastRun = collector.sample().then((metrics) => {
      lastMetrics = metrics
      return metrics
    })
    return lastRun
  }
  // 启动后立即采样一次，并提供后台缓存，页面首次打开不用等 Get-Counter 的 1 秒采样。
  void refresh()
  const timer = setInterval(() => { void refresh() }, 2000)
  const route = {
    kind: 'exact',
    path: ROUTE_PATH,
    handler: async (_req, res) => {
      const metrics = lastMetrics ?? await refresh()
      res.writeHead(200, {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store',
      })
      res.end(JSON.stringify(metrics))
    },
  }
  const proxyRoute = {
    kind: 'exact',
    path: ROUTE_PROXY_PATH,
    handler: proxyRemote,
  }
  ctx.effect(() => {
    const dispose = ctx.webServer.register(route)
    const disposeProxy = ctx.webServer.register(proxyRoute)
    return () => {
      clearInterval(timer)
      dispose()
      disposeProxy()
    }
  }, `${name}: ${ROUTE_PATH} + proxy`)
}
