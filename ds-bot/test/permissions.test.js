import assert from 'node:assert/strict'
import { test } from 'node:test'
import { install } from '../src/host/permissions.js'

const PRESETS = { 'workspace-write': {}, 'danger-full-access': {} }
const CONFIGURED = Object.keys(PRESETS)
const AUTO_SPEC = { approval: 'ask' }
const sessionOnly = auto => [...CONFIGURED, ...(auto ? ['auto'] : [])]
const optionsOf = auto => sessionOnly(auto).map(value => ({ value, name: value }))

function runtime({ presets = true, auto = false, fail = false, failGroups = false, bots = {}, prefs = {} } = {}) {
  const writes = []
  const saves = []
  const warnings = []
  const service = {
    // DSH: `options` takes a live Auto review, `defaultOptions` never does.
    catalog: () => ({ options: optionsOf(auto), defaultOptions: CONFIGURED.map(value => ({ value, name: value })), defaultPreset: 'workspace-write' }),
    resolve: (name) => { if (!(name in PRESETS) && !(auto && name === 'auto')) throw new Error(`permission: unknown preset "${name}"`); return name === 'auto' ? AUTO_SPEC : PRESETS[name] },
    set: (session, name) => { if (fail || (failGroups && session.endsWith('-group'))) throw new Error('permission: rejected'); writes.push(`${session}=${name}`) },
  }
  const ctx = { get: name => (presets && name === 'permissionPresets' ? service : undefined) }
  const state = { prefs: { ...prefs }, bots: structuredClone(bots) }
  const rt = {
    ctx,
    state,
    chatOf: id => `${id}-chat`,
    groupSessionsOf: id => [`${id}-group`],
    resolveAgent: async sessionId => ({ session: sessionId }),
    warn: (...args) => { warnings.push(args) },
    save: async () => { saves.push(JSON.parse(JSON.stringify(state.prefs))) },
  }
  install(rt)
  return { rt, writes, saves, warnings }
}

test('a Bot\'s preset is set on its chat and its group Sessions', async () => {
  const { rt, writes } = runtime()
  const bot = { id: 'b1', name: 'Ada' }
  await rt.setPermission(bot, 'danger-full-access')
  assert.equal(bot.permission, 'danger-full-access')
  assert.deepEqual(writes, ['b1-chat=danger-full-access', 'b1-group=danger-full-access'])
})

test('a fresh Session gets the Bot\'s preset, and a Bot without one keeps the default', async () => {
  const { rt, writes } = runtime()
  await rt.applyPermission({ id: 'b1' }, 'fresh')
  await rt.applyPermission({ id: 'b1', permission: 'workspace-write' }, 'fresh')
  assert.deepEqual(writes, ['fresh=workspace-write'])
})

test('an unknown preset is refused and the Bot keeps its own', async () => {
  const { rt, writes } = runtime()
  const bot = { id: 'b1', permission: 'workspace-write' }
  await assert.rejects(rt.setPermission(bot, 'everything'), /unknown preset/)
  assert.equal(bot.permission, 'workspace-write')
  assert.deepEqual(writes, [])
})

test('the catalog lists the presets DSH offers, or nothing without the presets service', () => {
  assert.deepEqual(runtime().rt.permissionCatalog(), {
    options: [{ value: 'workspace-write', name: 'workspace-write' }, { value: 'danger-full-access', name: 'danger-full-access' }],
    defaultOptions: [{ value: 'workspace-write', name: 'workspace-write' }, { value: 'danger-full-access', name: 'danger-full-access' }],
    defaultPreset: 'workspace-write',
    global: null,
  })
  assert.deepEqual(runtime({ prefs: { permission: 'danger-full-access' } }).rt.permissionCatalog().global, 'danger-full-access')
  assert.equal(runtime({ presets: false }).rt.permissionCatalog(), undefined)
})

test('the catalog passes DSH\'s options through, and falls back when there is no separate default list', () => {
  const both = runtime({ auto: true }).rt.permissionCatalog()
  assert.deepEqual(both.options.map(option => option.value), ['workspace-write', 'danger-full-access', 'auto'])
  // Auto is offered for a Session but never for the team's default.
  assert.deepEqual(both.defaultOptions.map(option => option.value), ['workspace-write', 'danger-full-access'])

  // An older DSH has no `defaultOptions`; the options list is the fallback.
  const { rt } = runtime()
  rt.ctx.get = () => ({ catalog: () => ({ options: optionsOf(false), defaultPreset: 'workspace-write' }), resolve: () => ({}), set: () => {} })
  assert.deepEqual(rt.permissionCatalog().defaultOptions, optionsOf(false))
})

test('Auto review is set as a Bot\'s preset when DSH offers it', async () => {
  const { rt, writes } = runtime({ auto: true })
  const bot = { id: 'b1' }
  await rt.setPermission(bot, 'auto')
  assert.equal(bot.permission, 'auto')
  assert.deepEqual(writes, ['b1-chat=auto', 'b1-group=auto'])
})

test('Auto review is refused as a Bot\'s preset when DSH does not offer it', async () => {
  const { rt, writes } = runtime()
  const bot = { id: 'b1', permission: 'workspace-write' }
  await assert.rejects(rt.setPermission(bot, 'auto'), /unknown preset "auto"/)
  assert.equal(bot.permission, 'workspace-write')
  assert.deepEqual(writes, [])
})

test('a preset the Bot\'s own chat refuses is not kept', async () => {
  const { rt } = runtime({ fail: true })
  const bot = { id: 'b1', permission: 'workspace-write' }
  await assert.rejects(rt.setPermission(bot, 'danger-full-access'), /rejected/)
  assert.equal(bot.permission, 'workspace-write')
})

test('a Bot without an override follows the team\'s global preset', async () => {
  const { rt, writes } = runtime({ prefs: { permission: 'workspace-write' } })
  assert.equal(rt.effectivePermission({ id: 'b1', name: 'Ada' }), 'workspace-write')
  await rt.applyPermission({ id: 'b1', name: 'Ada' }, 'b1-chat')
  assert.deepEqual(writes, ['b1-chat=workspace-write'])
})

test('a Bot\'s own preset wins over the team\'s global preset', async () => {
  const { rt, writes } = runtime({ prefs: { permission: 'workspace-write' } })
  const bot = { id: 'b1', name: 'Ada', permission: 'danger-full-access' }
  assert.equal(rt.effectivePermission(bot), 'danger-full-access')
  await rt.applyPermission(bot, 'b1-chat')
  assert.deepEqual(writes, ['b1-chat=danger-full-access'])
})

test('with no global preset a Bot follows the DSH default and nothing is sent', async () => {
  const { rt, writes } = runtime()
  assert.equal(rt.effectivePermission({ id: 'b1' }), undefined)
  await rt.applyPermission({ id: 'b1' }, 'b1-chat')
  assert.deepEqual(writes, [])
})

test('a new global preset is saved and applied to the private and group Sessions of Bots without an override', async () => {
  const { rt, writes, saves } = runtime({
    bots: {
      b1: { id: 'b1', name: 'Ada' },
      b2: { id: 'b2', name: 'Linus', permission: 'danger-full-access' },
    },
  })
  await rt.setGlobalPermission('workspace-write')
  assert.equal(rt.state.prefs.permission, 'workspace-write')
  assert.equal(rt.permissionCatalog().global, 'workspace-write')
  assert.equal(saves.length, 1)
  assert.deepEqual(writes, ['b1-chat=workspace-write', 'b1-group=workspace-write'])
  assert.equal(rt.state.bots.b2.permission, 'danger-full-access')
})

test('clearing the global preset lets the Bot follow the DSH default again', async () => {
  const { rt, writes, saves } = runtime({
    bots: { b1: { id: 'b1', name: 'Ada' } },
    prefs: { permission: 'workspace-write', theme: 'dark' },
  })
  await rt.setGlobalPermission(null)
  assert.equal(rt.state.prefs.permission, undefined)
  assert.equal(rt.permissionCatalog().global, null)
  assert.deepEqual(saves, [{ theme: 'dark' }])
  // Sessions that followed the old global must not stay on it: they get DSH's default.
  assert.deepEqual(writes, ['b1-chat=workspace-write', 'b1-group=workspace-write'])
})

test('the team\'s preset refuses Auto review, which DSH never offers as a default', async () => {
  const { rt, writes } = runtime({ auto: true, prefs: { permission: 'workspace-write' } })
  await assert.rejects(rt.setGlobalPermission('auto'), /Unknown permission preset "auto"/)
  assert.equal(rt.state.prefs.permission, 'workspace-write')
  assert.deepEqual(writes, [])
})

test('an unknown preset is refused as the team\'s preset and nothing is written', async () => {
  const { rt, writes } = runtime({ bots: { b1: { id: 'b1', name: 'Ada' } } })
  await assert.rejects(rt.setGlobalPermission('everything'), /Unknown permission preset "everything"/)
  assert.equal(rt.state.prefs.permission, undefined)
  assert.deepEqual(writes, [])
})

test('with no presets service the team\'s preset is refused, and clearing it is not', async () => {
  const { rt } = runtime({ presets: false })
  await assert.rejects(rt.setGlobalPermission('workspace-write'), /not available/)
  await rt.setGlobalPermission(null)
  assert.equal(rt.state.prefs.permission, undefined)
})

test('clearing a Bot\'s override returns it to the global preset without an error', async () => {
  const { rt, writes } = runtime({
    bots: { b1: { id: 'b1', name: 'Ada', permission: 'danger-full-access' } },
    prefs: { permission: 'workspace-write' },
  })
  await rt.clearPermission(rt.state.bots.b1)
  assert.equal(rt.state.bots.b1.permission, undefined)
  assert.equal(rt.effectivePermission(rt.state.bots.b1), 'workspace-write')
  assert.deepEqual(writes, ['b1-chat=workspace-write', 'b1-group=workspace-write'])
})

test('clearing the global preset leaves a Bot with its own override alone', async () => {
  const { rt, writes } = runtime({
    bots: {
      b1: { id: 'b1', name: 'Ada' },
      b2: { id: 'b2', name: 'Linus', permission: 'danger-full-access' },
    },
    prefs: { permission: 'workspace-write' },
  })
  await rt.setGlobalPermission(null)
  assert.equal(rt.state.bots.b2.permission, 'danger-full-access')
  // Only b1 followed the team, so only b1's Sessions move.
  assert.deepEqual(writes, ['b1-chat=workspace-write', 'b1-group=workspace-write'])
})

test('a group Session that refuses the new global preset is warned and the rest still applies', async () => {
  const { rt, writes, warnings } = runtime({ failGroups: true, bots: { b1: { id: 'b1', name: 'Ada' } } })
  await rt.setGlobalPermission('workspace-write')
  assert.equal(rt.state.prefs.permission, 'workspace-write')
  assert.deepEqual(writes, ['b1-chat=workspace-write'])
  assert.equal(warnings.length, 1)
  assert.equal(warnings[0][0], 'ds-bot: permission for %s in a group not applied: %s')
  assert.equal(warnings[0][1], 'Ada')
})

test('clearing an override with no team preset falls back to the DSH default', async () => {
  const { rt, writes } = runtime({ bots: { b1: { id: 'b1', name: 'Ada', permission: 'danger-full-access' } } })
  await rt.clearPermission(rt.state.bots.b1)
  assert.equal(rt.state.bots.b1.permission, undefined)
  assert.equal(rt.effectivePermission(rt.state.bots.b1), undefined)
  // Older Sessions must not stay on the wider preset, so the DSH default is written.
  assert.deepEqual(writes, ['b1-chat=workspace-write', 'b1-group=workspace-write'])
})
