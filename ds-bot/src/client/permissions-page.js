// Settings → Permissions: the preset every Bot without its own preset runs on, and
// one override row per Bot. The presets come from the DeepSeek Harness catalog.
import { createElement as h, useEffect, useState } from 'react'
import { t } from './i18n.js'

export const PermissionIcon = () => h('svg', { width: 15, height: 15, viewBox: '0 0 20 20', fill: 'none', stroke: 'currentColor', strokeWidth: 1.5, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true },
  h('path', { d: 'M10 2.8l5.5 2v5c0 3.4-2.3 5.9-5.5 7.4-3.2-1.5-5.5-4-5.5-7.4v-5z' }),
  h('path', { d: 'M7.6 10.1l1.8 1.8 3.2-3.6' }))

// The keys of DSH's built-in presets, which carry the raw key as their display name.
const KNOWN_LABELS = { 'read-only': 'Read only', 'workspace-write': 'Workspace', 'danger-full-access': 'Full access', auto: 'Auto' }

// The label for one preset: the friendly name of a built-in key, else the catalog's own
// name. A preset that carries no name at all is the only one shown as custom, so a real
// name is never hidden — not even when a config uses its key as the display name.
export function permissionLabel(option, value) {
  const key = option?.value ?? value
  if (Object.hasOwn(KNOWN_LABELS, key)) return t(KNOWN_LABELS[key])
  return option?.name || t('Permissions · Custom preset')
}

const optionLabel = option => permissionLabel(option, option.value)

const recordsOf = options => (options ?? []).map(option => ({ value: option.value, label: optionLabel(option), hint: option.description }))

const nameOf = (records, value) => records.find(record => record.value === value)?.label ?? permissionLabel(undefined, value)

// `null` is a real choice ("follow the default"), so "no pick made yet" is `undefined`.
const NO_PICK = undefined

function GlobalRow({ global, records, actions, run }) {
  const [pending, setPending] = useState(NO_PICK)
  const pick = (value) => {
    const next = value === '' ? null : value
    if (next === global) return
    setPending(next)
    void run(actions.setPrefs({ permission: next })).then(ok => { if (!ok) setPending(NO_PICK) })
  }
  useEffect(() => { if (pending !== NO_PICK && pending === global) setPending(NO_PICK) }, [pending, global])
  const current = pending !== NO_PICK ? pending : global
  return h('div', { className: 'bt-set-row', 'data-permission-scope': 'global' },
    h('div', { className: 'bt-set-copy' },
      h('span', null, t('Permissions · Global policy')),
      h('span', { className: 'bt-set-hint' }, t('Permissions · Global hint'))),
    h('div', { className: 'bt-set-control' },
      h('select', {
        className: 'bt-select', 'aria-label': t('Permissions · Global policy'), 'data-permission': 'global',
        value: current ?? '', onChange: event => pick(event.target.value),
      },
      h('option', { value: '' }, t('Permissions · Follow the DeepSeek Harness default')),
      records.map(record => h('option', { key: record.value, value: record.value }, record.label)))))
}

function BotRow({ bot, global, catalog, records, actions, run }) {
  // An empty Bot preset counts as following, the way the host's `effectivePermission`
  // reads it. Without a global policy the Bot follows the DSH default.
  const chosen = bot.permission || null
  const inherits = global || catalog.defaultPreset || null
  const [pending, setPending] = useState(NO_PICK)
  const pick = (value) => {
    const next = value === '' ? null : value
    if (next === chosen) return
    setPending(next)
    void run(actions.updateBot(bot.id, { permission: next })).then(ok => { if (!ok) setPending(NO_PICK) })
  }
  useEffect(() => { if (pending !== NO_PICK && pending === chosen) setPending(NO_PICK) }, [pending, chosen])
  const current = pending !== NO_PICK ? pending : chosen
  const follow = global
    ? t('Permissions · Follow the global policy ({name})', { name: nameOf(records, global) })
    : t('Permissions · Follow the global policy')
  const hint = chosen
    ? t('Permissions · This Bot has its own preset, so it does not follow the global policy.')
    : inherits
      ? t('Permissions · Inherits {name}.', { name: nameOf(records, inherits) })
      : t('Permissions · Inherits the DeepSeek Harness default.')
  return h('div', { className: 'bt-set-row', 'data-permission-scope': bot.id },
    h('div', { className: 'bt-set-copy' }, h('span', null, bot.name), h('span', { className: 'bt-set-hint' }, hint)),
    h('div', { className: 'bt-set-control' },
      h('select', {
        className: 'bt-select', 'aria-label': t('Permissions · Preset for {name}', { name: bot.name }),
        'data-permission': `bot:${bot.id}`, value: current ?? '', onChange: event => pick(event.target.value),
      },
      // `permission: null` is the agreed signal to clear the Bot's own preset, the same
      // way an empty `effort` clears a thinking level.
      h('option', { value: '' }, follow),
      records.map(record => h('option', { key: record.value, value: record.value }, record.label)))))
}

export function PermissionsPage({ roster, actions, run, Section, Row }) {
  const catalog = roster.permissions
  // DSH splits its catalog: `options` is what a session may hold (auto review is in here
  // while the integration is live), `defaultOptions` is what may become the team default
  // (auto review never is). A Harness without the second list only has the first.
  const records = recordsOf(catalog?.options)
  const defaultRecords = recordsOf(catalog?.defaultOptions ?? catalog?.options)
  // `roster.permissions.global` is the frozen source; the prefs value keeps the page
  // right on a Harness that predates it.
  const global = catalog?.global ?? roster.prefs?.permission ?? null
  if (!defaultRecords.length) {
    return h(Section, { title: t('Permissions') },
      h(Row, { label: t('Permissions · This DeepSeek Harness has no permission presets.'), hint: t('Permissions · Presets come from DeepSeek Harness.') }))
  }
  return [
    h(Section, { key: 'global', title: t('Permissions · Global policy') },
      h(GlobalRow, { global, records: defaultRecords, actions, run })),
    h(Section, { key: 'bots', title: t('Permissions · Per-Bot overrides · {count}', { count: roster.bots.length }) },
      roster.bots.length === 0
        ? h(Row, { label: t('Permissions · No Bots yet.'), hint: t('Permissions · New Bots follow the global policy until you give one its own preset.') })
        : roster.bots.map(bot => h(BotRow, { key: bot.id, bot, global, catalog, records, actions, run }))),
  ]
}
