import type { ClientModule } from 'claude-code'

// The pane's purse line, drawn on the surface itself (a `Client`): when gold
// or XP change it counts up to the new figure and flashes what was gained,
// frame by frame, with no round trip to the hooks module.

type Props = { rank: string; gold: number; xp: number }
type Figures = { gold: number; xp: number }
type State = { from: Figures; to: Figures; step: number; gained: Figures; glow: number }

const FRAME_MS = 50
const STEPS = 16 // the count, about 0.8s
const GLOW = 50 // how long "+N" stays, about 2.5s

const ease = (u: number) => 1 - (1 - u) ** 3

function shown(s: State): Figures {
  const u = ease(Math.min(1, s.step / STEPS))
  return {
    gold: Math.round(s.from.gold + (s.to.gold - s.from.gold) * u),
    xp: Math.round(s.from.xp + (s.to.xp - s.from.xp) * u),
  }
}

const Purse: ClientModule<Props, State> = (props, surface) => {
  const { Box, Text } = surface.elements
  const now = { gold: props.gold, xp: props.xp }
  let s = surface.state
  if (!s) {
    // first draw: the figures as they stand, no count from zero
    s = { from: now, to: now, step: STEPS, gained: { gold: 0, xp: 0 }, glow: 0 }
    surface.setState(s)
    surface.every(FRAME_MS, () => {
      const at = surface.state
      if (at && (at.step < STEPS || at.glow > 0))
        surface.setState({ ...at, step: Math.min(STEPS, at.step + 1), glow: Math.max(0, at.glow - 1) })
    })
  } else if (now.gold !== s.to.gold || now.xp !== s.to.xp) {
    // new figures: count from wherever the last count had got to
    const gained = { gold: now.gold - s.to.gold, xp: now.xp - s.to.xp }
    s = { from: shown(s), to: now, step: 0, gained, glow: GLOW }
    surface.setState(s)
  }

  const { gold, xp } = shown(s)
  const plus = (n: number) => (n > 0 ? `+${n}` : String(n))
  const lit = s.glow > 0
  return (
    <Box justifyContent="space-between" width="100%">
      <Text wrap="truncate-end">
        <Text color="claude">{`🏅 ${props.rank}`}</Text>
        <Text>{` · ${xp} xp`}</Text>
        {lit && s.gained.xp !== 0 && (
          <Text color="success" bold>
            {` ${plus(s.gained.xp)}`}
          </Text>
        )}
      </Text>
      <Text>
        {lit && s.gained.gold !== 0 && (
          <Text color={s.gained.gold > 0 ? 'success' : 'warning'} bold>
            {`${plus(s.gained.gold)} `}
          </Text>
        )}
        <Text color="warning" bold={lit}>
          {String(gold)}
        </Text>
        <Text> 💰</Text>
      </Text>
    </Box>
  )
}

export default Purse
