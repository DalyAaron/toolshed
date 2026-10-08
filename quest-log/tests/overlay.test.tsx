import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

import type { Armory, QuestLog } from '../types'

// The overlay (hooks/overlay.tsx). Run with: claude plugin test quest-log

const BASE = '/home/me/.claude/quests'
const STORE = `${BASE}/-proj/sid-1.json`
const CONFIG = `${BASE}/config.json`
const WALLET = `${BASE}/wallet.json`

const LOG: QuestLog = {
  project: '/proj',
  tracked: 1,
  quests: [
    {
      id: 1,
      kind: 'main',
      status: 'active',
      title: 'Add pagination',
      objectives: [
        { text: 'Read the handler', state: 'done' },
        { text: 'Write the cursor', state: 'open' },
      ],
    },
    {
      id: 2,
      kind: 'side',
      status: 'awaiting',
      title: 'Pick a slug rule',
      objectives: [],
      awaiting: 'Lowercase or keep case?',
    },
  ],
  rumors: [{ id: 1, text: 'The retry helper swallows errors' }],
  toasts: [{ text: '📜 Quest accepted: #1 Add pagination' }],
}

const ARMORY: Armory = {
  gold: 12,
  xp: 320,
  rank: { name: 'Journeyman', floor: 301, next: { name: 'Artificer', floor: 1001 } },
  look: { bar: ['●', '○'], trophy: '👑', banner: 'Bug Slayer' },
  wares: [
    { id: 'rounded', slot: 'frame', section: '⚒ FRAMES', name: 'Rounded frame', price: 0, preview: '╭──╮', owned: true, equipped: false },
    { id: 'double', slot: 'frame', section: '⚒ FRAMES', name: 'Double frame', price: 10, preview: '╔══╗', owned: false, equipped: false },
    { id: 'heavy', slot: 'frame', section: '⚒ FRAMES', name: 'Heavy frame', price: 10, preview: '┏━━┓', owned: true, equipped: true },
    { id: 'gem', slot: 'trophy', section: '✦ TROPHIES', name: 'Gem trophy', price: 25, preview: '💎', owned: false, equipped: false },
    { id: 'custom', slot: 'banner', section: '⚑ BANNERS', name: 'Custom banner', price: 20, preview: '⚑', owned: true, equipped: false },
  ],
  plaque_price: 3,
  plaques: [
    { id: 1, title: 'Old win', outcome: 'It shipped', project: 'toolshed', date: '2026-10-01', session: 'other', quest: 1, shown: true },
    { id: 2, title: 'Stored win', outcome: null, project: 'toolshed', date: '2026-10-02', session: 'other', quest: 2, shown: false },
  ],
}

const PANE = { title: 'Quests', isFocused: false, bodyColumns: 40, placement: 'dock' } as never
const BAND = { hasSurvey: false, isWorking: false, maxRows: 10, bodyColumns: 60 } as never

// The world beneath the plugin: one session in /proj, its log on disk
// (mtime bumped on every write), quest-log's config.json, and a record of
// every toast raised and every value the plugin gave the live variable.
function world(on: On, env: Record<string, string> = {}) {
  const file = { log: LOG, mtime: 1, config: '{}', armory: ARMORY, walletMtime: 1, reply: 'Done.' }
  const toasts: string[] = []
  const live: (string | undefined)[] = []
  // each /quests command a button ran, and the session it ran under
  const pressed: { command: string | undefined; sid: string | undefined }[] = []
  // Calls on $ are answered { value } (or { deny }) beneath the plugins.
  const answer = <T,>(value: T) => ({ value }) as never
  mock.env(on, { HOME: '/home/me', ...env })
  on('session.id', () => answer('sid-1'))
  on('session.cwd', () => answer('/proj/sub'))
  const ran = (stdout: string) =>
    answer({ exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false })
  on('process.run', ($, e) => {
    if (e.argv[0] === 'git') return ran('/proj\n')
    if (e.argv.includes('armory')) return ran(JSON.stringify(file.armory))
    if (e.argv.includes('dispatch')) {
      pressed.push({ command: e.init?.stdin, sid: e.init?.env?.CLAUDE_CODE_SESSION_ID })
      return ran(file.reply)
    }
    return { deny: `unexpected command: ${e.argv.join(' ')}` } as never
  })
  on('fs.stat', ($, e) =>
    e.path === STORE || e.path === WALLET
      ? answer({ kind: 'file', size: 1, mtimeMs: e.path === STORE ? file.mtime : file.walletMtime, isLink: false })
      : ({ deny: `no such file: ${e.path}` } as never),
  )
  on('fs.read', ($, e) =>
    e.path === STORE
      ? answer(JSON.stringify(file.log))
      : e.path === CONFIG
        ? answer(file.config)
        : ({ deny: `no such file: ${e.path}` } as never),
  )
  on('env.set', ($, e) => {
    if (e.name === 'CLAUDE_QUESTS_OVERLAY_LIVE') live.push(e.value)
    return answer(undefined)
  })
  on('command.register', () => answer(undefined))
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('ui.open', () => answer({ isPlaced: true }))
  on('ui.close', () => answer(undefined))
  on('ui.toast', ($, e) => {
    toasts.push(e.text)
    return answer(undefined)
  })
  const write = (log: QuestLog) => {
    file.log = log
    file.mtime += 1
  }
  const configure = (config: object) => {
    file.config = JSON.stringify(config)
  }
  const sell = (armory: Armory, reply: string) => {
    file.armory = armory
    file.walletMtime += 1
    file.reply = reply
  }
  return { toasts, live, pressed, write, configure, sell }
}

test('off by default: no toasts, and the Stop hook keeps its line', async ($, on) => {
  const clock = mock.clock(on)
  const { toasts, live, write } = world(on)
  await $.session.start({ cwd: '/proj/sub', surface: 'terminal', isInteractive: true })
  write({ ...LOG, toasts: [...LOG.toasts!, { text: '✔ Objective complete: Write the cursor' }] })
  await clock.advance(750)

  expect(toasts).toEqual([])
  expect(live).toEqual([])
})

test('on: reads the session log from the git root and draws it', async ($, on) => {
  const clock = mock.clock(on)
  const { toasts, live } = world(on, { CLAUDE_QUESTS_OVERLAY: 'on' })
  await $.session.start({ cwd: '/proj/sub', surface: 'terminal', isInteractive: true })
  await clock.advance(0)

  expect(toasts).toEqual(['📜 Quest accepted: #1 Add pagination'])
  expect(live).toEqual(['1'])

  for (const surface of ['terminal', 'desktop'] as const) {
    const pane = await $.ui.mount({ plugin: 'quest-log', surface, component: 'Pane', requestId: 'quests', props: PANE })
    expect(await pane.find({ text: /#1 Add pagination/ })).toBeDefined()
    // marks stand in a column of their own, so long texts wrap under themselves
    expect(await pane.find({ text: '▸' })).toBeDefined()
    expect(await pane.find({ text: 'Write the cursor' })).toBeDefined()
    expect(await pane.find({ text: /Awaiting you/ })).toBeDefined()
    expect(await pane.find({ text: 'r1' })).toBeDefined()
    expect(await pane.find({ text: 'The retry helper swallows errors' })).toBeDefined()
    await pane.unmount()

    const band = await $.ui.mount({ plugin: 'quest-log', surface, component: 'AbovePrompt', props: BAND })
    expect(await band.find({ text: /#2 Pick a slug rule: Lowercase or keep case\?/ })).toBeDefined()
    await band.unmount()
  }
})

test('on: toasts each queued change once, across the Stop hook emptying the queue', async ($, on) => {
  const clock = mock.clock(on)
  const { toasts, write, configure } = world(on)
  configure({ overlay: 'on' })
  await $.session.start({ cwd: '/proj/sub', surface: 'terminal', isInteractive: true })

  // the same turn: one more change queued behind the first
  write({ ...LOG, toasts: [...LOG.toasts!, { text: '✔ Objective complete: Write the cursor' }] })
  await clock.advance(750)
  // nothing new: no toast
  await clock.advance(750)
  // the Stop hook empties the queue, and the next turn queues a change
  write({ ...LOG, toasts: [{ text: '🏆 Quest complete: #1' }] })
  await clock.advance(750)

  expect(toasts).toEqual([
    '📜 Quest accepted: #1 Add pagination',
    '✔ Objective complete: Write the cursor',
    '🏆 Quest complete: #1',
  ])
})

test('turned on mid-session: takes over from then on, without replaying the turn', async ($, on) => {
  const clock = mock.clock(on)
  const { toasts, live, write, configure } = world(on)
  await $.session.start({ cwd: '/proj/sub', surface: 'terminal', isInteractive: true })

  configure({ overlay: 'on' })
  await clock.advance(750)
  write({ ...LOG, toasts: [...LOG.toasts!, { text: '✔ Objective complete: Write the cursor' }] })
  await clock.advance(750)
  configure({ overlay: 'off' })
  await clock.advance(750)

  expect(toasts).toEqual(['✔ Objective complete: Write the cursor'])
  expect(live).toEqual(['1', undefined])
})


const ON = { CLAUDE_QUESTS_OVERLAY: 'on' }
const DONE_LOG: QuestLog = {
  ...LOG,
  quests: [
    ...LOG.quests,
    { id: 3, kind: 'main', status: 'done', title: 'Ship the cache', objectives: [], outcome: 'Cache in, tests green' },
  ],
}

test('the log page wears what is equipped: banner, rank, gold, bar', async ($, on) => {
  const clock = mock.clock(on)
  world(on, ON)
  await $.session.start({ cwd: '/proj/sub', surface: 'terminal', isInteractive: true })
  await clock.advance(0)

  for (const surface of ['terminal', 'desktop'] as const) {
    const pane = await $.ui.mount({ plugin: 'quest-log', surface, component: 'Pane', requestId: 'quests', props: PANE })
    expect(await pane.find({ text: /⚔ Bug Slayer/ })).toBeDefined()
    expect(await pane.find({ text: /🏅 Journeyman · 320 xp/ })).toBeDefined()
    expect(await pane.find({ text: /12 💰/ })).toBeDefined()
    expect(await pane.find({ text: /●●●●●○○○○○ 1\/2/ })).toBeDefined()
    expect(await pane.find({ key: 'tab-shop' })).toBeDefined()
    await pane.unmount()
  }
})

test('shop: Buy runs /quests buy through quest.py and shows its answer', async ($, on) => {
  const clock = mock.clock(on)
  const { pressed, sell } = world(on, ON)
  await $.session.start({ cwd: '/proj/sub', surface: 'terminal', isInteractive: true })
  await clock.advance(0)

  for (const surface of ['terminal', 'desktop'] as const) {
    const pane = await $.ui.mount({ plugin: 'quest-log', surface, component: 'Pane', requestId: 'quests', props: PANE })
    await pane.press({ key: 'tab-shop' })
    // free wares aren't for sale; owned ones equip; equipped ones say so
    expect(await pane.find({ key: 'buy-rounded' })).toBeUndefined()
    expect(await pane.find({ key: 'equip-heavy' })).toBeUndefined()
    expect(await pane.find({ text: /◆ equipped/ })).toBeDefined()
    expect(await pane.find({ key: 'buy-gem' })).toBeDefined()

    sell(
      { ...ARMORY, gold: 2, wares: ARMORY.wares.map(w => (w.id === 'double' ? { ...w, owned: true, equipped: true } : w)) },
      'Bought the Double frame for 10 💰 and equipped it. 2 💰 left.',
    )
    await pane.press({ key: 'buy-double' })
    expect(await pane.find({ text: /Bought the Double frame/ })).toBeDefined()
    expect(await pane.find({ key: 'buy-double' })).toBeUndefined()
    expect(await pane.find({ text: /2 💰/ })).toBeDefined()
    await pane.press({ key: 'tab-log' })
    sell(ARMORY, 'Done.') // the next surface starts from the same shop
    await clock.advance(750)
    await pane.unmount()
  }
  expect(pressed).toEqual([
    { command: 'buy double', sid: 'sid-1' },
    { command: 'buy double', sid: 'sid-1' },
  ])
})

test('inventory: Equip, Unequip, Store, and the custom banner words', async ($, on) => {
  const clock = mock.clock(on)
  const { pressed } = world(on, ON)
  await $.session.start({ cwd: '/proj/sub', surface: 'terminal', isInteractive: true })
  await clock.advance(0)

  const pane = await $.ui.mount({ plugin: 'quest-log', surface: 'terminal', component: 'Pane', requestId: 'quests', props: PANE })
  await pane.press({ key: 'tab-inventory' })
  expect(await pane.find({ key: 'equip-double' })).toBeUndefined() // not owned
  await pane.press({ key: 'equip-rounded' })
  await pane.press({ key: 'unequip-heavy' })
  await pane.press({ key: 'store-p1' })
  await pane.press({ key: 'display-p2' })
  await pane.input({ key: 'banner-text', text: '  Keeper of Caches ' })

  expect(pressed.map(p => p.command)).toEqual([
    'equip rounded',
    'unequip heavy',
    'unequip p1',
    'equip p2',
    'banner Keeper of Caches',
  ])
})

test('trophies: hangs the hall, and offers to engrave what this session finished', async ($, on) => {
  const clock = mock.clock(on)
  const { pressed, write } = world(on, ON)
  write(DONE_LOG)
  await $.session.start({ cwd: '/proj/sub', surface: 'terminal', isInteractive: true })
  await clock.advance(0)

  for (const surface of ['terminal', 'desktop'] as const) {
    const pane = await $.ui.mount({ plugin: 'quest-log', surface, component: 'Pane', requestId: 'quests', props: PANE })
    await pane.press({ key: 'tab-trophies' })
    expect(await pane.find({ text: /✦ Old win/ })).toBeDefined()
    expect(await pane.find({ text: /✦ Stored win/ })).toBeUndefined()
    expect(await pane.find({ text: /\+ 1 in storage/ })).toBeDefined()
    await pane.press({ key: 'engrave-3' })
    await pane.press({ key: 'tab-log' })
    await pane.unmount()
  }
  expect(pressed.map(p => p.command)).toEqual(['engrave 3', 'engrave 3'])
})
