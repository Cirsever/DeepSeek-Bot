// Permissions. A Bot speaks with its own preset, or the team's global one when it has
// none, set on every Session it speaks from, so a fresh part or a new group Session
// keeps it.
export function install(rt) {
  const { ctx, state } = rt

  const presets = () => ctx.get?.('permissionPresets')

  // The preset a Bot speaks with: its own, else the team's; undefined follows DSH.
  const effectivePermission = bot => bot.permission ?? state.prefs.permission

  // The presets DSH offers, or undefined when the profile has none. `options` is what a
  // Session can take, `defaultOptions` what may be the team's default; DSH decides both,
  // including whether Auto review is among them.
  function permissionCatalog() {
    const service = presets()
    if (service === undefined) return undefined
    const { options, defaultOptions, defaultPreset } = service.catalog()
    return {
      options,
      defaultOptions: defaultOptions ?? options,
      defaultPreset,
      global: state.prefs.permission ?? null,
    }
  }

  // Writes one preset to one of the Bot's Sessions; nothing to write leaves the Session alone.
  async function applyPresetTo(name, sessionId) {
    const service = presets()
    if (service === undefined || name === undefined) return
    const agent = await rt.resolveAgent(sessionId)
    service.set(agent.session, name)
  }

  // Sets the Bot's effective preset on one of its Sessions; nothing to set keeps DSH's default.
  async function applyPermission(bot, sessionId) {
    await applyPresetTo(effectivePermission(bot), sessionId)
  }

  // A dropped override must not leave older Sessions on a wider preset, so it writes what
  // the Bot follows now: the team's preset, or DSH's default when the team has none.
  async function applyInherited(bot) {
    const name = effectivePermission(bot) ?? presets()?.catalog().defaultPreset
    await applyPresetTo(name, rt.chatOf(bot.id))
    for (const sessionId of rt.groupSessionsOf(bot.id)) {
      await applyPresetTo(name, sessionId)
        .catch(error => rt.warn('ds-bot: permission for %s in a group not applied: %s', bot.name, error))
    }
  }

  async function setPermission(bot, name) {
    const service = presets()
    if (service === undefined) throw new Error('Permissions are not available in this DeepSeek Harness')
    const wanted = String(name ?? '').trim()
    service.resolve(wanted)
    await applyPermission({ ...bot, permission: wanted }, rt.chatOf(bot.id))
    bot.permission = wanted
    for (const sessionId of rt.groupSessionsOf(bot.id)) {
      await applyPermission(bot, sessionId)
        .catch(error => rt.warn('ds-bot: permission for %s in a group not applied: %s', bot.name, error))
    }
  }

  // The team's default for every Bot without its own; `null` follows DSH's default.
  async function setGlobalPermission(name) {
    if (name === null) delete state.prefs.permission
    else {
      const service = presets()
      if (service === undefined) throw new Error('Permissions are not available in this DeepSeek Harness')
      const wanted = String(name).trim()
      const { options, defaultOptions } = service.catalog()
      if (!(defaultOptions ?? options).some(option => option.value === wanted)) throw new Error(`Unknown permission preset "${wanted}"`)
      state.prefs.permission = wanted
    }
    await rt.save()
    // Only the Bots that follow the team move: a new preset, or DSH's default when it is cleared.
    for (const bot of Object.values(state.bots)) {
      if (bot.permission !== undefined) continue
      await applyInherited(bot)
    }
  }

  // Drops the Bot's own preset so it follows the team's again, moving its Sessions with it.
  async function clearPermission(bot) {
    delete bot.permission
    await applyInherited(bot)
  }

  Object.assign(rt, { permissionCatalog, effectivePermission, applyPermission, setPermission, setGlobalPermission, clearPermission })
}
