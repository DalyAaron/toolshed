// The shop's wares, in pixels: a 12-pixel picture of each thing it sells,
// drawn from a grid of palette letters as the pets are, for the shop's tiles.
// Pure (no $), like scene.ts and pets.ts; quest.py holds the prices.

import { Canvas, mix } from './scene'

type Art = { palette: Record<string, number>; rows: readonly string[] }

export const WARE_PIXELS = 12

const GOLD = 0xffd24a
const GOLD_DARK = 0xd9a91e
const GLASS = 0xc8d6e5
const CORK = 0x8a5a2b

// The flask every potion comes in; `L` is the potion, `l` a bubble in it.
const FLASK = [
  '............',
  '.....kk.....',
  '.....kk.....',
  '.....gg.....',
  '....g..g....',
  '...g....g...',
  '..gLLLLLLg..',
  '..gLLLLLLg..',
  '..gLLlLLLg..',
  '..gLLLLLLg..',
  '...gLLLLg...',
  '....gggg....',
]
const potion = (liquid: number): Art => ({
  palette: { g: GLASS, k: CORK, L: liquid, l: mix(liquid, 0xffffff, 0.55) },
  rows: FLASK,
})

const ART: Record<string, Art> = {
  double: {
    palette: { G: GOLD, g: GOLD_DARK },
    rows: [
      'GGGGGGGGGGGG',
      'G..........G',
      'G.gggggggg.G',
      'G.g......g.G',
      'G.g......g.G',
      'G.g......g.G',
      'G.g......g.G',
      'G.g......g.G',
      'G.g......g.G',
      'G.gggggggg.G',
      'G..........G',
      'GGGGGGGGGGGG',
    ],
  },
  ascii: {
    palette: { g: 0x7ee787 },
    rows: [
      '.g........g.',
      'ggg.gggg.ggg',
      '.g........g.',
      '............',
      '.g........g.',
      '.g........g.',
      '.g........g.',
      '.g........g.',
      '............',
      '.g........g.',
      'ggg.gggg.ggg',
      '.g........g.',
    ],
  },
  blocks: {
    palette: { B: 0x6ab0ff, o: 0x5a6b85 },
    rows: [
      '............',
      '............',
      '............',
      '............',
      '.BBB.BBB.ooo',
      '.BBB.BBB.o.o',
      '.BBB.BBB.o.o',
      '.BBB.BBB.ooo',
      '............',
      '............',
      '............',
      '............',
    ],
  },
  beads: {
    palette: { b: 0xf29b4b, B: 0xd9772a, o: 0x8a6a55 },
    rows: [
      '............',
      '............',
      '............',
      '............',
      '.bb..BB..oo.',
      'bbbbBBBBo..o',
      'bbbbBBBBo..o',
      '.bb..BB..oo.',
      '............',
      '............',
      '............',
      '............',
    ],
  },
  hearts: {
    palette: { r: 0xf0506e, h: 0x8a4a5a },
    rows: [
      '............',
      '............',
      '............',
      '............',
      '.rr.rr.hh.hh',
      '.rrrrr.h.h.h',
      '..rrr...h.h.',
      '...r.....h..',
      '............',
      '............',
      '............',
      '............',
    ],
  },
  crown: {
    palette: { y: GOLD, Y: GOLD_DARK, r: 0xe0404a },
    rows: [
      '............',
      '............',
      '.y...yy...y.',
      '.yy..yy..yy.',
      '.yyy.yy.yyy.',
      '.yyyyyyyyyy.',
      '.yyryyyyryy.',
      '.yyyyyyyyyy.',
      '.YYYYYYYYYY.',
      '............',
      '............',
      '............',
    ],
  },
  gem: {
    palette: { c: 0x6ad1ff, d: 0x2d8fd6, C: 0xe8f8ff },
    rows: [
      '............',
      '............',
      '...cccccc...',
      '..cCccccCc..',
      '.cccccccccc.',
      '..dddddddd..',
      '...dddddd...',
      '....dddd....',
      '.....dd.....',
      '............',
      '............',
      '............',
    ],
  },
  custom: {
    palette: { p: 0x8a5a2b, o: GOLD, r: 0xc0392b, y: GOLD },
    rows: [
      '.o..........',
      '.prrrrrrrrr.',
      '.prrrrrrrrr.',
      '.prryyyyyrr.',
      '.prrrrrrrrr.',
      '.prrrrrrrrr.',
      '.prrrr..rrr.',
      '.prr.....rr.',
      '.p..........',
      '.p..........',
      '.p..........',
      'ppp.........',
    ],
  },
  egg: {
    palette: { e: 0xf4ead0, s: 0xb07a4a },
    rows: [
      '............',
      '.....ee.....',
      '....eeee....',
      '...eeseee...',
      '...eeeeee...',
      '..eeeeesee..',
      '..eseeeeee..',
      '..eeeeeeee..',
      '..eeeeseee..',
      '...eeeeee...',
      '....eeee....',
      '............',
    ],
  },
  kibble: {
    palette: { k: 0xa0642c, K: 0x7a4a1e, B: 0x7fa8e8, b: 0x4a7fd6 },
    rows: [
      '............',
      '............',
      '............',
      '............',
      '....k.kk....',
      '..kkKkkKkk..',
      '.BBBBBBBBBB.',
      '.bbbbbbbbbb.',
      '..bbbbbbbb..',
      '...bbbbbb...',
      '............',
      '............',
    ],
  },
  treat: {
    palette: { c: 0xd9a35b, d: 0x5a3215 },
    rows: [
      '............',
      '............',
      '....cccc....',
      '..cccccccc..',
      '..ccdccccc..',
      '.cccccccdcc.',
      '.ccdccccccc.',
      '.cccccdcccc.',
      '..cccccccc..',
      '..ccdccccc..',
      '....cccc....',
      '............',
    ],
  },
  feast: {
    palette: { m: 0xc8642a, M: 0xe8a060, b: 0xf4ead0 },
    rows: [
      '............',
      '.....mmmm...',
      '....mmmmmm..',
      '....mmMmmmm.',
      '....mmmmmmm.',
      '.....mmmmm..',
      '......mmm...',
      '.....bb.....',
      '....bb......',
      '..bbb.......',
      '..bb........',
      '............',
    ],
  },
  health: potion(0xe0404a),
  xp: potion(0x4cc96a),
  luck: potion(0xf2c832),
}

// The ware's picture, or null for one not drawn (a frame or bar added to
// quest.py before it's added here): the tile shows its name alone.
export function wareArt(id: string): Canvas | null {
  const art = ART[id]
  if (!art) return null
  const c = new Canvas(WARE_PIXELS, WARE_PIXELS)
  art.rows.forEach((row, y) =>
    [...row].forEach((ch, x) => {
      const color = art.palette[ch]
      if (color !== undefined) c.set(x, y, color)
    }),
  )
  return c
}
