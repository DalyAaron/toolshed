import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

import type { Armory, Pet, QuestLog } from '../types'

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

// The shop's shelf headers, and opening one unless it's open already (the
// open set outlives a mount).
type Drawing = {
  find: (q: { key: string; type: string }) => Promise<{ props: Record<string, unknown> } | undefined>
  press: (q: { key: string }) => Promise<unknown>
}
const findButton = (pane: Drawing, key: string) => pane.find({ key, type: 'Button' })
async function openShelf(pane: Drawing, id: string) {
  if (String((await findButton(pane, `shelf-${id}`))?.props.label).startsWith('▸')) await pane.press({ key: `shelf-${id}` })
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
  // each Raster repainted in place, by key
  const blits: string[] = []
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
  on('ui.blit', ($, e) => {
    blits.push(e.key)
    return answer({})
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
  return { toasts, live, pressed, blits, write, configure, sell }
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

test('shop: Buy runs /quests buy through quest.py and shows its answer', async ($, on) => {
  const clock = mock.clock(on)
  const { pressed, sell, toasts } = world(on, ON)
  await $.session.start({ cwd: '/proj/sub', surface: 'terminal', isInteractive: true })
  await clock.advance(0)

  for (const surface of ['terminal', 'desktop'] as const) {
    const pane = await $.ui.mount({ plugin: 'quest-log', surface, component: 'Pane', requestId: 'quests', props: PANE })
    await pane.press({ key: 'tab-shop' })
    await openShelf(pane, 'frame')
    await openShelf(pane, 'trophy')
    // free wares aren't for sale; owned ones equip; equipped ones say so
    expect(await pane.find({ key: 'buy-rounded' })).toBeUndefined()
    expect(await pane.find({ key: 'equip-heavy' })).toBeUndefined()
    expect(await pane.find({ text: /◆ equipped/ })).toBeDefined()
    expect(await pane.find({ key: 'buy-gem' })).toBeDefined()

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
    quests: [{ ...first, status: 'done', outcome: 'Shipped', loot: ['docs/a.md', 'https://x.test/pr/1', 'abc1234'] }, ...rest],
  })
  await clock.advance(750)

  expect((await pane.find({ key: 'shine1' }))?.type).toBe('Client')
  await pane.advance(45 * 5)
  expect(await pane.find({ in: 'shine1', type: 'Text', text: /#1/ })).toBeDefined()
  await pane.advance(20000)
  expect((await pane.find({ in: 'shine1', type: 'Text' }))?.text).toBe('#1 Add pagination')

  const links = await pane.findAll({ type: 'Link' })
  expect(links.map(l => l.props.href)).toEqual(['file:///proj/docs/a.md', 'https://x.test/pr/1'])
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
  sell(PETS, "The egg cracks... it's an Axolotl 🦎 (uncommon)! Meet Bubbles, pet #2. `/quests name 2 <name>` to rename. 999 💰 left.")
  await $.session.start({ cwd: '/proj/sub', surface: 'terminal', isInteractive: true })
  await clock.advance(0)

  for (const surface of ['terminal', 'desktop'] as const) {
    const pane = await $.ui.mount({ plugin: 'quest-log', surface, component: 'Pane', requestId: 'quests', props: PANE })
    await pane.press({ key: 'tab-shop' })
    await openShelf(pane, 'pets')
    await openShelf(pane, 'food')
    expect((await pane.find({ key: 'buy-egg' }))?.props.label).toBe('Buy 1000 💰')
    expect((await pane.find({ key: 'buy-feast' }))?.props.dimColor).toBe(false)
    expect(await pane.find({ text: '×2' })).toBeDefined() // kibble in the inventory
    await pane.press({ key: 'buy-egg' })
    // laid out for a toast's three lines
    expect(toasts.at(-1)).toBe("The egg cracks... it's an Axolotl 🦎\n(uncommon)! Meet Bubbles, pet #2.\nFind it in the Pets tab!")
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

test('pets: elsewhere a still picture; an empty pen offers an egg', async ($, on) => {
  const clock = mock.clock(on)
  const { pressed, sell } = world(on, ON)
  sell(PETS, 'Done.')
  await $.session.start({ cwd: '/proj/sub', surface: 'desktop', isInteractive: true })
  await clock.advance(0)

  const pane = await $.ui.mount({ plugin: 'quest-log', surface: 'desktop', component: 'Pane', requestId: 'quests', props: PANE })
  await pane.press({ key: 'tab-pets' })
  expect((await pane.findAll({ type: 'Svg' })).map(e => e.props.alt)).toEqual(['Ember the fox', 'Quackers the rubber duck'])
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

test('shop: every shelf starts closed, says what it holds, and opens and closes', async ($, on) => {
  const clock = mock.clock(on)
  world(on, ON)
  await $.session.start({ cwd: '/proj/sub', surface: 'terminal', isInteractive: true })
  await clock.advance(0)

  const pane = await $.ui.mount({ plugin: 'quest-log', surface: 'terminal', component: 'Pane', requestId: 'quests', props: PANE })
  await pane.press({ key: 'tab-shop' })
  expect(await pane.find({ key: 'sign' })).toBeDefined()
  expect(await pane.find({ type: 'Button', text: /^Buy/ })).toBeUndefined()
  const labels = (await pane.findAll({ type: 'Button' })).map(b => String(b.props.label)).filter(l => /^[▸▾]/.test(l))
  expect(labels).toEqual(['▸ ⚒ FRAMES · 1 for sale', '▸ ✦ TROPHIES · 1 for sale', '▸ ⚑ BANNERS · all owned'])

  await pane.press({ key: 'shelf-trophy' })
  expect((await findButton(pane, 'shelf-trophy'))?.props.label).toBe('▾ ✦ TROPHIES · 1 for sale')
  expect(await pane.find({ key: 'buy-gem' })).toBeDefined()
  expect(await pane.find({ key: 'buy-double' })).toBeUndefined() // the frames stay shut

  // kept while the pane comes and goes
  await pane.unmount()
  const again = await $.ui.mount({ plugin: 'quest-log', surface: 'terminal', component: 'Pane', requestId: 'quests', props: PANE })
  expect(await again.find({ key: 'buy-gem' })).toBeDefined()
  await again.press({ key: 'shelf-trophy' })
  expect(await again.find({ key: 'buy-gem' })).toBeUndefined()
  await again.unmount()
})
