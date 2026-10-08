import { atom, read, update } from 'claude-code'
import type { Elements, EngineInterface, Register, RenderChildren, RenderSurface, TextProps, Timer } from 'claude-code'

import type { Armory, Food, Pet, Plaque, Quest, QuestLog, Toast, View, Ware } from '../types'
import { PET_COLUMNS, PET_ROWS, petFrame } from './pets'
import { base64, cells, shop, svg } from './scene'
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
]

const log = atom({ plugin: 'quest-log', key: 'log' } as const, null)
const shown = atom({ plugin: 'quest-log', key: 'shown' } as const, [])
const isOn = atom({ plugin: 'quest-log', key: 'isOn' } as const, false)
const armory = atom({ plugin: 'quest-log', key: 'armory' } as const, null)
const view = atom({ plugin: 'quest-log', key: 'view' } as const, 'log')
const shopOpen = atom({ plugin: 'quest-log', key: 'shopOpen' } as const, [])

// The elements the views draw with: every surface has the first four, the
// rest only some (no Input on mobile, Raster on the terminal alone, Svg on
// every surface but the terminal, Client on the terminal and desktop).
type Els = Pick<Elements['desktop'], 'Box' | 'Text' | 'Button' | 'Link'> &
  Partial<Pick<Elements['desktop'], 'Input' | 'Svg' | 'Client'> & Pick<Elements['terminal'], 'Raster'>>

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

// quest.py's store_base(): CLAUDE_QUESTS_DIR, else <config dir>/quests
async function storeBase($: EngineInterface): Promise<string> {
  return (
    (await $.env.get('CLAUDE_QUESTS_DIR')) ??
    `${(await $.env.get('CLAUDE_CONFIG_DIR')) ?? `${await $.env.get('HOME')}/.claude`}/quests`
  )
}

// Where quest.py writes this session's log: <store>/<slug(git root)>/<sid>.json
async function locate($: EngineInterface, base: string): Promise<string> {
  const cwd = await $.session.cwd()
  let root = cwd
  try {
    const git = await $.process.run(['git', 'rev-parse', '--show-toplevel'], { cwd, timeoutMs: 5000 })
    if (git.exitCode === 0 && git.stdout.trim()) root = git.stdout.trim()
  } catch {
    // not a git checkout, or no git: quest.py falls back to the cwd too
  }
  return `${base}/${slug(root)}/${await $.session.id()}.json`
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
  const ran = await $.process.run(['python3', `${$.plugin.root}/skills/quests/quest.py`, ...args], {
    cwd: await $.session.cwd(),
    env: { CLAUDE_CODE_SESSION_ID: await $.session.id() },
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
    const before = new Map(((await read($, armory))?.pets ?? []).map(p => [p.id, p.petted]))
    for (const pet of next.pets ?? []) {
      const was = before.get(pet.id)
      if (was !== undefined && pet.petted > was) pettedAt.set(pet.id, frame)
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
    path ??= await locate($, store)
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

function toastOf(said: string): string {
  const hatched = HATCHED.exec(said)
  if (hatched) {
    const [, it, tier, name, id] = hatched
    return `The egg cracks... ${it}\n(${tier})! Meet ${name}, pet #${id}.\nFind it in the Pets tab!`
  }
  return said.split('\n').slice(0, 3).join('\n')
}

async function press($: EngineInterface, command: string): Promise<void> {
  let said: string
  try {
    said = (await questPy($, ['dispatch', '--stdin'], command)) || 'Done.'
  } catch (err) {
    said = `Couldn't run /quests ${command}: ${err instanceof Error ? err.message : String(err)}`
  }
  // a toast, so the pane doesn't jump to make room for it
  $.ui.toast(toastOf(said), { timeoutMs: 8000 })
  walletMtime = -1
  mtime = -1
  await refresh($)
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

// Open a shop shelf, or close it: every shelf starts closed.
async function toggleShelf($: EngineInterface, id: string): Promise<void> {
  await update($, shopOpen, open => (open.includes(id) ? open.filter(s => s !== id) : [...open, id]))
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
    </Box>
  )
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

// A shelf of the shop: a header to press, and its wares, indented under it,
// only while it's open.
// Closed, the header says how many of its wares are still for sale.
function shelf($: EngineInterface, els: Els, id: string, head: string, isOpen: boolean, summary: string, body: () => RenderChildren) {
  const { Box, Button } = els
  return (
    <Box key={`shelf-${id}`} flexDirection="column" marginBottom={isOpen ? 1 : 0}>
      <Box>
        <Button
          key={`shelf-${id}`}
          label={`${isOpen ? '▾' : '▸'} ${head}${summary ? ` · ${summary}` : ''}`}
          variant={isOpen ? 'primary' : 'secondary'}
          onPress={() => toggleShelf($, id)}
        />
      </Box>
      {isOpen && (
        <Box flexDirection="column" paddingLeft={4}>
          {body()}
        </Box>
      )}
    </Box>
  )
}

function shopView($: EngineInterface, els: Els, gear: Armory, sign: RenderChildren, opened: readonly string[]) {
  const { Box, Text, Button } = els
  const wares = gear.wares.filter(w => w.price > 0)
  const action = (w: Ware) =>
    w.equipped ? (
      <Text color="success">◆ equipped</Text>
    ) : w.owned ? (
      <Button key={`equip-${w.id}`} label="Equip" onPress={() => press($, `equip ${w.id}`)} />
    ) : (
      <Button
        key={`buy-${w.id}`}
        label={`Buy ${w.price} 💰`}
        dimColor={w.price > gear.gold}
        onPress={() => press($, `buy ${w.id}`)}
      />
    )
  const slots = [...new Set(wares.map(w => w.slot))]
  const food = gear.food ?? []
  return (
    <Box flexDirection="column">
      {sign}
      {slots.map(slot => {
        const shelfWares = wares.filter(w => w.slot === slot)
        const forSale = shelfWares.filter(w => !w.owned).length
        const summary = forSale ? `${forSale} for sale` : 'all owned'
        return shelf($, els, slot, shelfWares[0]!.section, opened.includes(slot), summary, () =>
          shelfWares.map(w => wareRow(els, w, action(w))),
        )
      })}
      {gear.egg_price !== undefined &&
        shelf($, els, 'pets', '🥚 PETS', opened.includes('pets'), `mystery egg ${gear.egg_price} 💰`, () =>
          hang(
            els,
            'ware-egg',
            '🥚',
            'Mystery egg · hatches one of ten pets',
            {},
            <Button
              key="buy-egg"
              label={`Buy ${gear.egg_price} 💰`}
              dimColor={gear.egg_price! > gear.gold}
              onPress={() => press($, 'buy egg')}
            />,
          ),
        )}
      {food.length > 0 &&
        shelf(
          $,
          els,
          'food',
          '🍖 FOOD',
          opened.includes('food'),
          `in inventory ${food.map(f => `${f.emoji}${f.stock}`).join(' ')}`,
          () =>
            food.map(f =>
              hang(
                els,
                `ware-${f.id}`,
                f.emoji,
                `${f.name} · +${f.full} full, +${f.joy} joy`,
                {},
                <Box columnGap={1}>
                  {f.stock > 0 && <Text dimColor>×{f.stock}</Text>}
                  <Button
                    key={`buy-${f.id}`}
                    label={`Buy ${f.price} 💰`}
                    dimColor={f.price > gear.gold}
                    onPress={() => press($, `buy ${f.id}`)}
                  />
                </Box>,
              ),
            ),
        )}
      <Box marginTop={1}>
        <Text dimColor wrap="wrap">
          ⚜ Plaques: engrave a finished quest from Trophies, {gear.plaque_price} 💰 each.
        </Text>
      </Box>
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
function petCard($: EngineInterface, els: Els, pet: Pet, food: Food[], bar: readonly [string, string], surface: string) {
  const { Box, Text, Button, Input, Svg } = els
  const pose = (t: number) => ({
    joy: pet.joy,
    hungry: pet.hungry,
    sincePetted: pettedAt.has(pet.id) ? t - seconds(pettedAt.get(pet.id)!) : -1,
  })
  const sprite =
    animated(els, `sprite-${pet.id}`, PET_COLUMNS, PET_ROWS, t => petFrame(pet.species, t, pose(t), pet.id)) ??
    (Svg && surface !== 'terminal' ? (
      <Svg source={svg(petFrame(pet.species, 1, pose(1), pet.id))} alt={`${pet.name} the ${pet.kind.toLowerCase()}`} />
    ) : (
      <Text>{pet.emoji}</Text>
    ))
  const stocked = food.filter(f => f.stock > 0)
  return (
    <Box key={`pet-${pet.id}`} columnGap={2} flexWrap="wrap" marginBottom={1}>
      <Box flexShrink={0}>{sprite}</Box>
      <Box flexDirection="column" flexGrow={1} flexShrink={1}>
        <Text wrap="truncate-end">
          <Text bold>{pet.name}</Text>
          <Text dimColor>{` #${pet.id} · ${pet.kind} · `}</Text>
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
      </Box>
    </Box>
  )
}

function petsView($: EngineInterface, els: Els, gear: Armory, surface: string) {
  const { Box, Text, Button } = els
  const pets = gear.pets ?? []
  const food = gear.food ?? []
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
      <Box marginBottom={1} />
      {pets.map(pet => petCard($, els, pet, food, gear.look.bar, surface))}
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
      description: 'Open or close the live quest log pane, or open it on a page: log, shop, inventory, trophies',
      argumentHint: '[log | shop | inventory | trophies]',
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
    if (page === 'shop' && gear) body = shopView($, els, gear, signView(els, width, rows), await read($, shopOpen))
    else if (page === 'pets' && gear) body = petsView($, els, gear, e.surface)
    else if (page === 'inventory' && gear) body = inventoryView($, els, gear)
    else if (page === 'trophies' && gear) body = trophiesView($, els, gear, state, await $.session.id())
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
