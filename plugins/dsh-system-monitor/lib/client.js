/**
 * dsh-system-monitor browser half - final direct-DOM design.
 *
 * The monitor bar is injected inside [data-composer-seat], so it is embedded
 * in the composer area and does not cause page scrolling. It caches the last
 * metrics so setting changes render immediately.
 */
(function () {
  'use strict'

  var PLUGIN_ID = 'dsh-system-monitor'
  var STYLE_ID = PLUGIN_ID + '/client.css'
  var SETTINGS_KEY = 'dsh-system-monitor-settings'
  var BAR_ID = PLUGIN_ID + '-global-bar'
  var BAR_CLASS = 'dsh-system-monitor-bar'
  var GROUP_CLASS = 'dsh-system-monitor-group'
  var LABEL_CLASS = 'dsh-system-monitor-label'
  var VALUE_CLASS = 'dsh-system-monitor-value'
  var MUTED_CLASS = 'dsh-system-monitor-muted'
  var SEP_CLASS = 'dsh-system-monitor-sep'

  var L10N_ZH = {
    enable: '\u542f\u7528\u76d1\u63a7\u680f',
    showCpu: '\u663e\u793a CPU',
    showGpu: '\u663e\u793a GPU',
    showMemory: '\u663e\u793a\u5185\u5b58',
    showTooltip: '\u663e\u793a\u63d0\u793a',
    refresh2: '\u6bcf 2 \u79d2\u5237\u65b0',
    refresh5: '\u6bcf 5 \u79d2\u5237\u65b0',
    preferRemote: '\u6709\u8fdc\u7aef\u6570\u636e\u65f6\u4ec5\u663e\u793a\u8fdc\u7aef',
    addRemote: '\u65b0\u589e\u8fdc\u7aef\u673a\u5668',
    remove: '\u5220\u9664',
    systemMonitor: '\u7cfb\u7edf\u76d1\u63a7',
    remoteMachine: '\u8fdc\u7aef\u673a\u5668',
    unavailable: '\u76d1\u63a7\u4e0d\u53ef\u7528',
    enableSource: '\u542f\u7528',
    description: 'CPU / GPU / \u5185\u5b58\u76d1\u63a7',
    remoteUrl: '\u8fdc\u7aef\u76d1\u63a7 API \u5730\u5740',
    label: '\u540d\u79f0',
    localMachine: '\u672c\u673a',
  }
  var L10N_EN = {
    enable: 'Enable monitor bar',
    showCpu: 'Show CPU',
    showGpu: 'Show GPU',
    showMemory: 'Show Memory',
    showTooltip: 'Show tooltip',
    refresh2: 'Refresh every 2s',
    refresh5: 'Refresh every 5s',
    preferRemote: 'Use remote only when available',
    addRemote: 'Add remote machine',
    remove: 'Remove',
    systemMonitor: 'System Monitor',
    remoteMachine: 'Remote machine',
    unavailable: 'monitoring unavailable',
    enableSource: 'Enable',
    description: 'CPU / GPU / Memory monitor',
    remoteUrl: 'Remote monitor API URL',
    label: 'Label',
    localMachine: 'Local machine',
  }

  function t(key) {
    var lang = 'en'
    try {
      lang = document.documentElement.lang || navigator.language || 'en'
    } catch (error) {
      lang = 'en'
    }
    var dict = String(lang).toLowerCase().indexOf('zh') === 0 ? L10N_ZH : L10N_EN
    return dict[key] !== undefined ? dict[key] : L10N_EN[key] || key
  }

  var DEFAULT_SETTINGS = {
    enabled: true,
    intervalMs: 2000,
    showCpu: true,
    showGpu: true,
    showMemory: true,
    showTooltip: true,
    preferRemote: false,
    sources: [
      { id: 'local', label: 'local', url: '/api/system-monitor', enabled: true, local: true }
    ]
  }

  function readSettings() {
    try {
      var raw = localStorage.getItem(SETTINGS_KEY)
      if (raw === null) return DEFAULT_SETTINGS
      var parsed = JSON.parse(raw)
      var merged = {}
      for (var key in DEFAULT_SETTINGS) merged[key] = DEFAULT_SETTINGS[key]
      for (var pkey in parsed) merged[pkey] = parsed[pkey]
      if (!Array.isArray(merged.sources)) merged.sources = DEFAULT_SETTINGS.sources
      return merged
    } catch (error) {
      return DEFAULT_SETTINGS
    }
  }

  function notifySettingsChanged() {
    try {
      window.dispatchEvent(new CustomEvent('dsh-system-monitor-settings-changed'))
    } catch (error) {
      // ignore
    }
  }

  function writeSettings(settings) {
    try {
      localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings))
      notifySettingsChanged()
    } catch (error) {
      // localStorage can be unavailable; the bar still works.
    }
  }

  var CSS = [
    '.' + BAR_CLASS + '{display:block;text-align:center;max-width:var(--dsh-chat-content-width);width:100%;margin:-2px auto 0;box-sizing:border-box;padding:0 calc(var(--dsh-composer-side-clearance) + 16px) 4px;font-size:12px;line-height:20px;color:var(--dsw-alias-label-secondary);background:transparent;border-top:0;white-space:nowrap;overflow-x:auto;font-variant-numeric:tabular-nums;user-select:none}',
    '.' + GROUP_CLASS + '{display:inline-flex;align-items:center;gap:4px;margin:0 6px;white-space:nowrap}',
    '.' + LABEL_CLASS + '{opacity:.78;font-weight:600}',
    '.' + VALUE_CLASS + '{font-weight:500}',
    '.' + MUTED_CLASS + '{opacity:.5}',
    '.' + SEP_CLASS + '{margin:0 2px;color:var(--dsw-alias-label-tertiary);opacity:.6}',
  ].join('')

  function injectStyle() {
    if (typeof document === 'undefined') return
    if (document.querySelector('style[data-plugin-css="' + STYLE_ID + '"]') !== null) return
    var style = document.createElement('style')
    style.setAttribute('data-plugin', PLUGIN_ID)
    style.setAttribute('data-plugin-css', STYLE_ID)
    style.textContent = CSS
    document.head.appendChild(style)
  }

  function formatPercent(value) {
    if (value === null || value === undefined || Number.isNaN(value)) return '--'
    return Math.round(value) + '%'
  }

  function formatTemperature(value) {
    if (value === null || value === undefined || Number.isNaN(value)) return '--'
    return Math.round(value) + '\u00b0C'
  }

  function formatPower(value) {
    if (value === null || value === undefined || Number.isNaN(value)) return '--'
    return value.toFixed(0) + 'W'
  }

  function formatMegabytes(value) {
    if (value === null || value === undefined || Number.isNaN(value)) return '--'
    return (value / 1024).toFixed(1) + 'G'
  }

  function formatClock(value) {
    if (value === null || value === undefined || Number.isNaN(value)) return '--'
    return Math.round(value) + 'MHz'
  }

  function formatMemoryPart(bytes) {
    return (bytes / (1024 * 1024 * 1024)).toFixed(1) + 'G'
  }

  function sourceFetchUrl(source) {
    if (source.local) return source.url
    return '/api/system-monitor/proxy?url=' + encodeURIComponent(source.url)
  }

  function createGlobalBar() {
    if (typeof document === 'undefined') return function () {}
    var existing = document.getElementById(BAR_ID)
    if (existing !== null) existing.remove()

    var bar = document.createElement('div')
    bar.id = BAR_ID
    bar.className = BAR_CLASS
    bar.setAttribute('data-testid', 'system-monitor-bar')
    var lastRows = []

    function valueSpan(text) {
      var span = document.createElement('span')
      span.className = VALUE_CLASS
      span.textContent = text
      return span
    }

    function renderSource(source, metrics, settings, root) {
      if (metrics === null) {
        var unavailable = document.createElement('span')
        unavailable.className = MUTED_CLASS
        unavailable.textContent = source.label + ' ' + t('unavailable')
        root.appendChild(unavailable)
        return
      }
      var prefix = source.local ? '' : source.label + ' '
      var hasSection = false
      function addSection(labelText, values, title) {
        var group = document.createElement('span')
        group.className = GROUP_CLASS
        if (title !== undefined) group.title = title
        var label = document.createElement('span')
        label.className = LABEL_CLASS
        label.textContent = labelText
        group.appendChild(label)
        for (var i = 0; i < values.length; i += 1) {
          group.appendChild(valueSpan(values[i]))
        }
        if (hasSection) {
          var sep = document.createElement('span')
          sep.className = SEP_CLASS
          sep.textContent = ' | '
          root.appendChild(sep)
        }
        root.appendChild(group)
        hasSection = true
      }
      if (settings.showCpu && metrics.cpu !== undefined) {
        addSection(prefix + 'CPU', [
          formatPercent(metrics.cpu.usagePercent),
          formatTemperature(metrics.cpu.tempC),
          formatPower(metrics.cpu.powerW),
        ], metrics.cpu.name)
      }
      if (settings.showGpu && metrics.gpu !== undefined && metrics.gpu.available === true) {
        addSection(prefix + 'GPU', [
          formatPercent(metrics.gpu.utilizationPercent),
          formatTemperature(metrics.gpu.tempC),
          formatPower(metrics.gpu.powerW),
          formatMegabytes(metrics.gpu.memoryUsedMb) + '/' + formatMegabytes(metrics.gpu.memoryTotalMb),
          formatClock(metrics.gpu.memoryClockMHz),
        ], metrics.gpu.name)
      }
      if (settings.showMemory && metrics.memory !== undefined) {
        addSection(prefix + 'MEM', [
          Math.round(metrics.memory.usagePercent) + '%',
          formatMemoryPart(metrics.memory.usedBytes) + '/' + formatMemoryPart(metrics.memory.totalBytes),
        ])
      }
    }

    function renderRows(rows, settings) {
      bar.textContent = ''
      if (!settings.enabled) return
      if (rows.length === 0) {
        bar.textContent = t('unavailable')
        return
      }
      for (var r = 0; r < rows.length; r += 1) {
        if (r > 0) {
          var sep = document.createElement('span')
          sep.className = SEP_CLASS
          sep.textContent = ' | '
          bar.appendChild(sep)
        }
        renderSource(rows[r].source, rows[r].metrics, settings, bar)
      }
    }

    function showHide() {
      bar.style.display = readSettings().enabled ? '' : 'none'
    }

    function tick() {
      var settings = readSettings()
      var enabled = settings.sources.filter(function (source) { return source.enabled })
      var useRemoteOnly = settings.preferRemote && enabled.some(function (source) { return !source.local })
      var targets = enabled.filter(function (source) {
        return !(useRemoteOnly && source.local)
      })
      if (targets.length === 0) {
        lastRows = []
        renderRows(lastRows, settings)
        return
      }
      Promise.all(targets.map(function (source) {
        return fetch(sourceFetchUrl(source), { cache: 'no-store' })
          .then(function (response) {
            if (!response.ok) throw new Error('HTTP ' + response.status)
            return response.json()
          })
          .then(function (json) { return { source: source, metrics: json } })
          .catch(function () { return { source: source, metrics: null } })
      })).then(function (rows) {
        lastRows = rows
        renderRows(rows, readSettings())
      })
    }

    function onSettingsChanged() {
      showHide()
      renderRows(lastRows, readSettings())
      tick()
    }

    function attachBar() {
      var seat = document.querySelector('[data-composer-seat]')
      if (seat === null) return false
      if (bar.parentNode === seat) return true
      if (bar.parentNode !== null) bar.parentNode.removeChild(bar)
      seat.appendChild(bar)
      return true
    }

    attachBar()
    showHide()
    tick()
    var timer = window.setInterval(tick, 2000)
    var attachTimer = window.setInterval(attachBar, 500)
    window.addEventListener('storage', onSettingsChanged)
    window.addEventListener('dsh-system-monitor-settings-changed', onSettingsChanged)

    return function () {
      clearInterval(timer)
      clearInterval(attachTimer)
      window.removeEventListener('storage', onSettingsChanged)
      window.removeEventListener('dsh-system-monitor-settings-changed', onSettingsChanged)
      if (bar.parentNode !== null) bar.parentNode.removeChild(bar)
    }
  }

  function factory(require) {
    injectStyle()
    var React = require('react')
    var createElement = React.createElement
    var useState = React.useState

    var cardStyle = {
      display: 'flex',
      flexDirection: 'column',
      gap: 6,
      maxWidth: 520,
      padding: 16,
      borderRadius: 12,
      border: '1px solid var(--dsw-alias-border-l1)',
      background: 'var(--dsw-alias-bg-layer-2)',
      color: 'var(--dsw-alias-label-primary)',
      fontSize: 12,
      boxShadow: '0 1px 3px rgba(0,0,0,0.06)',
    }
    var titleStyle = {
      fontSize: 14,
      fontWeight: 700,
      paddingBottom: 8,
      marginBottom: 2,
      borderBottom: '1px solid var(--dsw-alias-border-l1)',
      color: 'var(--dsw-alias-label-primary)',
    }
    var descStyle = {
      fontSize: 11,
      lineHeight: '16px',
      color: 'var(--dsw-alias-label-tertiary)',
      marginBottom: 4,
    }
    var rowStyle = {
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'space-between',
      gap: 12,
      padding: '6px 0',
      fontSize: 12,
      borderBottom: '1px solid var(--dsw-alias-border-l1)',
    }
    var buttonStyle = {
      padding: '5px 12px',
      fontSize: 12,
      borderRadius: 6,
      border: '1px solid var(--dsw-alias-border-l1)',
      background: 'var(--dsw-alias-bg-layer-2)',
      color: 'var(--dsw-alias-label-primary)',
      cursor: 'pointer',
    }

    function SettingsToggle(props) {
      return createElement(
        'label',
        { style: rowStyle },
        createElement('span', null, props.label),
        createElement('input', {
          type: 'checkbox',
          checked: props.checked,
          onChange: function (event) { props.onChange(event.target.checked) },
        }),
      )
    }

    function sourceDisplayName(source) {
      return source.local ? t('localMachine') : source.label
    }

    function SystemMonitorSettings() {
      var settingsState = useState(readSettings)
      var settings = settingsState[0]
      var setSettings = settingsState[1]
      function update(patch) {
        var next = {}
        for (var key in settings) next[key] = settings[key]
        for (var pkey in patch) next[pkey] = patch[pkey]
        setSettings(next)
        writeSettings(next)
      }
      function addRemote() {
        var url = window.prompt(t('remoteUrl'), 'http://192.168.1.10:3080/api/system-monitor')
        if (url === null || url.trim() === '') return
        var label = window.prompt(t('label'), t('remoteMachine'))
        if (label === null || label.trim() === '') label = t('remoteMachine')
        var nextSources = settings.sources.slice()
        nextSources.push({ id: 'remote-' + Date.now().toString(36), label: label, url: url, enabled: true, local: false })
        update({ sources: nextSources })
      }
      function removeSource(id) {
        update({ sources: settings.sources.filter(function (source) { return source.id !== id }) })
      }
      function toggleSource(id, enabled) {
        update({ sources: settings.sources.map(function (source) {
          if (source.id === id) return Object.assign({}, source, { enabled: enabled })
          return source
        }) })
      }
      var children = [
        createElement('div', { style: titleStyle }, t('systemMonitor')),
        createElement('div', { style: descStyle }, t('description')),
        createElement(SettingsToggle, { label: t('enable'), checked: settings.enabled, onChange: function (value) { update({ enabled: value }) } }),
        createElement(SettingsToggle, { label: t('showCpu'), checked: settings.showCpu, onChange: function (value) { update({ showCpu: value }) } }),
        createElement(SettingsToggle, { label: t('showGpu'), checked: settings.showGpu, onChange: function (value) { update({ showGpu: value }) } }),
        createElement(SettingsToggle, { label: t('showMemory'), checked: settings.showMemory, onChange: function (value) { update({ showMemory: value }) } }),
        createElement(SettingsToggle, { label: t('showTooltip'), checked: settings.showTooltip, onChange: function (value) { update({ showTooltip: value }) } }),
        createElement(SettingsToggle, { label: t('refresh2'), checked: settings.intervalMs === 2000, onChange: function (value) { update({ intervalMs: value ? 2000 : 5000 }) } }),
        createElement(SettingsToggle, { label: t('preferRemote'), checked: settings.preferRemote, onChange: function (value) { update({ preferRemote: value }) } }),
      ]
      for (var i = 0; i < settings.sources.length; i += 1) {
        var source = settings.sources[i]
        children.push(createElement('div', { style: descStyle }, sourceDisplayName(source) + ' (' + source.url + ')'))
        children.push(createElement(SettingsToggle, {
          label: t('enableSource') + ' ' + sourceDisplayName(source),
          checked: source.enabled,
          onChange: function (value) { toggleSource(source.id, value) },
        }))
        if (!source.local) {
          children.push(createElement('button', { style: buttonStyle, onClick: function () { removeSource(source.id) } }, t('remove')))
        }
      }
      children.push(createElement('button', { style: buttonStyle, onClick: addRemote }, t('addRemote')))
      return createElement('div', { style: cardStyle }, children)
    }

    return {
      inject: ['slots'],
      apply: function (ctx) {
        ctx.effect(function () {
          return createGlobalBar()
        }, PLUGIN_ID + ': global-bar')

        ctx.effect(function () {
          return ctx.slots.inject('settings.section', function () {
            return ctx.slots.register({
              name: 'settings.section',
              id: 'system-monitor',
              order: 20,
              label: function () { return t('systemMonitor') },
            }, SystemMonitorSettings)
          })
        }, PLUGIN_ID + ': settings.section')
      },
    }
  }

  window.__ModuleLoader__.load({ id: PLUGIN_ID, factory: factory })
})()