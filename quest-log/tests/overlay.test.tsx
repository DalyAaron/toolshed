import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

import type { Armory, Pet, QuestLog } from '../types'
import { HATCH_SECONDS, petFrame } from '../hooks/pets'
import { NONE, base64, cells } from '../hooks/scene'

// The overlay (hooks/overlay.tsx). Run with: claude plugin test quest-log

const BASE = '/home/me/.claude/quests'
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
  look: { bar: ['●', '○'], trophy: '👑', banner: 'Ship It' },
  wares: [
    { id: 'rounded', slot: 'frame', section: '⚒ FRAMES', name: 'Rounded frame', price: 0, preview: '╭──╮', owned: true, equipped: false },
    { id: 'double', slot: 'frame', section: '⚒ FRAMES', name: 'Double frame', price: 10, preview: '╔══╗', owned: false, equipped: false },
    { id: 'ascii', slot: 'frame', section: '⚒ FRAMES', name: 'ASCII frame · for any terminal', price: 5, preview: '+--+', owned: true, equipped: true },
    { id: 'gem', slot: 'trophy', section: '✦ TROPHIES', name: 'Gem trophy', price: 25, preview: '💎', owned: false, equipped: false },
    { id: 'custom', slot: 'banner', section: '⚑ BANNERS', name: 'Custom banner', price: 20, preview: '⚑', owned: true, equipped: false },
  ],
  plaque_price: 3,
  plaques: [
    { id: 1, title: 'Old win', outcome: 'It shipped', project: 'toolshed', date: '2026-10-01', session: 'other', quest: 1, shown: true },
    { id: 2, title: 'Stored win', outcome: null, project: 'toolshed', date: '2026-10-02', session: 'other', quest: 2, shown: false },
  ],
}

type Drawing = {
  find: (q: { key: string; type: string }) => Promise<{ props: Record<string, unknown> } | undefined>
}
const findButton = (pane: Drawing, key: string) => pane.find({ key, type: 'Button' })

const PANE = { title: 'Quests', isFocused: false, bodyColumns: 40, placement: 'dock' } as never
const BAND = { hasSurvey: false, isWorking: false, maxRows: 10, bodyColumns: 60 } as never

// The world beneath the plugin: one session in /proj, its log on disk
// (mtime bumped on every write), quest-log's config.json, and a record of
// every toast raised and every value the plugin gave the live variable.
// `become` is a /clear or an in-app /resume: the process goes on under
// another id, with that session's log, or none yet.
function world(on: On, env: Record<string, string> = {}) {
  const file = { sid: 'sid-1', log: LOG as QuestLog | null, mtime: 1, config: '{}', armory: ARMORY, walletMtime: 1, reply: 'Done.' }
  const store = () => `${BASE}/-proj/${file.sid}.json`
  const toasts: string[] = []
  const live: (string | undefined)[] = []
  // each /quests command a button ran, and the session it ran under
  const pressed: { command: string | undefined; sid: string | undefined }[] = []
  // each Raster repainted in place, by key
  const blits: string[] = []
  // Calls on $ are answered { value } (or { deny }) beneath the plugins.
  const answer = <T,>(value: T) => ({ value }) as never
  mock.env(on, { HOME: '/home/me', ...env })
  on('session.id', () => answer(file.sid))
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
    (e.path === store() && file.log) || e.path === WALLET
      ? answer({ kind: 'file', size: 1, mtimeMs: e.path === store() ? file.mtime : file.walletMtime, isLink: false })
      : ({ deny: `no such file: ${e.path}` } as never),
  )
  on('fs.read', ($, e) =>
    e.path === store() && file.log
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
  on('ui.blit', ($, e) => {
    blits.push(e.key)
    return answer({})
  })
  const write = (log: QuestLog) => {
    file.log = log
    file.mtime += 1
  }
  const become = (sid: string, log: QuestLog | null) => {
    file.sid = sid
    write(log as QuestLog)
  }
  const configure = (config: object) => {
    file.config = JSON.stringify(config)
  }
  const sell = (armory: Armory, reply: string) => {
    file.armory = armory
    file.walletMtime += 1
    file.reply = reply
  }
  return { toasts, live, pressed, blits, write, become, configure, sell }
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

test('follows the session through a /clear and an in-app /resume', async ($, on) => {
  const clock = mock.clock(on)
  const { pressed, become } = world(on, ON)
  await $.session.start({ cwd: '/proj/sub', surface: 'terminal', isInteractive: true })
  await clock.advance(0)
  const mount = () => $.ui.mount({ plugin: 'quest-log', surface: 'terminal', component: 'Pane', requestId: 'quests', props: PANE })

  // /clear: a new id with no log yet, and no session.start
  become('sid-2', null)
  await clock.advance(750)
  let pane = await mount()
  expect(await pane.find({ text: 'No quests yet this session.' })).toBeDefined()
  expect(await pane.find({ text: /Add pagination/ })).toBeUndefined()
  await pane.unmount()

  // /resume into a session that has one
  become('sid-3', { ...DONE_LOG, toasts: [] })
  await clock.advance(750)
  pane = await mount()
  expect(await pane.find({ text: /#3 Ship the cache/ })).toBeDefined()
  // and its buttons run quest.py under the resumed id
  await pane.press({ key: 'tab-trophies' })
  await pane.press({ key: 'engrave-3' })
  await pane.press({ key: 'tab-log' })
  await pane.unmount()
  expect(pressed).toEqual([{ command: 'engrave 3', sid: 'sid-3' }])
})

test('the log page wears what is equipped: banner, rank, gold, bar', async ($, on) => {
  const clock = mock.clock(on)
  world(on, ON)
  await $.session.start({ cwd: '/proj/sub', surface: 'terminal', isInteractive: true })
  await clock.advance(0)

  for (const surface of ['terminal', 'desktop'] as const) {
    const pane = await $.ui.mount({ plugin: 'quest-log', surface, component: 'Pane', requestId: 'quests', props: PANE })
    expect(await pane.find({ text: /⚔ Ship It/ })).toBeDefined()
    expect(await pane.find({ text: /🚩/ })).toBeUndefined()
    // the purse is a Client on both surfaces
    expect(await pane.find({ in: 'purse', text: '🏅 Journeyman' })).toBeDefined()
    expect(await pane.find({ in: 'purse', text: ' · 320 xp' })).toBeDefined()
    expect(await pane.find({ in: 'purse', text: '12' })).toBeDefined()
    expect(await pane.find({ text: /●●●●●○○○○○ 1\/2/ })).toBeDefined()
    expect(await pane.find({ key: 'tab-shop' })).toBeDefined()
    // the XP bar wears the equipped bar too
    expect(await pane.find({ text: /^[●○]{8} 681 to Artificer$/ })).toBeDefined()
    await pane.unmount()
  }
})

test('a purse put back after an outside edit is flagged in the header', async ($, on) => {
  const clock = mock.clock(on)
  const { sell } = world(on, ON)
  sell({ ...ARMORY, tampered: true }, 'Done.')
  await $.session.start({ cwd: '/proj/sub', surface: 'terminal', isInteractive: true })
  await clock.advance(0)
  const pane = await $.ui.mount({ plugin: 'quest-log', surface: 'terminal', component: 'Pane', requestId: 'quests', props: PANE })
  expect((await pane.find({ type: 'Text', text: /🚩 wallet.json was edited outside quest-log/ }))?.props.color).toBe('warning')
  await pane.unmount()
})

const LADDER = [
  ['Initiate', 0], ['Apprentice', 175], ['Journeyman', 450], ['Adept', 925], ['Artificer', 1725],
  ['Enchanter', 2875], ['Sage', 4625], ['Archmage', 6925], ['Grand Archmage', 10375], ['Loremaster', 15000],
].map(([name, floor]) => ({ name: name as string, floor: floor as number }))

test('ranks: a tab of emblem tiles, reached in colour, yours outlined, the rest greyed', async ($, on) => {
  const clock = mock.clock(on)
  const { sell } = world(on, ON)
  sell(
    { ...ARMORY, xp: 5110, rank: { name: 'Sage', floor: 4625, next: { name: 'Archmage', floor: 6925 } }, ranks: LADDER },
    'Done.',
  )
  await $.session.start({ cwd: '/proj/sub', surface: 'terminal', isInteractive: true })
  await clock.advance(0)
  const pane = await $.ui.mount({ plugin: 'quest-log', surface: 'terminal', component: 'Pane', requestId: 'quests', props: PANE })
  await pane.press({ key: 'tab-ranks' })
  expect(await pane.find({ type: 'Text', text: ' · rank 7 of 10' })).toBeDefined()
  // ten tiles, lowest first; yours in the accent, those ahead dim
  for (let i = 0; i < 10; i++) expect(await pane.find({ key: `rank-${i}` })).toBeDefined()
  expect((await pane.find({ key: 'rank-6' }))?.props).toMatchObject({ borderColor: 'claude', width: 14 })
  expect((await pane.find({ key: 'rank-9' }))?.props.borderDimColor).toBe(true)
  expect((await pane.find({ key: 'rank-5' }))?.props.borderDimColor).toBe(false)
  expect(await pane.find({ type: 'Text', text: ' ◆ 4625 xp  ' })).toBeDefined()
  expect(await pane.find({ type: 'Text', text: ' 9890 to go ' })).toBeDefined()
  // a long name takes two lines
  expect(await pane.find({ type: 'Text', text: '   Grand    ' })).toBeDefined()
  expect(await pane.find({ type: 'Text', text: '  Archmage  ' })).toBeDefined()
  await pane.unmount()
})

test('shop: Buy runs /quests buy through quest.py and shows its answer', async ($, on) => {
  const clock = mock.clock(on)
  const { pressed, sell, toasts } = world(on, ON)
  await $.session.start({ cwd: '/proj/sub', surface: 'terminal', isInteractive: true })
  await clock.advance(0)

  for (const surface of ['terminal', 'desktop'] as const) {
    const pane = await $.ui.mount({ plugin: 'quest-log', surface, component: 'Pane', requestId: 'quests', props: PANE })
    await pane.press({ key: 'tab-shop' })
    // free wares aren't for sale; owned ones equip; equipped ones say so
    expect(await pane.find({ key: 'buy-rounded' })).toBeUndefined()
    expect(await pane.find({ key: 'equip-ascii' })).toBeUndefined()
    expect(await pane.find({ text: /◆ on/ })).toBeDefined()
    expect(await pane.find({ key: 'buy-gem' })).toBeDefined()
    expect(await pane.find({ key: 'equip-custom' })).toBeDefined()

    sell(
      { ...ARMORY, gold: 2, wares: ARMORY.wares.map(w => (w.id === 'double' ? { ...w, owned: true, equipped: true } : w)) },
      'Bought the Double frame ╔══╗ for 10 💰\nEquipped, and in your inventory.\n2 💰 left.',
    )
    await pane.press({ key: 'buy-double' })
    // what quest.py said is a toast, not a line in the pane
    expect(toasts.at(-1)).toBe('Bought the Double frame ╔══╗ for 10 💰\nEquipped, and in your inventory.\n2 💰 left.')
    expect(await pane.find({ text: /Bought the Double frame/ })).toBeUndefined()
    expect(await pane.find({ key: 'buy-double' })).toBeUndefined()
    expect(await pane.find({ in: 'purse', text: '2' })).toBeDefined()
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
  await pane.press({ key: 'unequip-ascii' })
  await pane.press({ key: 'store-p1' })
  await pane.press({ key: 'display-p2' })
  await pane.input({ key: 'banner-text', text: '  Keeper of Caches ' })

  expect(pressed.map(p => p.command)).toEqual([
    'equip rounded',
    'unequip ascii',
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

test('shop: the sign is pixels on a terminal, animated while the shop is in view', async ($, on) => {
  const clock = mock.clock(on)
  const { blits } = world(on, ON)
  await $.session.start({ cwd: '/proj/sub', surface: 'terminal', isInteractive: true })
  await clock.advance(0)

  const pane = await $.ui.mount({ plugin: 'quest-log', surface: 'terminal', component: 'Pane', requestId: 'quests', props: PANE })
  await pane.press({ key: 'tab-shop' })
  const sign = await pane.find({ key: 'sign' })
  expect(sign?.type).toBe('Raster')
  expect(sign?.props).toMatchObject({ columns: 40, rows: 12 }) // the pane's width; docked, 12 rows
  // 40 × 12 cells of three u32s, base64
  expect(String(sign?.props.cells).length).toBe(Math.ceil((40 * 12 * 12) / 3) * 4)

  await clock.advance(125 * 4)
  expect(blits.filter(k => k === 'sign').length).toBeGreaterThanOrEqual(4)

  // off the shop, the clock stops
  await pane.press({ key: 'tab-log' })
  await clock.advance(125 * 2)
  const after = blits.length
  await clock.advance(125 * 8)
  expect(blits.length).toBe(after)
  await pane.unmount()
})

test('shop: elsewhere the sign is the same pixels as an SVG, and nothing ticks', async ($, on) => {
  const clock = mock.clock(on)
  const { blits } = world(on, ON)
  await $.session.start({ cwd: '/proj/sub', surface: 'desktop', isInteractive: true })
  await clock.advance(0)

  const pane = await $.ui.mount({ plugin: 'quest-log', surface: 'desktop', component: 'Pane', requestId: 'quests', props: PANE })
  await pane.press({ key: 'tab-shop' })
  const sign = await pane.find({ type: 'Svg' })
  expect(String(sign?.props.source)).toMatch(/^<svg [^>]*>(<rect [^>]+\/>)+<\/svg>$/)
  expect(await pane.find({ type: 'Raster' })).toBeUndefined()
  await clock.advance(1000)
  expect(blits).toEqual([])
  await pane.unmount()
})

test('the purse counts up to new figures and flashes what was gained', async ($, on) => {
  const clock = mock.clock(on)
  const { sell } = world(on, ON)
  await $.session.start({ cwd: '/proj/sub', surface: 'terminal', isInteractive: true })
  await clock.advance(0)

  const pane = await $.ui.mount({ plugin: 'quest-log', surface: 'terminal', component: 'Pane', requestId: 'quests', props: PANE })
  expect(await pane.find({ in: 'purse', text: '12' })).toBeDefined()

  sell({ ...ARMORY, gold: 17, xp: 340 }, 'Done.')
  await clock.advance(750)
  await pane.advance(1000)
  expect(await pane.find({ in: 'purse', text: '17' })).toBeDefined()
  expect(await pane.find({ in: 'purse', text: '+5 ' })).toBeDefined()
  expect(await pane.find({ in: 'purse', text: ' +20' })).toBeDefined()

  await pane.advance(3000)
  expect(await pane.find({ in: 'purse', text: '+5 ' })).toBeUndefined()
  await pane.unmount()
})

test('a quest turned in while watched shimmers, then settles; its loot links', async ($, on) => {
  const clock = mock.clock(on)
  const { write } = world(on, ON)
  await $.session.start({ cwd: '/proj/sub', surface: 'terminal', isInteractive: true })
  await clock.advance(0)

  const pane = await $.ui.mount({ plugin: 'quest-log', surface: 'terminal', component: 'Pane', requestId: 'quests', props: PANE })
  const [first, ...rest] = LOG.quests
  if (!first) throw new Error('fixture has no quests')
  write({
    ...LOG,
    quests: [
      { ...first, status: 'done', outcome: 'Shipped', loot: ['docs/a.md', 'https://x.test/pr/1', 'http://x.test/a', 'abc1234'] },
      ...rest,
    ],
  })
  await clock.advance(750)

  expect((await pane.find({ key: 'shine1' }))?.type).toBe('Client')
  await pane.advance(45 * 5)
  expect(await pane.find({ in: 'shine1', type: 'Text', text: /#1/ })).toBeDefined()
  await pane.advance(20000)
  expect((await pane.find({ in: 'shine1', type: 'Text' }))?.text).toBe('#1 Add pagination')

  const links = await pane.findAll({ type: 'Link' })
  // only https is a link; a path, a sha and plain http are text
  expect(links.map(l => [l.props.href, l.props.label])).toEqual([['https://x.test/pr/1', 'x.test/pr/1']])
  expect(await pane.find({ type: 'Text', text: 'docs/a.md' })).toBeDefined()
  expect(await pane.find({ type: 'Text', text: 'http://x.test/a' })).toBeDefined()
  expect(await pane.find({ type: 'Text', text: 'abc1234' })).toBeDefined()
  await pane.unmount()
})

const PET: Pet = {
  id: 1, species: 'fox', kind: 'Fox', emoji: '🦊', name: 'Ember', rarity: 'uncommon', likes: 'feast',
  joy: 72, full: 15, mood: 'happy', hungry: true, petted: 0,
}
const PETS: Armory = {
  ...ARMORY,
  egg_price: 1000,
  food: [
    { id: 'kibble', name: 'Kibble', emoji: '🥣', price: 1, full: 30, joy: 2, stock: 2 },
    { id: 'treat', name: 'Treat', emoji: '🍪', price: 2, full: 10, joy: 12, stock: 0 },
    { id: 'feast', name: 'Feast', emoji: '🍗', price: 4, full: 70, joy: 8, stock: 1 },
  ],
  pets: [PET, { ...PET, id: 2, species: 'duck', kind: 'Rubber duck', emoji: '🦆', name: 'Quackers', hungry: false, full: 80 }],
}

test('shop: sells the mystery egg and food, a portion at a time', async ($, on) => {
  const clock = mock.clock(on)
  const { pressed, sell, toasts } = world(on, ON)
  sell(PETS, 'Bought a mystery egg 🥚 for 1000 💰\nHatch the egg in your pen: `/quests hatch 3`.\n999 💰 left.')
  await $.session.start({ cwd: '/proj/sub', surface: 'terminal', isInteractive: true })
  await clock.advance(0)

  for (const surface of ['terminal', 'desktop'] as const) {
    const pane = await $.ui.mount({ plugin: 'quest-log', surface, component: 'Pane', requestId: 'quests', props: PANE })
    await pane.press({ key: 'tab-shop' })
    expect(await pane.find({ key: 'buy-egg' })).toBeDefined()
    expect(await pane.find({ text: /×2 1 💰/ })).toBeDefined() // kibble in the inventory
    await pane.press({ key: 'buy-egg' })
    // what's inside is the hatching's to say
    expect(toasts.at(-1)).toBe('Bought a mystery egg 🥚\nHatch the egg in your Pets tab!\n999 💰 left.')
    await pane.press({ key: 'buy-kibble' })
    await pane.unmount()
  }
  expect(pressed.map(p => p.command)).toEqual(['buy egg', 'buy kibble', 'buy egg', 'buy kibble'])
})

test('pets: each moves on a terminal, and is petted, fed and named from its card', async ($, on) => {
  const clock = mock.clock(on)
  const { pressed, sell, blits, toasts } = world(on, ON)
  sell(PETS, 'You pet Ember.')
  await $.session.start({ cwd: '/proj/sub', surface: 'terminal', isInteractive: true })
  await clock.advance(0)

  const pane = await $.ui.mount({ plugin: 'quest-log', surface: 'terminal', component: 'Pane', requestId: 'quests', props: PANE })
  await pane.press({ key: 'tab-pets' })
  expect((await pane.find({ key: 'sprite-1' }))?.props).toMatchObject({ columns: 14, rows: 9 })
  expect((await pane.find({ key: 'sprite-2' }))?.type).toBe('Raster')
  expect(await pane.find({ text: 'Ember' })).toBeDefined()
  expect(await pane.find({ text: ' hungry!' })).toBeDefined()
  expect(await pane.find({ text: '♥♥♥♥♥♥♥♡♡♡' })).toBeDefined()
  // feed buttons only for what's in the inventory; its favourite stands out
  expect((await pane.find({ type: 'Text', text: /^uncommon$/ }))?.props.color).toBe('suggestion')
  expect(await pane.find({ key: 'pet-1-feed-treat' })).toBeUndefined()
  expect((await pane.find({ key: 'pet-1-feed-feast' }))?.props).toMatchObject({ label: 'Feed 🍗 ×1', variant: 'primary' })
  expect((await pane.find({ key: 'pet-1-feed-kibble' }))?.props.variant).toBe('secondary')

  await clock.advance(125 * 3)
  expect(blits.filter(k => k === 'sprite-1').length).toBeGreaterThanOrEqual(3)
  expect(blits.filter(k => k === 'sprite-2').length).toBeGreaterThanOrEqual(3)

  await pane.press({ key: 'pet-1-pet' })
  await pane.press({ key: 'pet-1-feed-feast' })
  await pane.input({ key: 'pet-2-name', text: '  Sir Quacks ' })
  expect(pressed.map(p => p.command)).toEqual(['pet 1', 'feed 1 feast', 'name 2 Sir Quacks'])
  expect(toasts).toContain('You pet Ember.')
  await pane.unmount()
})

test('pets: Release asks first, then lets the pet go; Keep thinks better of it', async ($, on) => {
  const clock = mock.clock(on)
  const { pressed, sell, toasts } = world(on, ON)
  sell(PETS, 'You release Ember 🦊 into the wild. Goodbye, Ember!\n1 left in the pen.')
  await $.session.start({ cwd: '/proj/sub', surface: 'desktop', isInteractive: true })
  await clock.advance(0)

  const pane = await $.ui.mount({ plugin: 'quest-log', surface: 'desktop', component: 'Pane', requestId: 'quests', props: PANE })
  await pane.press({ key: 'tab-pets' })
  expect((await pane.find({ key: 'pet-1-release' }))?.props.label).toBe('Release')
  // the first press only asks, and asks on that card alone
  await pane.press({ key: 'pet-1-release' })
  expect(pressed).toEqual([])
  expect(await pane.find({ text: 'Let Ember go for good?' })).toBeDefined()
  expect(await pane.find({ key: 'pet-1-release' })).toBeUndefined()
  expect(await pane.find({ key: 'pet-2-release' })).toBeDefined()
  await pane.press({ key: 'pet-1-release-keep' })
  expect(await pane.find({ text: 'Let Ember go for good?' })).toBeUndefined()
  expect(pressed).toEqual([])
  // asked again and meant it
  await pane.press({ key: 'pet-1-release' })
  await pane.press({ key: 'pet-1-release-yes' })
  expect(pressed.map(p => p.command)).toEqual(['release 1'])
  expect(toasts).toContain('You release Ember 🦊 into the wild. Goodbye, Ember!\n1 left in the pen.')
  await pane.unmount()
})

const EGG: Pet = {
  id: 3, egg: true, species: 'egg', kind: 'Mystery egg', emoji: '🥚', name: 'Unhatched egg', rarity: 'common',
  likes: '', joy: 0, full: 0, mood: '', hungry: false, petted: 0,
}
const BUBBLES: Pet = { ...PET, id: 3, species: 'axolotl', kind: 'Axolotl', emoji: '🦎', name: 'Bubbles', hungry: false, full: 70, joy: 70 }
const HATCH_SAID = "The egg cracks... it's an Axolotl 🦎 (uncommon)! Meet Bubbles, pet #3. `/quests name 3 <name>` to rename."
const EGG_CELLS = base64(cells(petFrame('axolotl', 0, { joy: 70, hungry: false, sincePetted: -1, sinceHatched: 0 }, 3)))

test('pets: an egg waits in the pen; pressing it hatches it, and what it is shows when the shell gives', async ($, on) => {
  const clock = mock.clock(on)
  const { pressed, sell, toasts } = world(on, ON)
  sell({ ...PETS, pets: [...PETS.pets!, EGG] }, 'Done.')
  await $.session.start({ cwd: '/proj/sub', surface: 'terminal', isInteractive: true })
  await clock.advance(0)
  const pane = await $.ui.mount({ plugin: 'quest-log', surface: 'terminal', component: 'Pane', requestId: 'quests', props: PANE })
  await pane.press({ key: 'tab-pets' })

  // the egg on top, its picture the press, nothing to tend and nothing given away
  expect((await findButton(pane, 'hatch-3-egg'))?.props).toMatchObject({ label: 'Hatch egg #3', plain: true })
  expect((await findButton(pane, 'hatch-3'))?.props.label).toBe('Hatch')
  expect(await pane.find({ type: 'Text', text: 'Unhatched egg' })).toBeDefined()
  expect(await findButton(pane, 'pet-3-pet')).toBeUndefined()
  expect(await pane.find({ key: 'sprite-3' })).toBeUndefined()

  sell({ ...PETS, pets: [...PETS.pets!, BUBBLES] }, HATCH_SAID)
  await pane.press({ key: 'hatch-3-egg' })
  expect(pressed.map(p => p.command)).toEqual(['hatch 3'])
  // cracking: the egg's details still, and no toast yet
  expect((await pane.find({ key: 'sprite-3' }))?.props.cells).toBe(EGG_CELLS)
  expect((await pane.findAll({ type: 'Raster' })).map(r => r.props.key)).toEqual(['sprite-3', 'sprite-2', 'sprite-1'])
  expect(await pane.find({ type: 'Text', text: "It's hatching!" })).toBeDefined()
  expect(await pane.find({ type: 'Text', text: 'Bubbles' })).toBeUndefined()
  expect(toasts.filter(t => t.startsWith('The egg cracks'))).toEqual([])

  // the shell gives: the toast, and its details beside it
  await clock.advance(2500)
  expect(toasts.at(-1)).toBe("The egg cracks... it's an Axolotl 🦎\n(uncommon)! Meet Bubbles, pet #3.\nRename it from its card.")
  expect(await pane.find({ type: 'Text', text: 'Bubbles' })).toBeDefined()
  expect(await findButton(pane, 'pet-3-pet')).toBeDefined()
  await clock.advance((HATCH_SECONDS + 0.5) * 1000)
  await pane.unmount()
  const again = await $.ui.mount({ plugin: 'quest-log', surface: 'terminal', component: 'Pane', requestId: 'quests', props: PANE })
  expect((await again.find({ key: 'sprite-3' }))?.props.cells).not.toBe(EGG_CELLS)
  await again.unmount()
})

test('pets: an egg hatched by /quests hatch plays out where it is first seen', async ($, on) => {
  const clock = mock.clock(on)
  const { sell } = world(on, ON)
  sell({ ...PETS, pets: [...PETS.pets!, EGG] }, 'Done.')
  await $.session.start({ cwd: '/proj/sub', surface: 'terminal', isInteractive: true })
  await clock.advance(0)
  const pane = await $.ui.mount({ plugin: 'quest-log', surface: 'terminal', component: 'Pane', requestId: 'quests', props: PANE })
  await pane.press({ key: 'tab-pets' })
  // the pets already in the pen when the overlay started are not new
  expect((await pane.find({ key: 'sprite-1' }))?.props.cells).not.toBe(
    base64(cells(petFrame('fox', 0, { joy: 72, hungry: true, sincePetted: -1, sinceHatched: 0 }, 1))),
  )
  sell({ ...PETS, pets: [...PETS.pets!, BUBBLES] }, 'Done.')
  await clock.advance(750)
  expect((await pane.find({ key: 'sprite-3' }))?.props.cells).toBe(EGG_CELLS)
  // the prompt already said what it is: no veil
  expect(await pane.find({ type: 'Text', text: 'Bubbles' })).toBeDefined()
  await pane.unmount()
})

test('pets: the hatch is an egg that cracks, a lid that flies, then the pet', () => {
  const pose = { joy: 50, hungry: false, sincePetted: -1 }
  const shell = 0xf4ead0
  const crack = 0x5a3b1e
  const at = (s: number) => Array.from(petFrame('dog', 5, { ...pose, sinceHatched: s }, 2).px)
  expect(at(0.5)).toContain(shell)
  expect(at(0.5)).not.toContain(crack)
  expect(at(2.2)).toContain(crack) // cracking
  expect(at(2.6)).toContain(0xb5794a) // the dog peeks out (its coat)
  expect(at(2.6)).toContain(shell)
  expect(at(HATCH_SECONDS + 0.1)).not.toContain(shell)
  // without a hatch, or long after, it's just the dog
  expect(at(-1)).toEqual(Array.from(petFrame('dog', 5, pose, 2).px))
})

test('pets: a shiny one is the same sprite recoloured, with a twinkle now and then', () => {
  const pose = { joy: 50, hungry: false, sincePetted: -1 }
  const plain = (t: number) => Array.from(petFrame('dog', t, pose, 0).px)
  const shiny = (t: number) => Array.from(petFrame('dog', t, { ...pose, shiny: true }, 0).px)
  const star = 0xffd24a
  expect(plain(1)).toContain(0xb5794a) // its brown coat
  expect(shiny(1)).not.toContain(0xb5794a)
  expect(shiny(1)).toContain(0xe8c070) // golden instead
  // the same shape: every pixel filled in one is filled in the other
  const shape = (px: number[]) => px.map(c => c !== NONE)
  expect(shape(shiny(1))).toEqual(shape(plain(1)))
  // the twinkle comes and goes; a plain pet never has one
  expect(shiny(0.2)).toContain(star)
  expect(shiny(1)).not.toContain(star)
  expect(plain(0.2)).not.toContain(star)
})

test('pets: elsewhere a still picture; an empty pen offers an egg', async ($, on) => {
  const clock = mock.clock(on)
  const { pressed, sell } = world(on, ON)
  sell(PETS, 'Done.')
  await $.session.start({ cwd: '/proj/sub', surface: 'desktop', isInteractive: true })
  await clock.advance(0)

  const pane = await $.ui.mount({ plugin: 'quest-log', surface: 'desktop', component: 'Pane', requestId: 'quests', props: PANE })
  await pane.press({ key: 'tab-pets' })
  expect((await pane.findAll({ type: 'Svg' })).map(e => e.props.alt)).toEqual(['Quackers the rubber duck', 'Ember the fox']) // newest first
  expect(await pane.find({ type: 'Raster' })).toBeUndefined()
  await pane.unmount()

  sell({ ...PETS, pets: [] }, 'The egg cracks...')
  await clock.advance(750)
  const empty = await $.ui.mount({ plugin: 'quest-log', surface: 'desktop', component: 'Pane', requestId: 'quests', props: PANE })
  expect(await empty.find({ text: /The pen is empty/ })).toBeDefined()
  await empty.press({ key: 'buy-egg' })
  expect(pressed.map(p => p.command)).toEqual(['buy egg'])
  await empty.unmount()
})

const POTIONS: Armory = {
  ...PETS,
  potions: [
    { id: 'health', name: 'Health potion', color: 'red', look: '🔴', note: 'heals every pet', price: 10, stock: 2 },
    { id: 'xp', name: 'XP booster', color: 'green', look: '🟢', note: '5x xp, 1 hour', price: 15, stock: 1 },
    { id: 'luck', name: 'Lucky potion', color: 'yellow', look: '🟡', note: '5x gold, 1 hour', price: 15, stock: 0 },
  ],
  boost_times: 5,
  boosts: { xp: 0, gold: Math.round(Date.now() / 1000) + 25 * 60 },
}

test('potions: bought from the shop, drunk from the inventory and the pen, boosts in the header', async ($, on) => {
  const clock = mock.clock(on)
  const { pressed, sell } = world(on, ON)
  sell(POTIONS, 'You drink the xp booster 🟢.')
  await $.session.start({ cwd: '/proj/sub', surface: 'terminal', isInteractive: true })
  await clock.advance(0)

  const pane = await $.ui.mount({ plugin: 'quest-log', surface: 'terminal', component: 'Pane', requestId: 'quests', props: PANE })
  // only the boost that's working, in its potion's colour
  const boosts = await pane.findAll({ type: 'Text', text: / 5x / })
  expect(boosts.map(t => t.props.color)).toEqual(['warning'])
  expect(boosts[0]?.text).toMatch(/^🟡 5x gold · 2[45]m$/)

  await pane.press({ key: 'tab-shop' })
  expect((await findButton(pane, 'buy-luck'))?.props.label).toBe('Buy lucky potion for 15 gold')
  expect(await pane.find({ type: 'Text', text: /×2 10 💰/ })).toBeDefined() // health potions in stock
  await pane.press({ key: 'buy-health' })

  await pane.press({ key: 'tab-inventory' })
  expect(await findButton(pane, 'drink-luck')).toBeUndefined() // none in stock
  await pane.press({ key: 'drink-xp' })

  await pane.press({ key: 'tab-pets' })
  expect((await findButton(pane, 'drink-health'))?.props.label).toBe('Drink 🔴 ×2: heal every pet')
  await pane.press({ key: 'drink-health' })
  expect(pressed.map(p => p.command)).toEqual(['buy health', 'drink xp', 'drink health'])
  await pane.unmount()
})

test('shop: a grid of tiles, each its pixels, name and price, the whole tile one press', async ($, on) => {
  const clock = mock.clock(on)
  const { pressed, sell } = world(on, ON)
  sell(POTIONS, 'Bought.')
  await $.session.start({ cwd: '/proj/sub', surface: 'terminal', isInteractive: true })
  await clock.advance(0)

  const pane = await $.ui.mount({ plugin: 'quest-log', surface: 'terminal', component: 'Pane', requestId: 'quests', props: PANE })
  await pane.press({ key: 'tab-shop' })
  expect(await pane.find({ key: 'sign' })).toBeDefined()
  for (const head of ['⚒ LOOKS', '🥚 PETS AND FOOD', '🧪 POTIONS']) expect(await pane.find({ type: 'Text', text: head })).toBeDefined()
  // a tile is a bordered box as wide as its picture, the press inside it
  const tile = await pane.find({ key: 'tile-gem' })
  expect(tile?.props).toMatchObject({ borderStyle: 'round', width: 14 })
  const gem = await findButton(pane, 'buy-gem')
  expect(gem?.props).toMatchObject({ label: 'Buy the Gem trophy for 25 gold', plain: true })
  // its pixels: half blocks in the gem's colours, then its name and price
  const gemBlue = (await pane.findAll({ type: 'Text', text: /▀/ })).filter(t => t.props.color === '#6ad1ff')
  expect(gemBlue.length).toBeGreaterThan(0)
  expect(await pane.find({ type: 'Text', text: '    Gem     ' })).toBeDefined()
  expect(await pane.find({ type: 'Text', text: '   25 💰   ' })).toBeDefined()
  // what's on can't be bought again; what can't be afforded is dim
  expect(await pane.find({ key: 'tile-ascii' })).toBeDefined()
  expect(await findButton(pane, 'equip-ascii')).toBeUndefined()
  expect((await pane.find({ key: 'tile-egg' }))?.props.borderDimColor).toBe(true)
  await pane.press({ key: 'buy-gem' })
  await pane.press({ key: 'equip-custom' })
  await pane.press({ key: 'buy-xp' })
  expect(pressed.map(p => p.command)).toEqual(['buy gem', 'equip custom', 'buy xp'])
  await pane.unmount()
})
