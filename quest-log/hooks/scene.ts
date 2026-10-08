// The shop's sign, in pixels: a timber shop at dusk under a moon, its windows
// lit, smoke off the chimney, stars and fireflies, all moving with the clock.
// Pure (no $), so the overlay and its tests share it. A terminal cell holds
// two pixels, the top as a half block's colour and the bottom as its
// background; other surfaces get the same pixels as an SVG.

export const NONE = -1
const DEFAULT = 0x01000000 // the terminal's own colour, in a Raster cell
const UPPER = 0x2580 // ▀
const LOWER = 0x2584 // ▄

export class Canvas {
  readonly px: Int32Array
  constructor(
    readonly w: number,
    readonly h: number,
  ) {
    this.px = new Int32Array(w * h).fill(NONE)
  }
  get(x: number, y: number): number {
    return x < 0 || y < 0 || x >= this.w || y >= this.h ? NONE : this.px[y * this.w + x]!
  }
  set(x: number, y: number, c: number): void {
    x = Math.round(x)
    y = Math.round(y)
    if (x >= 0 && y >= 0 && x < this.w && y < this.h) this.px[y * this.w + x] = c
  }
  // `a` of `c` over what's there (over nothing, it's `c` faded to the sky's top)
  blend(x: number, y: number, c: number, a: number): void {
    const under = this.get(Math.round(x), Math.round(y))
    if (a <= 0 || under === NONE) return
    this.set(x, y, mix(under, c, Math.min(1, a)))
  }
  rect(x: number, y: number, w: number, h: number, c: number): void {
    for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) this.set(x + i, y + j, c)
  }
}

export function mix(a: number, b: number, t: number): number {
  const ch = (shift: number) => {
    const p = (a >> shift) & 0xff
    const q = (b >> shift) & 0xff
    return Math.round(p + (q - p) * t) << shift
  }
  return ch(16) | ch(8) | ch(0)
}

// a stable 0..1 for a whole number, so stars and puffs land in the same place every frame
function hash(n: number): number {
  let x = Math.imul(n ^ 0x5bd1e995, 0x27d4eb2d)
  x ^= x >>> 15
  x = Math.imul(x, 0x85ebca6b)
  x ^= x >>> 13
  return (x >>> 0) / 0xffffffff
}

const SKY_TOP = 0x0b0f2a
const SKY_LOW = 0x5a3266
const HILL_FAR = 0x2a2350
const HILL_NEAR = 0x1f2b3a
const GRASS = 0x30502e
const GRASS_TOP = 0x447038
const PATH = 0x8a7350
const PLASTER = 0xd9c08e
const TIMBER = 0x5a3b1e
const ROOF = 0x8b2f2f
const ROOF_EDGE = 0x5e1f1f
const ROOF_LIGHT = 0xa13d36
const BRICK = 0x6d5a55
const MORTAR = 0x4a3c39
const DOOR = 0x5a3215
const GOLD = 0xffd24a
const MOON = 0xf3e8c0
const MOON_SHADE = 0xcfc29a
const SMOKE = 0xc9c3d6
const GLOW_LOW = 0xc98a2a
const GLOW_HIGH = 0xffd86a

// The scene at `t` seconds, `w` pixels by `h` (h even: two to a cell).
export function shop(w: number, h: number, t: number): Canvas {
  const c = new Canvas(w, h)
  // a short sign (inline, where rows are dear) gets a smaller shop
  const small = h < 20
  const ground = h - (small ? 3 : 4)

  // sky, dusk toward the horizon
  for (let y = 0; y < ground; y++) for (let x = 0; x < w; x++) c.set(x, y, mix(SKY_TOP, SKY_LOW, (y / ground) ** 1.6))

  // stars in the upper sky, each on its own slow twinkle
  for (let i = 0; i < Math.floor(w / 3); i++) {
    const x = Math.floor(hash(i * 7 + 1) * w)
    const y = Math.floor(hash(i * 13 + 5) * (ground * 0.55))
    const twinkle = 0.5 + 0.5 * Math.sin(t * (1.2 + hash(i) * 2.5) + i * 1.9)
    c.blend(x, y, 0xfff6d8, 0.25 + 0.75 * twinkle * twinkle)
  }

  // the moon, a crescent's shade on its lower left
  const mx = w - Math.max(6, Math.round(w * 0.14))
  const my = Math.max(3, Math.round(ground * 0.22))
  for (let y = -4; y <= 4; y++)
    for (let x = -4; x <= 4; x++) {
      const d = Math.hypot(x, y)
      const r = small ? 2.4 : 3.3
      if (d <= r) c.set(mx + x, my + y, Math.hypot(x + 1.2, y - 1) < r * 0.4 ? MOON_SHADE : MOON)
      else if (d <= r + 1.1) c.blend(mx + x, my + y, MOON, 0.18)
    }

  // two ranges of hills
  for (let x = 0; x < w; x++) {
    const far = ground - 5 - 2.2 * Math.sin(x * 0.17 + 1) - 1.4 * Math.sin(x * 0.06 + 3)
    const near = ground - 2 - 1.2 * Math.sin(x * 0.11 + 4.2)
    for (let y = Math.round(far); y < ground; y++) c.set(x, y, HILL_FAR)
    for (let y = Math.round(near); y < ground; y++) c.set(x, y, HILL_NEAR)
  }

  // grass, and a path from the door
  const cx = Math.floor(w / 2)
  for (let y = ground; y < h; y++)
    for (let x = 0; x < w; x++) {
      const spread = 2 + (y - ground)
      const onPath = Math.abs(x - cx) <= spread - 1
      c.set(x, y, onPath ? PATH : y === ground ? GRASS_TOP : mix(GRASS, 0x1d331c, (y - ground) / 4))
    }

  // the shop: walls, roof, chimney
  const half = Math.max(7, Math.min(12, Math.round(w * 0.2)))
  const wallH = small ? 4 : 6
  const wallTop = ground - wallH
  const left = cx - half
  const right = cx + half - 1
  c.rect(left, wallTop, half * 2, wallH, PLASTER)
  for (const bx of [left, cx - Math.ceil(half / 2) - 1, cx + Math.floor(half / 2), right]) c.rect(bx, wallTop, 1, wallH, TIMBER)
  c.rect(left, wallTop, half * 2, 1, TIMBER)

  const roofH = small ? 4 : 6
  const overhang = 2
  for (let r = 0; r < roofH; r++) {
    const y = wallTop - 1 - r
    const reach = Math.round((half + overhang) * (1 - r / (roofH + 0.5)))
    for (let x = cx - reach; x < cx + reach; x++) {
      const edge = x === cx - reach || x === cx + reach - 1 || r === 0
      c.set(x, y, edge ? ROOF_EDGE : r % 2 === 0 ? ROOF : ROOF_LIGHT)
    }
  }

  const chimneyX = cx + Math.round(half * 0.45)
  const chimneyTop = wallTop - roofH - 1
  for (let y = chimneyTop; y < wallTop - 2; y++)
    for (let x = chimneyX; x < chimneyX + 3; x++) c.set(x, y, (y + (x === chimneyX + 1 ? 1 : 0)) % 2 ? BRICK : MORTAR)
  c.rect(chimneyX - 1, chimneyTop, 5, 1, MORTAR)

  // windows lit from inside, flickering with the fire
  const flicker = 0.75 + 0.25 * Math.sin(t * 6.1) * Math.sin(t * 2.3 + 1)
  const glow = mix(GLOW_LOW, GLOW_HIGH, flicker)
  for (const wx of [left + 2, right - 4]) {
    c.rect(wx, wallTop + (small ? 1 : 2), 3, 2, glow)
    c.rect(wx + 1, wallTop + (small ? 1 : 2), 1, 2, TIMBER)
    for (let x = wx - 1; x <= wx + 3; x++) c.blend(x, ground, glow, 0.25 * flicker)
  }

  // the door, its knob, and a sign with a coin above it
  const doorH = small ? 3 : 4
  c.rect(cx - 2, ground - doorH, 4, doorH, DOOR)
  c.set(cx + 1, ground - 2, GOLD)
  if (!small) {
    c.rect(cx - 2, wallTop + 1, 4, 1, TIMBER)
    c.set(cx - 1, wallTop + 1, GOLD)
    c.set(cx, wallTop + 1, GOLD)
  }

  // smoke: puffs leave the chimney in turn, rising, swelling, drifting off on the wind
  const puffs = 9
  const life = 4.2
  const ex = chimneyX + 1
  const ey = chimneyTop - 1
  for (let i = 0; i < puffs; i++) {
    const age = (t + (i * life) / puffs) % life
    const u = age / life
    const px = ex + u * u * 10 + Math.sin(age * 2.1 + i * 1.7) * 1.1 * u
    const py = ey - u * (ey + 3)
    const r = 0.7 + u * 2.1
    const a = 0.6 * (1 - u) ** 1.3
    for (let y = Math.floor(py - r - 1); y <= Math.ceil(py + r + 1); y++)
      for (let x = Math.floor(px - r - 1); x <= Math.ceil(px + r + 1); x++) {
        const d = Math.hypot(x - px, (y - py) * 1.1)
        if (d < r + 0.5) c.blend(x, y, SMOKE, a * Math.min(1, r + 0.5 - d))
      }
  }

  // fireflies over the grass
  for (let i = 0; i < 3; i++) {
    const on = Math.sin(t * (1.7 + i * 0.4) + i * 2.4)
    if (on < 0.2) continue
    const fx = ((hash(i + 40) * w + t * (0.6 + i * 0.3) * (i % 2 ? 1 : -1)) % w + w) % w
    const fy = ground - 2 + Math.sin(t * 1.3 + i * 2) * 1.5
    if (Math.abs(fx - cx) < half + 1) continue // not through the walls
    c.blend(fx, fy, 0xe3ff7a, on)
  }

  return c
}

// The canvas as a Raster's cells: [codePoint, foreground, background] each.
export function cells(c: Canvas): Uint32Array {
  const cols = c.w
  const rows = Math.ceil(c.h / 2)
  const words = new Uint32Array(cols * rows * 3)
  for (let row = 0; row < rows; row++)
    for (let x = 0; x < cols; x++) {
      const top = c.get(x, row * 2)
      const bottom = c.get(x, row * 2 + 1)
      const at = (row * cols + x) * 3
      if (top === NONE && bottom === NONE) words.set([0x20, DEFAULT, DEFAULT], at)
      else if (top === NONE) words.set([LOWER, bottom, DEFAULT], at)
      else words.set([UPPER, top, bottom === NONE ? DEFAULT : bottom], at)
    }
  return words
}

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'

// little-endian u32s as padded base64, as RasterProps.cells wants
export function base64(words: Uint32Array): string {
  const bytes = new Uint8Array(words.buffer, words.byteOffset, words.byteLength)
  let out = ''
  for (let i = 0; i < bytes.length; i += 3) {
    const n = (bytes[i]! << 16) | ((bytes[i + 1] ?? 0) << 8) | (bytes[i + 2] ?? 0)
    out += B64[(n >> 18) & 63]! + B64[(n >> 12) & 63]!
    out += i + 1 < bytes.length ? B64[(n >> 6) & 63]! : '='
    out += i + 2 < bytes.length ? B64[n & 63]! : '='
  }
  return out
}

const hex = (c: number) => `#${c.toString(16).padStart(6, '0')}`

// The canvas as an SVG, a rect per run of one colour along a row; a cell's
// two pixels are as wide as they are tall, so each pixel is `size` square.
export function svg(c: Canvas, size = 6): string {
  const parts: string[] = []
  for (let y = 0; y < c.h; y++) {
    let x = 0
    while (x < c.w) {
      const colour = c.get(x, y)
      let run = 1
      while (x + run < c.w && c.get(x + run, y) === colour) run++
      if (colour !== NONE)
        parts.push(`<rect x="${x * size}" y="${y * size}" width="${run * size}" height="${size}" fill="${hex(colour)}"/>`)
      x += run
    }
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${c.w * size} ${c.h * size}" width="${c.w * size}" height="${c.h * size}" shape-rendering="crispEdges">${parts.join('')}</svg>`
}
