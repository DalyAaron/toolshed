import { atom, read, update } from 'claude-code'
import type { Elements, EngineInterface, Register, RenderChildren, RenderSurface, TextProps, Timer } from 'claude-code'

import type { Armory, Food, Pet, Plaque, Potion, Quest, QuestLog, Toast, View, Ware } from '../types'
import { PET_COLUMNS, PET_ROWS, REVEAL_SECONDS, petFrame } from './pets'
import { WARE_PIXELS, wareArt } from './wares'
import { EMBLEM_PIXELS, emblem } from './ranks'
import type { Canvas as Pixels } from './scene'
import { base64, cells, halfBlocks, shop, svg } from './scene'
import type { Canvas } from './scene'

// The overlay: quest-log drawn inside Claude Code. quest.py stays the only
// writer of the log and the purse; this reads the session's JSON and
// `quest.py armory`, and draws them: a pane with the log, the shop, the
// inventory and the hall, a toast per change as it lands, and a band while
// a quest waits on the person. Its Buy / Equip / Engrave buttons run the
// same `/quests` commands the person would type, through `quest.py dispatch`.
// Where the surface can, it draws more than text: the shop's sign is pixel art
// (scene.ts) the clock animates, and the purse and a fresh turn-in move on
// the surface itself (purse.tsx, shimmer.tsx).
// Off unless the `overlay` setting is on. While it's on it sets
// CLAUDE_QUESTS_OVERLAY_LIVE, which tells the Stop hook to leave out its
// end-of-turn line. See DESIGN.md, "The overlay".

const PANE = 'quests'
const POLL_MS = 750
// Inline (above the prompt) a pane opens a third of the screen tall unless it
// asks; the log and the shop want more. The layout caps it, and a size the
// person drags wins.
const PANE_ROWS = 40
// What moves (the shop's sign, the pets) gets a frame every FRAME_MS while
// it's in view. The sign is as wide as the pane up to SCENE_MAX; inline, where
// rows are dear, 7 rows to docked's 12.
const FRAME_MS = 125
const SCENE_MAX = 64
const VIEWS: readonly { view: View; label: string; hotkey: string }[] = [
  { view: 'log', label: 'Log', hotkey: 'l' },
  { view: 'shop', label: 'Shop', hotkey: 's' },
  { view: 'inventory', label: 'Inventory', hotkey: 'i' },
  { view: 'trophies', label: 'Trophies', hotkey: 't' },
  { view: 'pets', label: 'Pets', hotkey: 'p' },
  { view: 'ranks', label: 'Ranks', hotkey: 'r' },
]

const log = atom({ plugin: 'quest-log', key: 'log' } as const, null)
const shown = atom({ plugin: 'quest-log', key: 'shown' } as const, [])
const isOn = atom({ plugin: 'quest-log', key: 'isOn' } as const, false)
const armory = atom({ plugin: 'quest-log', key: 'armory' } as const, null)
const view = atom({ plugin: 'quest-log', key: 'view' } as const, 'log')

// The elements the views draw with: every surface has the first four, the
// rest only some (no Input on mobile, Raster on the terminal alone, Svg on
// every surface but the terminal, Client on the terminal and desktop).
type Els = Pick<Elements['desktop'], 'Box' | 'Text' | 'Button' | 'Link'> &
  Partial<Pick<Elements['desktop'], 'Input' | 'Svg' | 'Client'> & Pick<Elements['terminal'], 'Raster'>> & {
    // the terminal's own Button, unbracketed, for a shop tile: its pixels are the press
    TileButton?: Elements['terminal']['Button']
  }

// A surface's table names every element of every surface, one it can't draw
// drawing nothing, so what the views may use goes by the surface, not by
// what the table holds.
//
// On a terminal a Button is drawn `[Label]`: plain (none of the engine's
// `[ Label ]` chrome) with the brackets in its own text, the main one in the
// accent colour as a primary would be. A plain Button shows its hotkey as
// `l: ` before it, so there it has none; Tab and the arrows still reach it.
// Elsewhere the surface's own buttons, hotkeys and all.
function elementsFor(table: Elements[RenderSurface], surface: RenderSurface): Els {
  const all = table as unknown as Elements['terminal'] & Elements['desktop']
  const { Box, Text, Link } = all
  const Button: Els['Button'] =
    surface === 'terminal'
      ? ({ hotkey: _, ...props }) =>
          all.Button({
            ...props,
            plain: true,
            children: Text({ color: props.variant === 'primary' ? 'suggestion' : undefined, children: `[${props.label ?? ''}]` }),
          })
      : all.Button
  return {
    Box,
    Text,
    Button,
    Link,
    Input: surface === 'mobile' ? undefined : all.Input,
    Client: surface === 'terminal' || surface === 'desktop' ? all.Client : undefined,
    Raster: surface === 'terminal' ? all.Raster : undefined,
    Svg: surface === 'terminal' ? undefined : all.Svg,
    TileButton: surface === 'terminal' ? all.Button : undefined,
  }
}

// quest.py's slug(): the store keys a project by its git root, so spelled
const slug = (path: string) => path.replace(/[^A-Za-z0-9]+/g, '-')

const toastText = (t: Toast) => (typeof t === 'string' ? t : t.text)

const progress = (q: Quest) => {
  const counted = q.objectives.filter(o => o.state !== 'parked')
  return { done: counted.filter(o => o.state === 'done').length, total: counted.length }
}

const meter = (fraction: number, look: readonly [string, string] = ['▰', '▱'], size = 10) => {
  const full = Math.round(Math.min(1, Math.max(0, fraction)) * size)
  return look[0].repeat(full) + look[1].repeat(size - full)
}

const MARK = { done: '✔', failed: '✘', parked: '…', open: '○' } as const

const viewOf = (text: string): View | undefined => VIEWS.find(v => v.view === text.trim().toLowerCase())?.view

// A reload starts these over; the log itself is re-read and the queue's
// shown part is in $.state, so nothing is toasted twice.
let store: string | null = null
// the session `path` was located for
let sid: string | null = null
let path: string | null = null
let mtime = -1
let walletMtime = -1
let reading: Promise<void> | null = null
// quests seen turning in while the pane watched: their titles shimmer once
const fresh = new Set<number>()
// What the terminal's pane last drew that moves, by its Raster's key: its size
// and how to draw it at a time. The clock repaints these in place.
type Moving = { columns: number; rows: number; draw: (t: number) => Canvas }
let moving = new Map<string, Moving>()
let ticker: Timer | null = null
let frame = 0
let misses = 0
// the frame each pet was last seen being petted, for its hearts
const pettedAt = new Map<number, number>()
// pets that hatched while the overlay watched: the frame their card was first
// drawn, when the egg starts to crack (HATCHING until then)
const hatchedAt = new Map<number, number>()
const HATCHING = -1
// eggs hatched from the pane and not yet out of the shell, with the toast that
// says what came out: the card keeps the egg's details, and the toast waits,
// until the shell gives
const veiled = new Map<number, string>()
// pets whose Release was pressed once: their card asks before letting them go
const releasing = new Set<number>()

// quest.py's store_base(): CLAUDE_QUESTS_DIR, else <config dir>/quests
async function storeBase($: EngineInterface): Promise<string> {
  return (
    (await $.env.get('CLAUDE_QUESTS_DIR')) ??
    `${(await $.env.get('CLAUDE_CONFIG_DIR')) ?? `${await $.env.get('HOME')}/.claude`}/quests`
  )
}

// Where quest.py writes a session's log: <store>/<slug(git root)>/<sid>.json
async function locate($: EngineInterface, base: string, sid: string): Promise<string> {
  const cwd = await $.session.cwd()
  let root = cwd
  try {
    const git = await $.process.run(['git', 'rev-parse', '--show-toplevel'], { cwd, timeoutMs: 5000 })
    if (git.exitCode === 0 && git.stdout.trim()) root = git.stdout.trim()
  } catch {
    // not a git checkout, or no git: quest.py falls back to the cwd too
  }
  return `${base}/${slug(root)}/${sid}.json`
}

// The `overlay` setting as quest.py's load_config() reads it:
// CLAUDE_QUESTS_OVERLAY, else config.json, else off.
async function overlaySetting($: EngineInterface, base: string): Promise<boolean> {
  const env = (await $.env.get('CLAUDE_QUESTS_OVERLAY'))?.trim().toLowerCase()
  if (env === 'on' || env === 'off') return env === 'on'
  try {
    const stored = JSON.parse(await $.fs.read(`${base}/config.json`)) as { overlay?: unknown }
    return String(stored.overlay ?? '').trim().toLowerCase() === 'on'
  } catch {
    return false
  }
}

// Turning on (at start, or by /quests config mid-session) opens the pane where
// a sidebar fits and takes the Stop hook's line over; turning off gives it back.
async function setOn($: EngineInterface, on: boolean): Promise<void> {
  if ((await read($, isOn)) === on) return
  await update($, isOn, () => on)
  // Refused (a policy, say), the Stop hook keeps its line: shown twice, not lost.
  await $.env.set('CLAUDE_QUESTS_OVERLAY_LIVE', on ? '1' : undefined).catch(() => undefined)
  if (on) {
    void $.ui.open({ id: PANE, title: 'Quests', rows: PANE_ROWS })
  } else {
    await $.ui.close({ id: PANE })
  }
}

// quest.py, run as the session would run it: from the session's directory
// and under its id, so `engrave` finds this session's log.
async function questPy($: EngineInterface, args: string[], stdin?: string): Promise<string> {
  const id = await $.session.id()
  const ran = await $.process.run(['python3', `${$.plugin.root}/skills/quests/quest.py`, ...args], {
    cwd: await $.session.cwd(),
    env: { CLAUDE_QUESTS_SESSION_ID: id, CLAUDE_CODE_SESSION_ID: id },
    stdin,
    timeoutMs: 10000,
  })
  if (ran.exitCode !== 0) throw new Error(ran.stderr.trim() || `quest.py exited ${ran.exitCode}`)
  return ran.stdout.trim()
}

// Re-read the purse and wares when wallet.json changed (gold earned, a buy).
async function readArmory($: EngineInterface, base: string): Promise<void> {
  const stat = await $.fs.stat(`${base}/wallet.json`).catch(() => null)
  const stamp = stat ? stat.mtimeMs : 0
  if (stamp === walletMtime) return
  try {
    const next = JSON.parse(await questPy($, ['armory'])) as Armory
    // petted since the last read (from here or from /quests pet): hearts
    const known = await read($, armory)
    const before = new Map((known?.pets ?? []).map(p => [p.id, p]))
    for (const pet of next.pets ?? []) {
      const was = before.get(pet.id)
      if (was && pet.petted > was.petted) pettedAt.set(pet.id, frame)
      // out of its egg since the last read (from here or /quests hatch): it
      // hatches where it's next seen; the pets there at the first read are old friends
      if (known && !pet.egg && (!was || was.egg)) hatchedAt.set(pet.id, HATCHING)
    }
    await update($, armory, () => next)
    walletMtime = stamp
  } catch {
    // an older quest.py without `armory`, or python3 missing: the log still draws
  }
}

// Re-read the setting and, if they changed, the log and the purse; toast
// what's new in the log's queue.
function refresh($: EngineInterface): Promise<void> {
  reading ??= (async () => {
    store ??= await storeBase($)
    // /clear and an in-app /resume go on in this process under another id,
    // and no session.start fires for it: follow the id, and start its log over.
    const now = await $.session.id()
    if (now !== sid || !path) {
      path = await locate($, store, now)
      sid = now
      mtime = -1
      fresh.clear()
      await update($, log, () => null)
    }
    const on = await overlaySetting($, store)
    await setOn($, on)
    if (on) await readArmory($, store)

    const stat = await $.fs.stat(path).catch(() => null)
    if (!stat || stat.mtimeMs === mtime) return
    mtime = stat.mtimeMs
    let next: QuestLog
    try {
      next = JSON.parse(await $.fs.read(path)) as QuestLog
    } catch {
      return // caught mid-write; os.replace makes that rare, the next poll gets it
    }
    // turned in since the last read (not on the first: that's history)
    const before = await read($, log)
    if (before) {
      const done = new Set(before.quests.filter(q => q.status === 'done').map(q => q.id))
      for (const q of next.quests) if (q.status === 'done' && !done.has(q.id)) fresh.add(q.id)
    }
    await update($, log, () => next)

    // The queue only grows within a turn and the Stop hook empties it, so
    // whatever follows the part already seen is new. Seen while off counts
    // too, so turning on doesn't replay the turn so far.
    const queue = (next.toasts ?? []).map(toastText)
    const seen = await read($, shown)
    let same = 0
    while (same < seen.length && same < queue.length && seen[same] === queue[same]) same++
    if (on) for (const text of queue.slice(same)) $.ui.toast(text, { timeoutMs: 5000 })
    await update($, shown, () => queue)
  })().finally(() => {
    reading = null
  })
  return reading
}

// A press: the `/quests` command it stands for, through quest.py's own
// dispatch, so the price, the checks and the wording are the CLI's. What it
// answers is a toast.
// What quest.py said, fitted to a toast: three lines of about 40 columns, the
// rest cut. A hatching is laid out to fit, pointing at the Pets tab where the
// CLI points at commands; anything else keeps its first three lines.
const HATCHED = /^The egg cracks\.\.\. (it's an? .+?) \((\w+)\)! Meet (.+?), pet #(\d+)\./
const BOUGHT_EGG = /^Bought a mystery egg/

function toastOf(said: string): string {
  const hatched = HATCHED.exec(said)
  if (hatched) {
    const [, it, tier, name, id] = hatched
    return `The egg cracks... ${it}\n(${tier})! Meet ${name}, pet #${id}.\nRename it from its card.`
  }
  // what's inside is the hatching's to say, so the buy doesn't hint
  if (BOUGHT_EGG.test(said)) return `Bought a mystery egg 🥚\nHatch the egg in your Pets tab!\n${said.split('\n').at(-1)}`
  return said.split('\n').slice(0, 3).join('\n')
}

async function run($: EngineInterface, command: string): Promise<string> {
  try {
    return (await questPy($, ['dispatch', '--stdin'], command)) || 'Done.'
  } catch (err) {
    return `Couldn't run /quests ${command}: ${err instanceof Error ? err.message : String(err)}`
  } finally {
    walletMtime = -1
    mtime = -1
  }
}

async function press($: EngineInterface, command: string): Promise<void> {
  const said = await run($, command)
  // a toast, so the pane doesn't jump to make room for it
  $.ui.toast(toastOf(said), { timeoutMs: 8000 })
  await refresh($)
}

// Hatching an egg from its card. On a terminal, where it plays out, the
// card keeps the egg's details and the toast saying what it is waits until
// the shell gives; elsewhere the pet is just there.
async function hatchEgg($: EngineInterface, id: number, surface: string): Promise<void> {
  const watching = surface === 'terminal'
  if (watching) veiled.set(id, '')
  const said = await run($, `hatch ${id}`)
  if (!watching || !HATCHED.test(said)) {
    veiled.delete(id)
    $.ui.toast(toastOf(said), { timeoutMs: 8000 })
    await refresh($)
    return
  }
  veiled.set(id, toastOf(said))
  await refresh($)
  $.clock.after(REVEAL_SECONDS * 1000, () => void reveal($, id))
}

async function reveal($: EngineInterface, id: number): Promise<void> {
  const toast = veiled.get(id)
  veiled.delete(id)
  if (toast) $.ui.toast(toast, { timeoutMs: 8000 })
  await update($, armory, a => (a ? { ...a } : a)) // draw the card's details
}

const seconds = (at: number) => (at * FRAME_MS) / 1000

// One frame of everything that moves, repainted in place: no render pass.
// Three frames in a row with nothing taken (the pane closed, the tab
// changed, the Rasters not yet mounted) stop the clock; drawing one again
// starts it.
async function paintFrame($: EngineInterface): Promise<void> {
  if (moving.size === 0) return stopClock()
  frame += 1
  const t = seconds(frame)
  const results = await Promise.all(
    [...moving].map(([key, m]) =>
      $.ui
        .blit({ requestId: PANE, key, cells: base64(cells(m.draw(t))), columns: m.columns, rows: m.rows })
        .catch(() => ({ deny: 'failed' })),
    ),
  )
  misses = results.every(r => r.deny) ? misses + 1 : 0
  if (misses >= 3) stopClock()
}

function startClock($: EngineInterface): void {
  misses = 0
  ticker ??= $.clock.every(FRAME_MS, () => void paintFrame($))
}

function stopClock(): void {
  ticker?.cancel()
  ticker = null
  misses = 0
}

// A Raster that moves: drawn now at this frame, and handed to the clock.
function animated(els: Els, key: string, columns: number, rows: number, draw: (t: number) => Canvas) {
  const { Raster } = els
  if (!Raster) return null
  moving.set(key, { columns, rows, draw })
  return <Raster key={key} columns={columns} rows={rows} cells={base64(cells(draw(seconds(frame))))} />
}

async function show($: EngineInterface, next: View): Promise<void> {
  await update($, view, () => next)
}

// -------------------------------------------------------------- the views

// A line that may wrap: its mark in a column of its own, so a long text wraps
// under itself rather than back under the mark, and whatever stands at the
// right (a count, a button) keeps its width while the text gives way.
// A text that's not a string (a Client, say) stands as it is.
function hang(
  els: Els,
  key: string,
  mark: string,
  text: RenderChildren,
  style: TextProps = {},
  right?: RenderChildren,
  markStyle: TextProps = style,
) {
  const { Box, Text } = els
  return (
    <Box key={key} columnGap={1}>
      <Box flexShrink={0}>
        <Text {...markStyle}>{mark}</Text>
      </Box>
      <Box flexGrow={1} flexShrink={1}>
        {typeof text === 'string' ? (
          <Text {...style} wrap="wrap">
            {text}
          </Text>
        ) : (
          text
        )}
      </Box>
      {right !== undefined && <Box flexShrink={0}>{right}</Box>}
    </Box>
  )
}

// The banner, rank and purse, and how far to the next rank. Where the surface
// runs a Client the figures count up as they change.
function header(els: Els, gear: Armory | null) {
  const { Box, Text, Client } = els
  if (!gear) return null
  const { rank } = gear
  const toNext = rank.next ? `${rank.next.floor - gear.xp} to ${rank.next.name}` : 'max rank'
  const fraction = rank.next ? (gear.xp - rank.floor) / (rank.next.floor - rank.floor) : 1
  return (
    <Box flexDirection="column" marginBottom={1}>
      {gear.look.banner && <Text bold color="claude">⚔ {gear.look.banner}</Text>}
      {Client ? (
        <Client key="purse" module="./purse.tsx" props={{ rank: rank.name, gold: gear.gold, xp: gear.xp }} width="100%" />
      ) : (
        <Box justifyContent="space-between">
          <Text wrap="truncate-end">
            <Text color="claude">🏅 {rank.name}</Text> · {gear.xp} xp
          </Text>
          <Text>
            <Text color="warning">{gear.gold}</Text> 💰
          </Text>
        </Box>
      )}
      <Text dimColor wrap="truncate-end">
        {meter(fraction, gear.look.bar, 8)} {toNext}
      </Text>
      {boostsLine(els, gear)}
      {gear.tampered && (
        <Text color="warning" wrap="wrap">
          🚩 wallet.json was edited outside quest-log: the purse was put back
        </Text>
      )}
    </Box>
  )
}

// A potion's colour in the theme: red, green and yellow are error, success
// and warning in every theme.
const POTION_COLOR: Record<string, string> = { red: 'error', green: 'success', yellow: 'warning' }

// The boosts working now, each in its potion's colour with the minutes left.
// quest.py gives when each wears off, so this counts down between reads.
function boostsLine(els: Els, gear: Armory) {
  const { Box, Text } = els
  const now = Date.now() / 1000
  const working = (gear.potions ?? []).flatMap(p => {
    const kind = p.id === 'xp' ? 'xp' : p.id === 'luck' ? 'gold' : null
    const left = kind ? (gear.boosts?.[kind] ?? 0) - now : 0
    return kind && left > 0 ? [{ p, kind, minutes: Math.max(1, Math.round(left / 60)) }] : []
  })
  if (working.length === 0) return null
  return (
    <Box key="boosts" columnGap={2} flexWrap="wrap">
      {working.map(({ p, kind, minutes }) => (
        <Text key={`boost-${kind}`} color={POTION_COLOR[p.color]}>
          {p.look} {gear.boost_times ?? 5}x {kind} · {minutes}m
        </Text>
      ))}
    </Box>
  )
}

// One potion: its dot and name in its colour, what it does, and `right`.
function potionRow(els: Els, p: Potion, right: RenderChildren) {
  return hang(els, `potion-${p.id}`, p.look, `${p.name} · ${p.note}`, {}, right, { color: POTION_COLOR[p.color] })
}

function tabs($: EngineInterface, els: Els, current: View) {
  const { Box, Button } = els
  return (
    <Box columnGap={1} flexWrap="wrap" marginBottom={1}>
      {VIEWS.map(v => (
        <Button
          key={`tab-${v.view}`}
          label={v.label}
          hotkey={v.hotkey}
          variant={v.view === current ? 'primary' : 'secondary'}
          onPress={() => show($, v.view)}
        />
      ))}
    </Box>
  )
}

const MARK_COLOR = { done: 'success', failed: 'error', parked: 'inactive', open: 'inactive' } as const

// What a quest left behind: a link where it's an https URL, shown without
// its scheme; paths and shas as text. A terminal without hyperlinks prints a
// link's URL after its text, and a file:// URL is long for so little.
function loot(els: Els, q: Quest) {
  const { Box, Text, Link } = els
  if (!q.loot?.length) return null
  return (
    <Box key={`loot${q.id}`} columnGap={1} flexWrap="wrap" paddingLeft={3}>
      <Text dimColor>loot</Text>
      {q.loot.map(x =>
        /^https:\/\//.test(x) ? <Link href={x} label={x.slice('https://'.length)} /> : <Text dimColor>{x}</Text>,
      )}
    </Box>
  )
}

function logView(els: Els, state: QuestLog | null, gear: Armory | null) {
  const { Box, Text, Client } = els
  if (!state || state.quests.length === 0) {
    return <Text dimColor>No quests yet this session.</Text>
  }
  const bar = gear?.look.bar
  const trophy = gear?.look.trophy ?? '🏆'

  const tracked = state.quests.find(q => q.id === state.tracked && (q.status === 'active' || q.status === 'awaiting'))
  const waiting = state.quests.filter(q => q.status === 'awaiting' && q !== tracked)
  const active = state.quests.filter(q => q.status === 'active' && q !== tracked)
  const done = state.quests.filter(q => q.status === 'done').reverse()
  const rumors = state.rumors.filter(r => !r.quest && !r.todo)

  const row = (q: Quest, lead: string) => {
    const { done: d, total } = progress(q)
    return hang(els, `q${q.id}`, lead, `#${q.id} ${q.title}`, {}, total > 0 ? <Text dimColor>{d}/{total}</Text> : undefined)
  }

  const p = tracked ? progress(tracked) : { done: 0, total: 0 }
  const current = tracked ? tracked.objectives.findIndex(o => o.state === 'open') : -1

  return (
    <Box flexDirection="column">
      {tracked && (
        <Box flexDirection="column" marginBottom={1}>
          {hang(els, 'tracked', tracked.status === 'awaiting' ? '⏸' : '⚔', `#${tracked.id} ${tracked.title}`, { bold: true })}
          <Text color="claude">
            {meter(p.total ? p.done / p.total : 0, bar)} {p.done}/{p.total}
          </Text>
          {tracked.objectives.map((o, i) =>
            hang(
              els,
              `o${i}`,
              i === current ? '▸' : MARK[o.state],
              o.text,
              {
                dimColor: o.state === 'done' || o.state === 'parked',
                bold: i === current,
                color: o.state === 'failed' ? 'error' : undefined,
              },
              undefined,
              { color: i === current ? 'claude' : MARK_COLOR[o.state], bold: i === current },
            ),
          )}
          {tracked.awaiting && hang(els, 'waiting', '⏸', `waiting on you: ${tracked.awaiting}`, { color: 'warning' })}
        </Box>
      )}

      {waiting.length > 0 && (
        <Box flexDirection="column" marginBottom={1}>
          <Text color="warning" bold>Awaiting you</Text>
          {waiting.map(q => (
            <Box key={`w${q.id}`} flexDirection="column">
              {row(q, '⏸')}
              {q.awaiting && hang(els, `wq${q.id}`, ' ', `“${q.awaiting}”`, { dimColor: true })}
            </Box>
          ))}
        </Box>
      )}

      {active.length > 0 && (
        <Box flexDirection="column" marginBottom={1}>
          <Text bold>Active</Text>
          {active.map(q => row(q, q.kind === 'main' ? '⚔' : '·'))}
        </Box>
      )}

      {rumors.length > 0 && (
        <Box flexDirection="column" marginBottom={1}>
          <Text bold>Rumors</Text>
          {rumors.map(r => hang(els, `r${r.id}`, `r${r.id}`, r.text, { dimColor: true }))}
        </Box>
      )}

      {done.length > 0 && (
        <Box flexDirection="column">
          <Text bold>Completed</Text>
          {done.slice(0, 3).map(q => (
            <Box key={`d${q.id}`} flexDirection="column">
              {hang(
                els,
                `dt${q.id}`,
                trophy,
                Client && fresh.has(q.id) ? (
                  <Client key={`shine${q.id}`} module="./shimmer.tsx" props={{ text: `#${q.id} ${q.title}` }} />
                ) : (
                  `#${q.id} ${q.title}`
                ),
              )}
              {q.outcome && hang(els, `do${q.id}`, ' ', q.outcome, { dimColor: true })}
              {loot(els, q)}
            </Box>
          ))}
          {done.length > 3 && <Text dimColor> +{done.length - 3} more (/quests done)</Text>}
        </Box>
      )}
    </Box>
  )
}

// One ware: its look and name on the left, what can be done with it on the right.
function wareRow(els: Els, w: Ware, action: RenderChildren) {
  return hang(els, `ware-${w.id}`, w.preview, w.name, {}, action)
}

// The shop's sign: pixels on a terminal, the same as an SVG elsewhere.
function signView(els: Els, columns: number, rows: number) {
  const { Box, Svg } = els
  const width = Math.min(SCENE_MAX, columns)
  if (width < 24) return null
  const alt = 'The shop at dusk: lamplight in the windows, smoke off the chimney'
  return (
    <Box marginBottom={1} justifyContent="center">
      {animated(els, 'sign', width, rows, t => shop(width, rows * 2, t)) ??
        (Svg ? <Svg source={svg(shop(width, rows * 2, 1.5))} alt={alt} /> : null)}
    </Box>
  )
}

function sections(els: Els, wares: Ware[], row: (w: Ware) => RenderChildren) {
  const { Box, Text } = els
  const heads = [...new Set(wares.map(w => w.section))]
  return heads.map(head => (
    <Box key={`sec-${head}`} flexDirection="column" marginBottom={1}>
      <Text bold>{head}</Text>
      {wares.filter(w => w.section === head).map(row)}
    </Box>
  ))
}

// A shop tile: one thing for sale, its picture over its name and price.
// `command` is what pressing it runs; none for a look already on.
type Tile = { id: string; name: string; label: string; price: string; key: string; command?: string; tone?: 'on' | 'dim' }

// A tile is as wide as its picture, and its words have to fit under it.
const TILE_NAMES: Record<string, string> = { custom: 'Banner', egg: 'Egg', health: 'Health', xp: 'XP boost', luck: 'Lucky' }
const tileName = (id: string, name: string) => TILE_NAMES[id] ?? name.split(' ')[0] ?? name
const textCells = (text: string) => [...text].reduce((n, ch) => n + ((ch.codePointAt(0) ?? 0) >= 0x1f000 ? 2 : 1), 0)
function centered(text: string, cols: number): string {
  let t = text
  while (textCells(t) > cols) t = [...t].slice(0, -1).join('')
  const room = cols - textCells(t)
  return ' '.repeat(Math.floor(room / 2)) + t + ' '.repeat(Math.ceil(room / 2))
}

// What the shop sells, as tiles in three groups: looks (bought once, then
// equipped), the egg and food, and potions (both a portion at a time).
function shopTiles(gear: Armory): { head: string; tiles: Tile[] }[] {
  const looks = gear.wares
    .filter(w => w.price > 0)
    .map((w): Tile => {
      const base = { id: w.id, name: tileName(w.id, w.name) }
      if (w.equipped) return { ...base, label: `${w.name}, on`, price: '◆ on', key: `on-${w.id}`, tone: 'on' }
      if (w.owned) return { ...base, label: `Equip the ${w.name}`, price: 'Equip', key: `equip-${w.id}`, command: `equip ${w.id}` }
      return {
        ...base,
        label: `Buy the ${w.name} for ${w.price} gold`,
        price: `${w.price} 💰`,
        key: `buy-${w.id}`,
        command: `buy ${w.id}`,
        tone: w.price > gear.gold ? 'dim' : undefined,
      }
    })
  const stocked = (id: string, name: string, price: number, stock: number): Tile => ({
    id,
    name: tileName(id, name),
    label: `Buy ${name.toLowerCase()} for ${price} gold${stock ? `, ${stock} in your inventory` : ''}`,
    price: `${stock ? `×${stock} ` : ''}${price} 💰`,
    key: `buy-${id}`,
    command: `buy ${id}`,
    tone: price > gear.gold ? 'dim' : undefined,
  })
  const pets = [
    ...(gear.egg_price !== undefined ? [stocked('egg', 'Mystery egg', gear.egg_price, 0)] : []),
    ...(gear.food ?? []).map(f => stocked(f.id, f.name, f.price, f.stock)),
  ]
  const potions = (gear.potions ?? []).map(p => stocked(p.id, p.name, p.price, p.stock))
  return [
    { head: '⚒ LOOKS', tiles: looks },
    { head: '🥚 PETS AND FOOD', tiles: pets },
    { head: '🧪 POTIONS', tiles: potions },
  ].filter(g => g.tiles.length > 0)
}

// The picture as Text: on a terminal two pixels a cell, a half block in the
// top one's colour over the bottom one's, so a Button can hold it and the
// whole tile is the press.
function pixelText(els: Els, key: string, art: Pixels | null): RenderChildren[] {
  const { Text } = els
  if (!art) return [' '.repeat(WARE_PIXELS)]
  return halfBlocks(art).flatMap((runs, row) => [
    ...(row > 0 ? ['\n'] : []),
    ...runs.map((r, i) =>
      r.fg ? (
        <Text key={`${key}-${row}-${i}`} color={r.fg} backgroundColor={r.bg ?? undefined}>
          {r.glyph.repeat(r.n)}
        </Text>
      ) : (
        ' '.repeat(r.n)
      ),
    ),
  ])
}

function tileView($: EngineInterface, els: Els, t: Tile) {
  const { Box, Text, Button, Svg, TileButton } = els
  const priceStyle = t.tone === 'on' ? { color: 'success' as const } : { dimColor: t.tone === 'dim' }
  const border = {
    key: `tile-${t.id}`,
    flexDirection: 'column' as const,
    flexShrink: 0,
    borderStyle: 'round',
    borderColor: t.tone === 'on' ? ('success' as const) : undefined,
    borderDimColor: t.tone === 'dim',
    hover: { borderColor: 'claude' as const },
  }
  if (TileButton) {
    const words = [
      <Text key={`${t.id}-name`} bold>
        {centered(t.name, WARE_PIXELS)}
      </Text>,
      '\n',
      <Text key={`${t.id}-price`} {...priceStyle}>
        {centered(t.price, WARE_PIXELS)}
      </Text>,
    ]
    const face = [...pixelText(els, t.id, wareArt(t.id)), '\n', ...words]
    return (
      <Box {...border} width={WARE_PIXELS + 2}>
        {t.command ? (
          <TileButton key={t.key} label={t.label} plain onPress={() => press($, t.command!)}>
            {face}
          </TileButton>
        ) : (
          <Text>{face}</Text>
        )}
      </Box>
    )
  }
  const art = wareArt(t.id)
  return (
    <Box {...border} alignItems="center" paddingX={1}>
      {Svg && art && <Svg source={svg(art, 4)} alt={t.name} />}
      <Text bold>{t.name}</Text>
      {t.command ? (
        <Button key={t.key} label={t.price} dimColor={t.tone === 'dim'} onPress={() => press($, t.command!)} />
      ) : (
        <Text {...priceStyle}>{t.price}</Text>
      )}
    </Box>
  )
}

function shopView($: EngineInterface, els: Els, gear: Armory, sign: RenderChildren) {
  const { Box, Text } = els
  return (
    <Box flexDirection="column">
      {sign}
      {shopTiles(gear).map(g => (
        <Box key={`group-${g.head}`} flexDirection="column" marginBottom={1}>
          <Text bold>{g.head}</Text>
          <Box flexWrap="wrap" columnGap={1}>
            {g.tiles.map(t => tileView($, els, t))}
          </Box>
        </Box>
      ))}
      <Text dimColor wrap="wrap">
        ⚜ Plaques: engrave a finished quest from Trophies, {gear.plaque_price} 💰 each.
      </Text>
    </Box>
  )
}

// A rarity's colour: green, blue, pink, and gold (bold) for a legend. No theme
// colour is pink, so that one is the same in every theme.
const TIER_COLOR = { common: 'success', uncommon: 'suggestion', rare: '#f472b6', legendary: 'warning' } as const

const hearts = (joy: number) => {
  const n = Math.round(joy / 10)
  return '♥'.repeat(n) + '♡'.repeat(10 - n)
}

// One pet: it, moving, beside how it is and what you can do for it.
// An egg in the pen: its picture is the press that hatches it, a Hatch button
// beside it too. What's inside isn't known until then, here or in the wallet.
const STILL_EGG = { joy: 0, hungry: false, sincePetted: -1, sinceHatched: 0 }
function eggCard($: EngineInterface, els: Els, pet: Pet, surface: string) {
  const { Box, Text, Button, Svg, TileButton } = els
  const egg = petFrame('egg', 0, STILL_EGG, pet.id)
  const hatch = () => hatchEgg($, pet.id, surface)
  const picture = TileButton ? (
    <TileButton key={`hatch-${pet.id}-egg`} label={`Hatch egg #${pet.id}`} plain onPress={hatch}>
      {pixelText(els, `egg-${pet.id}`, egg)}
    </TileButton>
  ) : Svg ? (
    <Svg source={svg(egg)} alt="An unhatched egg" />
  ) : (
    <Text>{pet.emoji}</Text>
  )
  return (
    <Box key={`pet-${pet.id}`} columnGap={2} flexWrap="wrap" marginBottom={1}>
      <Box flexShrink={0}>{picture}</Box>
      {eggDetails(els, pet, <Button key={`hatch-${pet.id}`} label="Hatch" variant="primary" onPress={hatch} />)}
    </Box>
  )
}

function eggDetails(els: Els, pet: Pet, action: RenderChildren) {
  const { Box, Text } = els
  return (
    <Box flexDirection="column" flexGrow={1} flexShrink={1}>
      <Text wrap="truncate-end">
        <Text bold>Unhatched egg</Text>
        <Text dimColor>{` #${pet.id} · Mystery egg`}</Text>
      </Text>
      <Text dimColor>Something's moving inside.</Text>
      <Box>{action}</Box>
    </Box>
  )
}

function petCard($: EngineInterface, els: Els, pet: Pet, food: Food[], bar: readonly [string, string], surface: string) {
  const { Box, Text, Button, Input, Svg } = els
  if (pet.egg) return eggCard($, els, pet, surface)
  if (hatchedAt.get(pet.id) === HATCHING && surface === 'terminal') hatchedAt.set(pet.id, frame)
  const hatched = hatchedAt.get(pet.id)
  const pose = (t: number) => ({
    joy: pet.joy,
    hungry: pet.hungry,
    shiny: pet.shiny,
    sincePetted: pettedAt.has(pet.id) ? t - seconds(pettedAt.get(pet.id)!) : -1,
    sinceHatched: hatched !== undefined && hatched !== HATCHING ? t - seconds(hatched) : -1,
  })
  const sprite =
    animated(els, `sprite-${pet.id}`, PET_COLUMNS, PET_ROWS, t => petFrame(pet.species, t, pose(t), pet.id)) ??
    (Svg && surface !== 'terminal' ? (
      <Svg source={svg(petFrame(pet.species, 1, pose(1), pet.id))} alt={`${pet.name} the ${pet.shiny ? 'shiny ' : ''}${pet.kind.toLowerCase()}`} />
    ) : (
      <Text>{pet.emoji}</Text>
    ))
  const stocked = food.filter(f => f.stock > 0)
  if (veiled.has(pet.id)) {
    // coming out of the shell: what it is shows when it does
    return (
      <Box key={`pet-${pet.id}`} columnGap={2} flexWrap="wrap" marginBottom={1}>
        <Box flexShrink={0}>{sprite}</Box>
        {eggDetails(els, pet, <Text color="claude">It's hatching!</Text>)}
      </Box>
    )
  }
  return (
    <Box key={`pet-${pet.id}`} columnGap={2} flexWrap="wrap" marginBottom={1}>
      <Box flexShrink={0}>{sprite}</Box>
      <Box flexDirection="column" flexGrow={1} flexShrink={1}>
        <Text wrap="truncate-end">
          <Text bold>{pet.name}</Text>
          <Text dimColor>{` #${pet.id} · `}</Text>
          {pet.shiny ? <Text color="warning">✨ shiny </Text> : null}
          <Text dimColor>{`${pet.kind} · `}</Text>
          <Text color={TIER_COLOR[pet.rarity]} bold={pet.rarity === 'legendary'}>
            {pet.rarity}
          </Text>
        </Text>
        <Text>
          <Text color="error">{hearts(pet.joy)}</Text>
          {` ${pet.mood}`}
        </Text>
        <Text>
          <Text color={pet.hungry ? 'warning' : 'claude'}>{meter(pet.full / 100, bar)}</Text>
          {pet.hungry ? ' hungry!' : ` ${Math.round(pet.full)}% full`}
        </Text>
        <Text dimColor>likes {food.find(f => f.id === pet.likes)?.emoji ?? ''} {pet.likes}</Text>
        <Box columnGap={1} flexWrap="wrap">
          <Button key={`pet-${pet.id}-pet`} label="Pet" onPress={() => press($, `pet ${pet.id}`)} />
          {stocked.map(f => (
            <Button
              key={`pet-${pet.id}-feed-${f.id}`}
              label={`Feed ${f.emoji} ×${f.stock}`}
              variant={f.id === pet.likes ? 'primary' : 'secondary'}
              onPress={() => press($, `feed ${pet.id} ${f.id}`)}
            />
          ))}
          {stocked.length === 0 && <Text dimColor>no food: the Shop sells it</Text>}
        </Box>
        {Input && (
          <Input
            key={`pet-${pet.id}-name`}
            label="Name"
            placeholder={pet.name}
            submitLabel="Rename"
            onSubmit={value => {
              if (value.trim()) void press($, `name ${pet.id} ${value.trim()}`)
            }}
          />
        )}
        {releaseRow($, els, pet)}
      </Box>
    </Box>
  )
}

// Release takes two presses: the first asks, since a pet let go is gone.
function releaseRow($: EngineInterface, els: Els, pet: Pet) {
  const { Box, Text, Button } = els
  const redraw = () => update($, armory, a => (a ? { ...a } : a))
  if (!releasing.has(pet.id)) {
    const ask = () => {
      releasing.add(pet.id)
      void redraw()
    }
    return (
      <Box>
        <Button key={`pet-${pet.id}-release`} label="Release" onPress={ask} />
      </Box>
    )
  }
  const keep = () => {
    releasing.delete(pet.id)
    void redraw()
  }
  const release = () => {
    releasing.delete(pet.id)
    pettedAt.delete(pet.id)
    hatchedAt.delete(pet.id)
    void press($, `release ${pet.id}`)
  }
  return (
    <Box columnGap={1} flexWrap="wrap">
      <Text color="warning">{`Let ${pet.name} go for good?`}</Text>
      <Button key={`pet-${pet.id}-release-yes`} label="Release" variant="primary" onPress={release} />
      <Button key={`pet-${pet.id}-release-keep`} label="Keep" onPress={keep} />
    </Box>
  )
}

function petsView($: EngineInterface, els: Els, gear: Armory, surface: string) {
  const { Box, Text, Button } = els
  const pets = gear.pets ?? []
  const food = gear.food ?? []
  const health = gear.potions?.find(p => p.id === 'health')
  if (pets.length === 0) {
    return (
      <Box flexDirection="column">
        <Text wrap="wrap">The pen is empty. A mystery egg hatches one of ten pets, a dragon if you're lucky.</Text>
        {gear.egg_price !== undefined && (
          <Box marginTop={1}>
            <Button
              key="buy-egg"
              label={`Buy an egg ${gear.egg_price} 💰`}
              dimColor={gear.egg_price > gear.gold}
              onPress={() => press($, 'buy egg')}
            />
          </Box>
        )}
      </Box>
    )
  }
  return (
    <Box flexDirection="column">
      <Text dimColor wrap="wrap">
        {`food in inventory ${food.map(f => `${f.emoji} ${f.stock}`).join('  ')}`}
      </Text>
      {health && health.stock > 0 && (
        <Box marginTop={1}>
          <Button
            key="drink-health"
            label={`Drink ${health.look} ×${health.stock}: heal every pet`}
            onPress={() => press($, 'drink health')}
          />
        </Box>
      )}
      <Box marginBottom={1} />
      {/* newest first, so one hatching is on top, not below the fold */}
      {[...pets].sort((a, b) => b.id - a.id).map(pet => petCard($, els, pet, food, gear.look.bar, surface))}
    </Box>
  )
}

function inventoryView($: EngineInterface, els: Els, gear: Armory) {
  const { Box, Text, Button, Input } = els
  const owned = gear.wares.filter(w => w.owned)
  const custom = gear.wares.find(w => w.id === 'custom' && w.owned)
  return (
    <Box flexDirection="column">
      {sections(els, owned, w =>
        wareRow(
          els,
          w,
          w.equipped && w.price === 0 ? (
            <Text color="success">◆ equipped</Text>
          ) : w.equipped ? (
            <Button key={`unequip-${w.id}`} label="◆ Unequip" onPress={() => press($, `unequip ${w.id}`)} />
          ) : (
            <Button key={`equip-${w.id}`} label="Equip" onPress={() => press($, `equip ${w.id}`)} />
          ),
        ),
      )}
      {custom && Input && (
        <Box marginBottom={1}>
          <Input
            key="banner-text"
            label="Banner words"
            placeholder="your own words"
            submitLabel="Set"
            onSubmit={value => {
              if (value.trim()) void press($, `banner ${value.trim()}`)
            }}
          />
        </Box>
      )}
      {gear.plaques.length > 0 && (
        <Box flexDirection="column">
          <Text bold>⚜ PLAQUES ({gear.plaques.length})</Text>
          {gear.plaques.map(p =>
            hang(
              els,
              `plaque-${p.id}`,
              `p${p.id}`,
              p.title,
              { dimColor: !p.shown },
              <Button
                key={`${p.shown ? 'store' : 'display'}-p${p.id}`}
                label={p.shown ? 'Store' : 'Display'}
                onPress={() => press($, `${p.shown ? 'unequip' : 'equip'} p${p.id}`)}
              />,
            ),
          )}
        </Box>
      )}
      {(gear.food ?? []).some(f => f.stock > 0) && (
        <Box flexDirection="column" marginBottom={1}>
          <Text bold>🍖 FOOD</Text>
          {(gear.food ?? [])
            .filter(f => f.stock > 0)
            .map(f => hang(els, `food-${f.id}`, f.emoji, f.name, {}, <Text dimColor>×{f.stock} · feed from Pets</Text>))}
        </Box>
      )}
      {(gear.potions ?? []).some(p => p.stock > 0) && (
        <Box flexDirection="column" marginBottom={1}>
          <Text bold>🧪 POTIONS</Text>
          {(gear.potions ?? [])
            .filter(p => p.stock > 0)
            .map(p =>
              potionRow(
                els,
                p,
                <Box columnGap={1}>
                  <Text dimColor>×{p.stock}</Text>
                  <Button key={`drink-${p.id}`} label="Drink" onPress={() => press($, `drink ${p.id}`)} />
                </Box>,
              ),
            )}
        </Box>
      )}
      {owned.length === 0 && <Text dimColor>Only the clothes on your back. The Shop has wares.</Text>}
    </Box>
  )
}

function plaqueCard(els: Els, p: Plaque) {
  const { Box, Text } = els
  return (
    <Box key={`card-${p.id}`} flexDirection="column" borderStyle="round" paddingX={1}>
      <Text bold wrap="wrap">
        ✦ {p.title}
      </Text>
      <Text dimColor wrap="truncate-end">
        {[p.project, p.date, `p${p.id}`].filter(Boolean).join(' · ')}
      </Text>
      {p.outcome && <Text wrap="wrap">{p.outcome}</Text>}
    </Box>
  )
}

// The ladder: where you stand (the header above has how far to the next),
// then a tile per rank, lowest first, each its emblem over its name and where
// it starts. Reached ones in colour, yours outlined in the accent, the rest
// greyed.
function ranksView(els: Els, gear: Armory) {
  const { Box, Text, Svg, Raster } = els
  const ladder = gear.ranks ?? []
  const at = ladder.findIndex(r => r.name === gear.rank.name)
  const next = gear.rank.next
  return (
    <Box flexDirection="column">
      <Text wrap="wrap">
        <Text bold color="claude">
          🏅 {gear.rank.name}
        </Text>
        <Text dimColor>
          {at >= 0 ? ` · rank ${at + 1} of ${ladder.length}` : ''}
          {next ? '' : ' · the top of the ladder'}
        </Text>
      </Text>
      <Box flexWrap="wrap" columnGap={1} marginTop={1}>
        {ladder.map((r, i) => {
          const state = i === at ? 'current' : gear.xp >= r.floor ? 'reached' : 'locked'
          const art = emblem(r.name, state === 'locked')
          const [first, ...rest] = r.name.length > EMBLEM_PIXELS ? r.name.split(' ') : [r.name]
          const words = [first ?? '', rest.join(' ')]
          const foot = state === 'locked' ? `${r.floor - gear.xp} to go` : `${r.floor} xp`
          const tone =
            state === 'current' ? { color: 'claude' as const, bold: true } : state === 'reached' ? {} : { dimColor: true }
          const lines = [
            ...words.map((w, j) => (
              <Text key={`rank-${i}-w${j}`} {...tone}>
                {centered(w, EMBLEM_PIXELS)}
              </Text>
            )),
            <Text key={`rank-${i}-foot`} color={state === 'reached' ? 'success' : undefined} dimColor={state !== 'current'}>
              {centered(state === 'reached' ? `✔ ${foot}` : state === 'current' ? `◆ ${foot}` : foot, EMBLEM_PIXELS)}
            </Text>,
          ]
          const border = {
            key: `rank-${i}`,
            flexDirection: 'column' as const,
            flexShrink: 0,
            borderStyle: 'round',
            borderColor: state === 'current' ? ('claude' as const) : undefined,
            borderDimColor: state === 'locked',
          }
          if (Raster) {
            // a terminal: the emblem as Text, in the same cells as a shop tile
            return (
              <Box {...border} width={EMBLEM_PIXELS + 2}>
                <Text>{[...pixelText(els, `emblem-${i}`, art), ...lines.flatMap(l => ['\n', l])]}</Text>
              </Box>
            )
          }
          return (
            <Box {...border} alignItems="center" paddingX={1}>
              {Svg && art && <Svg source={svg(art, 4)} alt={`${r.name} emblem`} />}
              {lines}
            </Box>
          )
        })}
      </Box>
    </Box>
  )
}

function trophiesView($: EngineInterface, els: Els, gear: Armory, state: QuestLog | null, sid: string) {
  const { Box, Text, Button } = els
  const onWall = gear.plaques.filter(p => p.shown)
  const stored = gear.plaques.length - onWall.length
  const hung = new Set(gear.plaques.filter(p => p.session === sid).map(p => p.quest))
  const ready = (state?.quests ?? []).filter(q => q.status === 'done' && !hung.has(q.id))
  return (
    <Box flexDirection="column">
      {ready.length > 0 && (
        <Box flexDirection="column" marginBottom={1}>
          <Text bold>Ready to engrave</Text>
          {ready.map(q =>
            hang(
              els,
              `ready-${q.id}`,
              gear.look.trophy,
              `#${q.id} ${q.title}`,
              {},
              <Button
                key={`engrave-${q.id}`}
                label={`Engrave ${gear.plaque_price} 💰`}
                dimColor={gear.plaque_price > gear.gold}
                onPress={() => press($, `engrave ${q.id}`)}
              />,
            ),
          )}
        </Box>
      )}
      <Text bold>
        {gear.look.trophy} Hall of trophies · {onWall.length} on display
      </Text>
      {onWall.map(p => plaqueCard(els, p))}
      {gear.plaques.length === 0 && <Text dimColor>The walls are bare. Turn in a quest, then engrave it.</Text>}
      {stored > 0 && <Text dimColor>+ {stored} in storage (Inventory)</Text>}
    </Box>
  )
}

// ---------------------------------------------------------------- the hooks

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'quest-pane',
      description: 'Open or close the live quest log pane, or open it on a page: log, shop, inventory, trophies, pets, ranks',
      argumentHint: '[log | shop | inventory | trophies | pets | ranks]',
    })
    await refresh($)
    $.clock.every(POLL_MS, () => void refresh($))

    return next(e)
  })

  on('session.end', async ($, e, next) => {
    await $.env.set('CLAUDE_QUESTS_OVERLAY_LIVE', undefined).catch(() => undefined)

    return next(e)
  })

  on('command.run', { command: 'quest-pane' }, async ($, e) => {
    await refresh($)
    if (!(await read($, isOn))) {
      return { text: 'The overlay is off. Turn it on with: /quests config overlay on' }
    }
    const page = viewOf(e.args)
    const open = (await $.ui.panes()).some(p => p.id === PANE && p.isPlaced)
    if (page) {
      await show($, page)
      await $.ui.open({ id: PANE, title: 'Quests', rows: PANE_ROWS })
      return { text: `Quest pane: ${page}.` }
    }
    if (open) {
      await $.ui.close({ id: PANE })
      return { text: 'Quest pane closed.' }
    }
    await $.ui.open({ id: PANE, title: 'Quests', rows: PANE_ROWS })

    return { text: 'Quest pane opened.' }
  })

  // Every `quest` call is a Bash call: read right after it, so its toast
  // shows as it lands, ahead of the poll and of the Stop hook emptying the queue.
  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    const ran = await next(e)
    await refresh($)

    return ran
  }).catch(($, e, next) => next(e)) // a failed read never touches the call

  on('turn.complete', async ($, e, next) => {
    await refresh($)

    return next(e)
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const els = elementsFor($.ui.resolve(e), e.surface)
    const { Box } = els
    const state = await read($, log)
    const gear = await read($, armory)
    const page: View = gear ? await read($, view) : 'log'

    // What moves is what this drawing holds; the clock runs while there's any.
    const rows = e.props.placement === 'dock' ? 12 : 7
    const width = Math.min(SCENE_MAX, Math.max(20, e.props.bodyColumns))
    if (e.surface === 'terminal') moving = new Map()

    let body
    if (page === 'shop' && gear) body = shopView($, els, gear, signView(els, width, rows))
    else if (page === 'pets' && gear) body = petsView($, els, gear, e.surface)
    else if (page === 'inventory' && gear) body = inventoryView($, els, gear)
    else if (page === 'trophies' && gear) body = trophiesView($, els, gear, state, await $.session.id())
    else if (page === 'ranks' && gear) body = ranksView(els, gear)
    else body = logView(els, state, gear)
    if (e.surface === 'terminal' && moving.size > 0) startClock($)

    return (
      <Box flexDirection="column" width={Math.max(20, e.props.bodyColumns)}>
        {gear && tabs($, els, page)}
        {header(els, gear)}
        {body}
      </Box>
    )
  })

  // A question only the person can answer shouldn't wait in a pane they
  // may not be looking at: it sits above the prompt until it's answered.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const state = await read($, log)
    const waiting = state?.quests.filter(q => q.status === 'awaiting') ?? []
    const first = waiting[0]
    if (e.props.hasSurvey || !first || !(await read($, isOn))) {
      return next(e)
    }

    const els = elementsFor($.ui.resolve(e), e.surface)
    const { Box, Text } = els

    // The question whole: it's the one thing here only the person can answer.
    return (
      <Box flexDirection="column" width={e.props.bodyColumns}>
        {hang(els, 'waiting', '⏸', `#${first.id} ${first.title}${first.awaiting ? `: ${first.awaiting}` : ''}`, {
          color: 'warning',
        })}
        {waiting.length > 1 && <Text dimColor>  and {waiting.length - 1} more awaiting you (/quest-pane)</Text>}
      </Box>
    )
  })
}
