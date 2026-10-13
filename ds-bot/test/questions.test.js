import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { apply } from '../index.js'
import { fakeContext } from './fake-ctx.js'

const TEAM = {
  version: 1,
  mainBotIds: ['chief'],
  bots: {
    chief: { id: 'chief', name: 'Chief', role: 'Lead', sessionId: 'chief', createdAt: 1 },
    writer: { id: 'writer', name: 'Writer', role: 'Write', sessionId: 'writer', createdAt: 2 },
  },
  rooms: {},
  agents: {},
  exchanges: [],
  exchangeTurns: {},
  questions: {},
  prefs: {},
  revision: 0,
}

async function start() {
  const home = mkdtempSync(join(tmpdir(), 'ds-bot-questions-'))
  writeFileSync(join(home, 'state.json'), JSON.stringify(TEAM))
  const ctx = fakeContext()
  Object.assign(ctx, {
    workspaceRegistry: { get: () => undefined, resolveByPath: async () => undefined, create: async path => ({ id: 'w1', path }), archiveSession: async () => {} },
    sessionController: { create: async () => ({ sessionId: 's1' }), resolveAgent: async sessionId => ({ agent: { session: { id: sessionId }, followup() {} } }), selectModel: async () => {} },
    sessionTitle: { rename: async () => {} },
    sessions: { flush: async () => {} },
  })
  let route
  const register = ctx.connection.fetch.register
  ctx.connection.fetch.register = (options) => {
    route = options
    return register(options)
  }
  apply(ctx, { home })
  let seq = 0
  const emit = (id, type, data) => {
    for (const listener of ctx.listeners.get('session/event') ?? []) {
      if (listener.length >= 2) listener({ id }, { type, seq: ++seq, data })
    }
  }
  const ask = (sessionId, callId) => ctx.registeredTools.get('ask_user').execute(
    { question: 'Which name?', options: [{ label: 'Lookout' }, { label: 'Scout' }] },
    { agent: { id: sessionId }, callId, concludeTurn() {} },
  )
  const questions = async () => (await (await route.fetch(new Request('http://localhost/api/bot', {
    method: 'POST', body: JSON.stringify({ endpoint: 'state', payload: {} }),
  }))).json()).value.questions
  // Loading once fills the Session-owner indexes turns.js filters events by.
  await ctx.registeredTools.get('list_bots').execute({}, { agent: { id: 'chief' } })
  return { emit, ask, questions, stop: () => { ctx.dispose(); rmSync(home, { recursive: true, force: true, maxRetries: 5 }) } }
}

const text = value => [{ type: 'text', text: value }]

test('a card asked in a hidden Bot-to-Bot turn goes to the dock, without its call', async (t) => {
  const { emit, ask, questions, stop } = await start()
  t.after(stop)
  emit('writer', 'turn/start', { turn: 1 })
  emit('writer', 'user/message', { content: text('[Message from Chief]\nThe user wants a new Bot; ask them for its name'), source: { kind: 'bot', role: 'request', senderSessionId: 'chief', senderName: 'Chief', exchangeId: 'x1', hop: 0 } })
  await ask('writer', 'call-1')
  const asked = (await questions()).writer
  assert.equal(asked.question, 'Which name?')
  assert.equal(asked.callId, undefined)
})

test('a card asked in a visible turn stays at its call', async (t) => {
  const { emit, ask, questions, stop } = await start()
  t.after(stop)
  emit('writer', 'turn/start', { turn: 1 })
  emit('writer', 'user/message', { content: text('Help me name a Bot'), source: { kind: 'user' } })
  await ask('writer', 'call-2')
  assert.equal((await questions()).writer.callId, 'call-2')

  // A message that asks for an answer in the recipient's own chat is visible too.
  emit('writer', 'turn/end', { turn: 1, reason: { kind: 'completed' } })
  emit('writer', 'turn/start', { turn: 2 })
  emit('writer', 'user/message', { content: text('[Message from Chief · the user sees your reply here]\nIntroduce yourself'), source: { kind: 'bot', role: 'request', audience: 'user', senderSessionId: 'chief', senderName: 'Chief', exchangeId: 'x2', hop: 0 } })
  await ask('writer', 'call-3')
  assert.equal((await questions()).writer.callId, 'call-3')
})

// A room's id is the id of its own group Session; room.sessions maps each member to the
// per-member group Session it speaks from.
const ROOM_TEAM = {
  ...TEAM,
  rooms: {
    'room-1': {
      id: 'room-1', name: 'Ops', members: ['chief', 'writer'], admin: 'chief', mode: 'admin',
      createdBy: null, createdAt: 1, sessions: { writer: 'writer-g', chief: 'chief-g' },
      log: [], seq: 0, seen: {},
    },
  },
}

async function startGroup() {
  const home = mkdtempSync(join(tmpdir(), 'ds-bot-group-questions-'))
  writeFileSync(join(home, 'state.json'), JSON.stringify(ROOM_TEAM))
  const followed = []
  const ctx = fakeContext()
  Object.assign(ctx, {
    workspaceRegistry: { get: () => undefined, resolveByPath: async () => undefined, create: async path => ({ id: 'w1', path }), archiveSession: async () => {} },
    sessionController: {
      create: async () => ({ sessionId: 's1' }),
      resolveAgent: async sessionId => ({ agent: { session: { id: sessionId }, followup: message => followed.push({ sessionId, message }) } }),
      selectModel: async () => {},
    },
    sessionTitle: { rename: async () => {} },
    sessions: { flush: async () => {} },
  })
  let route
  const register = ctx.connection.fetch.register
  ctx.connection.fetch.register = (options) => {
    route = options
    return register(options)
  }
  apply(ctx, { home })
  let seq = 0
  const emit = (id, type, data) => {
    for (const listener of ctx.listeners.get('session/event') ?? []) {
      if (listener.length >= 2) listener({ id }, { type, seq: ++seq, data })
    }
  }
  const ask = sessionId => ctx.registeredTools.get('ask_user').execute(
    { question: 'Which name?', options: [{ label: 'Lookout' }, { label: 'Scout' }] },
    { agent: { id: sessionId }, callId: undefined, concludeTurn() {} },
  )
  const askAt = (sessionId, callId) => ctx.registeredTools.get('ask_user').execute(
    { question: 'Which name?', options: [{ label: 'Lookout' }, { label: 'Scout' }] },
    { agent: { id: sessionId }, callId, concludeTurn() {} },
  )
  const post = async (endpoint, payload) => (await (await route.fetch(new Request('http://localhost/api/bot', {
    method: 'POST', body: JSON.stringify({ endpoint, payload }),
  }))).json())
  const roomCards = async roomId => (await post('state', {})).value.roomQuestions[roomId]
  const answer = (roomId, questionId, selected = ['Scout']) => post('answer-room-question', { roomId, questionId, answer: { selected } })
  await ctx.registeredTools.get('list_bots').execute({}, { agent: { id: 'chief' } })
  return { emit, ask, askAt, post, roomCards, answer, followed, stop: () => { ctx.dispose(); rmSync(home, { recursive: true, force: true, maxRetries: 5 }) } }
}

test('A1: a group ask_user writes a live card for its room instead of refusing', async (t) => {
  const { askAt, roomCards, stop } = await startGroup()
  t.after(stop)
  const reply = await askAt('writer-g', 'call-1')
  assert.doesNotMatch(reply, /only work in your own chat/)
  const cards = await roomCards('room-1')
  assert.equal(cards.length, 1)
  const [card] = cards
  assert.equal(card.live, true)
  assert.equal(card.botId, 'writer')
  assert.equal(card.callId, 'call-1')
  assert.equal(card.question, 'Which name?')
  assert.deepEqual(card.options.map(option => option.label), ['Lookout', 'Scout'])
  assert.equal(typeof card.id, 'string')
})

test('A2: an answer settles the card, posts the reply and refuses a second answer', async (t) => {
  const { askAt, roomCards, answer, followed, stop } = await startGroup()
  t.after(stop)
  await askAt('writer-g', 'call-1')
  const [card] = await roomCards('room-1')
  assert.equal((await answer('room-1', card.id)).ok, true)
  const settled = (await roomCards('room-1'))[0]
  assert.equal(settled.live, false)
  assert.deepEqual(settled.answer.selected, ['Scout'])
  const posted = followed.filter(entry => entry.sessionId === 'room-1')
  assert.equal(posted.length, 1)
  assert.equal(posted[0].message.source.kind, 'user-question-reply')
  assert.match(JSON.stringify(posted[0].message.content), /Scout/)
  const second = await answer('room-1', card.id)
  assert.equal(second.ok, false)
  assert.equal(second.error.code, 'bot/stale')
})

test('A2b: two answers fired together let one through and refuse the other', async (t) => {
  const { askAt, roomCards, answer, followed, stop } = await startGroup()
  t.after(stop)
  await askAt('writer-g', 'call-1')
  const [card] = await roomCards('room-1')
  const results = await Promise.all([answer('room-1', card.id), answer('room-1', card.id)])
  assert.equal(results.filter(result => result.ok).length, 1)
  assert.equal(results.filter(result => result.error?.code === 'bot/stale').length, 1)
  assert.equal(followed.filter(entry => entry.sessionId === 'room-1').length, 1)
})

test('A3: dismissing closes the card', async (t) => {
  const { askAt, roomCards, post, answer, stop } = await startGroup()
  t.after(stop)
  await askAt('writer-g', 'call-1')
  const [card] = await roomCards('room-1')
  assert.equal((await post('dismiss-question', { roomId: 'room-1', questionId: card.id })).ok, true)
  const closed = (await roomCards('room-1'))[0]
  assert.equal(closed.live, false)
  assert.equal(closed.dismissed, true)
  assert.equal((await answer('room-1', card.id)).error.code, 'bot/stale')
})

test('A4: a plain group message closes the room\'s open card', async (t) => {
  const { askAt, roomCards, emit, stop } = await startGroup()
  t.after(stop)
  await askAt('writer-g', 'call-1')
  emit('room-1', 'user/message', { content: text('let us move on'), source: { kind: 'user' } })
  const [card] = await roomCards('room-1')
  assert.equal(card.live, false)
  assert.equal(card.dismissed, true)
})

test('A5: a second Bot\'s question supersedes the first card', async (t) => {
  const { askAt, roomCards, stop } = await startGroup()
  t.after(stop)
  await askAt('writer-g', 'call-1')
  const firstId = (await roomCards('room-1'))[0].id
  await askAt('chief-g', 'call-2')
  const cards = await roomCards('room-1')
  assert.equal(cards.length, 2)
  assert.equal(cards[0].live, true)
  assert.equal(cards[0].botId, 'chief')
  assert.equal(cards[0].callId, 'call-2')
  const older = cards.find(card => card.id === firstId)
  assert.equal(older.live, false)
  assert.equal(older.superseded, true)
})

test('A5b: two supersedes keep three cards, with only the newest live', async (t) => {
  const { askAt, roomCards, stop } = await startGroup()
  t.after(stop)
  await askAt('writer-g', 'call-1')
  const firstId = (await roomCards('room-1'))[0].id
  await askAt('chief-g', 'call-2')
  const secondId = (await roomCards('room-1'))[0].id
  await askAt('writer-g', 'call-3')
  const cards = await roomCards('room-1')
  assert.equal(cards.length, 3)
  assert.equal(cards.filter(card => card.live === true).length, 1)
  assert.equal(cards.filter(card => card.superseded === true).length, 2)
  assert.equal(cards[0].live, true)
  assert.equal(cards[0].callId, 'call-3')
  // Every card stays findable by id, which is what the in-place record rows need.
  for (const id of [firstId, secondId, cards[0].id]) assert.equal(cards.filter(card => card.id === id).length, 1)
})

test('A5c: a room keeps five cards and never drops the live one', async (t) => {
  const { askAt, roomCards, stop } = await startGroup()
  t.after(stop)
  for (let index = 0; index < 7; index += 1) await askAt(index % 2 === 0 ? 'writer-g' : 'chief-g', `call-${index}`)
  const cards = await roomCards('room-1')
  assert.equal(cards.length, 5)
  assert.equal(cards.filter(card => card.live === true).length, 1)
  assert.equal(cards[0].live, true)
  assert.equal(cards[0].callId, 'call-6')
})
