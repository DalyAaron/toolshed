import { atom, read, update } from 'claude-code'
import type { Elements, EngineInterface, Register, RenderChildren, TextProps } from 'claude-code'

import type { Armory, Plaque, Quest, QuestLog, Toast, View, Ware } from '../types'

// The overlay: quest-log drawn inside Claude Code. quest.py stays the only
// writer of the log and the purse; this reads the session's JSON and
// `quest.py armory`, and draws them: a pane with the log, the shop, the
// inventory and the hall, a toast per change as it lands, and a band while
// a quest waits on the person. Its Buy / Equip / Engrave buttons run the
// same `/quests` commands the person would type, through `quest.py dispatch`.
// Off unless the `overlay` setting is on. While it's on it sets
// CLAUDE_QUESTS_OVERLAY_LIVE, which tells the Stop hook to leave out its
// end-of-turn line. See DESIGN.md, "The overlay".

const PANE = 'quests'
const POLL_MS = 750
// Inline (above the prompt) a pane opens a third of the screen tall unless it
// asks; the log and the shop want more. The layout caps it, and a size the
// person drags wins.
const PANE_ROWS = 40
const VIEWS: readonly { view: View; label: string; hotkey: string }[] = [
  { view: 'log', label: 'Log', hotkey: 'l' },
  { view: 'shop', label: 'Shop', hotkey: 's' },
  { view: 'inventory', label: 'Inventory', hotkey: 'i' },
  { view: 'trophies', label: 'Trophies', hotkey: 't' },
]

const log = atom({ plugin: 'quest-log', key: 'log' } as const, null)
const shown = atom({ plugin: 'quest-log', key: 'shown' } as const, [])
const isOn = atom({ plugin: 'quest-log', key: 'isOn' } as const, false)
const armory = atom({ plugin: 'quest-log', key: 'armory' } as const, null)
const view = atom({ plugin: 'quest-log', key: 'view' } as const, 'log')
const notice = atom({ plugin: 'quest-log', key: 'notice' } as const, null)

// The elements the views draw with; mobile has no Input, so it's optional.
type Els = Pick<Elements['desktop'], 'Box' | 'Text' | 'Button'> & Partial<Pick<Elements['desktop'], 'Input'>>

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
// answers shows at the top of the pane.
async function press($: EngineInterface, command: string): Promise<void> {
  let said: string
  try {
    said = (await questPy($, ['dispatch', '--stdin'], command)) || 'Done.'
  } catch (err) {
    said = `Couldn't run /quests ${command}: ${err instanceof Error ? err.message : String(err)}`
  }
  await update($, notice, () => said)
  walletMtime = -1
  mtime = -1
  await refresh($)
}

async function show($: EngineInterface, next: View): Promise<void> {
  await update($, view, () => next)
  await update($, notice, () => null)
}

// -------------------------------------------------------------- the views

// A line that may wrap: its mark in a column of its own, so a long text wraps
// under itself rather than back under the mark, and whatever stands at the
// right (a count, a button) keeps its width while the text gives way.
function hang(els: Els, key: string, mark: string, text: RenderChildren, style: TextProps = {}, right?: RenderChildren) {
  const { Box, Text } = els
  return (
    <Box key={key} columnGap={1}>
      <Box flexShrink={0}>
        <Text {...style}>{mark}</Text>
      </Box>
      <Box flexGrow={1} flexShrink={1}>
        <Text {...style} wrap="wrap">
          {text}
        </Text>
      </Box>
      {right !== undefined && <Box flexShrink={0}>{right}</Box>}
    </Box>
  )
}

function header(els: Els, gear: Armory | null) {
  const { Box, Text } = els
  if (!gear) return null
  const { rank } = gear
  const toNext = rank.next ? `${rank.next.floor - gear.xp} to ${rank.next.name}` : 'max rank'
  const fraction = rank.next ? (gear.xp - rank.floor) / (rank.next.floor - rank.floor) : 1
  return (
    <Box flexDirection="column" marginBottom={1}>
      {gear.look.banner && <Text bold color="claude">⚔ {gear.look.banner}</Text>}
      <Box justifyContent="space-between">
        <Text wrap="truncate-end">
          🏅 {rank.name} · {gear.xp} xp
        </Text>
        <Text>{gear.gold} 💰</Text>
      </Box>
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

function logView(els: Els, state: QuestLog | null, gear: Armory | null) {
  const { Box, Text } = els
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
            hang(els, `o${i}`, i === current ? '▸' : MARK[o.state], o.text, {
              dimColor: o.state === 'done' || o.state === 'parked',
              bold: i === current,
              color: o.state === 'failed' ? 'error' : undefined,
            }),
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
              {hang(els, `dt${q.id}`, trophy, `#${q.id} ${q.title}`)}
              {q.outcome && hang(els, `do${q.id}`, ' ', q.outcome, { dimColor: true })}
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

function shopView($: EngineInterface, els: Els, gear: Armory) {
  const { Box, Text, Button } = els
  const wares = gear.wares.filter(w => w.price > 0)
  return (
    <Box flexDirection="column">
      {sections(els, wares, w =>
        wareRow(
          els,
          w,
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
          ),
        ),
      )}
      <Text dimColor wrap="wrap">
        ⚜ Plaques: engrave a finished quest from Trophies, {gear.plaque_price} 💰 each.
      </Text>
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
    const els: Els = $.ui.resolve(e)
    const { Box, Text } = els
    const state = await read($, log)
    const gear = await read($, armory)
    const said = await read($, notice)
    const page: View = gear ? await read($, view) : 'log'

    let body
    if (page === 'shop' && gear) body = shopView($, els, gear)
    else if (page === 'inventory' && gear) body = inventoryView($, els, gear)
    else if (page === 'trophies' && gear) body = trophiesView($, els, gear, state, await $.session.id())
    else body = logView(els, state, gear)

    return (
      <Box flexDirection="column" width={Math.max(20, e.props.bodyColumns)}>
        {gear && tabs($, els, page)}
        {header(els, gear)}
        {said && (
          <Box marginBottom={1}>
            <Text color="suggestion" wrap="wrap">
              {said}
            </Text>
          </Box>
        )}
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

    const els: Els = $.ui.resolve(e)
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
