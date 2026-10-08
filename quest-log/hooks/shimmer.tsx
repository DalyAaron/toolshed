import type { ClientModule } from 'claude-code'

// A title just turned in, drawn on the surface itself (a `Client`): a band of
// light runs along it a few times, then it settles as plain bold text.

type Props = { text: string }
type State = { tick: number }

const FRAME_MS = 45
const SWEEPS = 3
const BAND = 2 // characters either side of the light

const Shimmer: ClientModule<Props, State> = (props, surface) => {
  const { Text } = surface.elements
  const chars = Array.from(props.text)
  const lap = chars.length + BAND * 2 + 4
  const last = lap * SWEEPS

  const s = surface.state
  if (!s) {
    surface.setState({ tick: 0 })
    const timer = surface.every(FRAME_MS, () => {
      const at = surface.state?.tick ?? 0
      if (at >= last) timer()
      else surface.setState({ tick: at + 1 })
    })
  }
  const tick = s?.tick ?? 0
  if (tick >= last) return <Text bold wrap="wrap">{props.text}</Text>

  const centre = (tick % lap) - BAND - 2
  const from = Math.max(0, Math.min(chars.length, centre - BAND))
  const to = Math.max(0, Math.min(chars.length, centre + BAND + 1))
  return (
    <Text bold wrap="wrap">
      {chars.slice(0, from).join('')}
      <Text color="warning">{chars.slice(from, to).join('')}</Text>
      {chars.slice(to).join('')}
    </Text>
  )
}

export default Shimmer
