// The overlay's contract (hooks/overlay.tsx): the slice of quest-log's
// session store (quest.py `load`) it draws, and the values it keeps in $.state.
export type Objective = { text: string; state: 'open' | 'done' | 'failed' | 'parked' }
export type Quest = {
  id: number
  kind: 'main' | 'side'
  status: 'active' | 'awaiting' | 'done' | 'abandoned' | 'parked'
  title: string
  reward?: string | null
  objectives: Objective[]
  awaiting?: string | null
  outcome?: string | null
}
export type Rumor = { id: number; text: string; quest?: number; todo?: unknown }
export type Toast = { text: string } | string
export type QuestLog = {
  project: string
  tracked: number | null
  quests: Quest[]
  rumors: Rumor[]
  toasts?: Toast[]
}

// quest.py `armory`: the purse, the wares and the hall, for the shop,
// inventory and trophies views.
export type Ware = {
  id: string
  slot: 'frame' | 'bar' | 'trophy' | 'banner'
  section: string
  name: string
  price: number
  preview: string
  owned: boolean
  equipped: boolean
}
export type Plaque = {
  id: number
  title: string
  outcome: string | null
  project: string | null
  date: string | null
  session: string | null
  quest: number | null
  shown: boolean
}
export type Armory = {
  gold: number
  xp: number
  rank: { name: string; floor: number; next: { name: string; floor: number } | null }
  look: { bar: [string, string]; trophy: string; banner: string | null }
  wares: Ware[]
  plaque_price: number
  plaques: Plaque[]
}
export type View = 'log' | 'shop' | 'inventory' | 'trophies'

declare module 'claude-code' {
  interface PluginState {
    'quest-log': {
      // the session's log as last read; null until quest-log writes one
      log: QuestLog | null
      // the store's queued toasts already seen, to toast only what's new
      shown: string[]
      // the `overlay` setting, as last read
      isOn: boolean
      // the purse and wares as last read; null until quest.py answers
      armory: Armory | null
      // which page the pane shows
      view: View
      // what quest.py said to the last press (Bought..., Not enough gold...)
      notice: string | null
    }
  }
}
