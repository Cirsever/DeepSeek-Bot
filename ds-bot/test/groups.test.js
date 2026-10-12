import assert from 'node:assert/strict'
import { test } from 'node:test'
import { install, isPass, mentionsIn, referenceNote, stripOwnName, withoutReferences } from '../src/host/groups.js'
import { attachReference } from '../src/host/turns.js'
import { fakeContext } from './fake-ctx.js'

const members = [{ name: 'M' }, { name: 'Mx' }, { name: 'K' }, { name: 'Writer' }]
const names = ({ all, found }) => ({ all, found: found.map(member => member.name) })

function relayStream() {
  const ctx = fakeContext()
  install({ ctx, load: async () => {}, roomOf: id => id === 'room' ? { id } : undefined })
  return ctx.listeners.get('llm/stream')[0]
}

const userPost = { role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'Hello group' }] }

for (const [mode, tools, expected] of [
  ['native', [{ name: 'group_relay' }], 'group_relay'],
  ['ptc', [{ name: 'run_code' }], 'run_code'],
  ['both', [{ name: 'run_code' }, { name: 'group_relay' }], 'group_relay'],
  ['unspecified', undefined, 'group_relay'],
]) {
  test(`group relay uses the ${mode} request's callable tool exactly once`, async () => {
    const stream = relayStream()
    const options = { sessionId: 'room', tools, messages: [userPost] }
    const next = () => assert.fail('A group relay must not call the model')
    const events = await Array.fromAsync(stream(options, next))
    const [call] = events.filter(event => event.type === 'block-end').map(event => event.block)
    assert.equal(events.length, 4)
    assert.equal(call.name, expected)
    assert.deepEqual(events[1], { type: 'tool-call-delta', index: 0, id: call.id, name: call.name, argumentsDelta: call.arguments })
    assert.deepEqual(events[3], { type: 'finish', reason: { kind: 'tool-calls' } })
    const args = JSON.parse(call.arguments)
    if (expected === 'run_code') {
      assert.equal(args.description, 'Relay this message to the group')
      let calls = 0
      const run = new (Object.getPrototypeOf(async () => {}).constructor)('tools', args.code)
      const result = await run({ group_relay: async (input) => {
        calls += 1
        assert.deepEqual(input, {})
        return 'group replied'
      } })
      assert.equal(calls, 1)
      assert.equal(result, 'group replied')
    } else {
      assert.deepEqual(args, {})
    }
    const settled = [...options.messages, { role: 'assistant', content: [call] }, { role: 'tool', toolCallId: call.id, content: [] }]
    assert.deepEqual(await Array.fromAsync(stream({ ...options, messages: settled }, next)), [{ type: 'finish', reason: { kind: 'stop' } }])
  })
}

test('group relay leaves private chats and auxiliary requests with the model', async () => {
  const stream = relayStream()
  const sentinel = { type: 'finish', reason: { kind: 'stop' } }
  let calls = 0
  const next = async function* () { calls += 1; yield sentinel }
  for (const extra of [{}, { sessionId: 'bot' }, { sessionId: 'room', purpose: 'session-title' }]) {
    assert.deepEqual(await Array.fromAsync(stream({ messages: [userPost], tools: [{ name: 'run_code' }], ...extra }, next)), [sentinel])
  }
  assert.equal(calls, 3)
})

test('mentionsIn finds members in order, longest name first', () => {
  assert.deepEqual(names(mentionsIn('@Mx and @M, then @writer', members)), { all: false, found: ['Mx', 'M', 'Writer'] })
  assert.deepEqual(names(mentionsIn('@K你好 @K again', members)), { all: false, found: ['K'] })
  assert.deepEqual(names(mentionsIn('@Kate is not K', members)), { all: false, found: [] })
  assert.deepEqual(names(mentionsIn('mail a@K.com', members)), { all: false, found: [] })
  assert.deepEqual(names(mentionsIn('@all please, @所有人', members)), { all: true, found: [] })
  assert.deepEqual(names(mentionsIn('@everyone and @M', members)), { all: true, found: ['M'] })
  assert.deepEqual(names(mentionsIn('no mentions', members)), { all: false, found: [] })
})

test('isPass takes empty replies and [PASS] forms', () => {
  for (const text of ['', '[PASS]', ' 【pass】 then more', '(pass)', 'pass.', 'Pass！', '  PASS  ']) assert.equal(isPass(text), true, text)
  for (const text of ['passing the ball', 'I pass on this one', 'ok']) assert.equal(isPass(text), false, text)
})

test('stripOwnName drops an echoed "Name:" prefix', () => {
  assert.equal(stripOwnName('Writer', 'Writer: hello'), 'hello')
  assert.equal(stripOwnName('Writer', '**Writer**：你好'), '你好')
  assert.equal(stripOwnName('A.b', 'A.b: x'), 'x')
  assert.equal(stripOwnName('A.b', 'Axb: x'), 'Axb: x')
  assert.equal(stripOwnName('Writer', 'Coder: hi'), 'Coder: hi')
})

test('a referenced conversation rides with the user\'s queued message, not a Bot\'s post', () => {
  const queued = [{ text: 'first' }, { text: 'look @Chat with K', images: [] }, { text: 'post', botId: 'k' }]
  attachReference(queued, { kind: 'session-reference', references: [{ label: 'Chat with K' }, { label: '' }] }, '## Referenced sessions\n…')
  attachReference(queued, { kind: 'session-reference', references: [{ label: 'K notes' }] }, '## Referenced sessions\n2')
  attachReference(queued, { kind: 'session-reference' }, '')
  assert.equal(queued[0].references, undefined)
  assert.deepEqual(queued[1].references, [{ labels: ['Chat with K'], text: '## Referenced sessions\n…' }, { labels: ['K notes'], text: '## Referenced sessions\n2' }])
  assert.equal(queued[2].references, undefined)
  attachReference(undefined, {}, 'x')
})

test('a reference label is not a call, even when it starts with a member\'s name', () => {
  const references = [{ labels: ['K notes', 'K'] }]
  assert.deepEqual(names(mentionsIn(withoutReferences('see @K notes, then @Writer', references), members)), { all: false, found: ['Writer'] })
  assert.deepEqual(names(mentionsIn(withoutReferences('@K notes', undefined), members)), { all: false, found: ['K'] })
  assert.equal(referenceNote([]), '')
  assert.equal(referenceNote([{ text: 'A' }, { text: 'B' }]), 'Conversations the user referenced in this round:\n\nA\n\nB')
})

test('a reference takes out only its own "@label", so a typed call with the same text stays', () => {
  const writer = [{ labels: ['Writer'] }]
  assert.deepEqual(names(mentionsIn(withoutReferences('Read @Writer, then @Writer please answer.', writer), members)), { all: false, found: ['Writer'] })
  assert.deepEqual(names(mentionsIn(withoutReferences('see @Writer', writer), members)), { all: false, found: [] })
  assert.deepEqual(names(mentionsIn(withoutReferences('see @Writer and @Writer', [...writer, ...writer]), members)), { all: false, found: [] })
  // "@Kate" is not the reference "K", so the "@K" after it is the one taken out.
  assert.deepEqual(names(mentionsIn(withoutReferences('@Kate, @K', [{ labels: ['K'] }]), [...members, { name: 'Kate' }])), { all: false, found: ['Kate'] })
  assert.deepEqual(names(mentionsIn(withoutReferences('@K notes and @K', [{ labels: ['K notes'] }]), members)), { all: false, found: ['K'] })
})
