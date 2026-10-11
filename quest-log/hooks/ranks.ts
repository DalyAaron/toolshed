// The ranks' emblems, in pixels: a 12-pixel picture for each of the ten,
// drawn from palette-letter grids as the wares and pets are, for the Ranks
// tab. Pure (no $); quest.py holds the ranks and their thresholds.

import { Canvas, mix } from './scene'

type Art = { palette: Record<string, number>; rows: readonly string[] }

export const EMBLEM_PIXELS = 12

const GOLD = 0xffd24a
const GOLD_DARK = 0xd9a91e

const EMBLEMS: Record<string, Art> = {
  // a candle, the first light
  Initiate: {
    palette: { f: 0xf08a24, y: 0xffe27a, w: 0xf4ead0, d: 0x6b4a2a },
    rows: [
      '.....f......',
      '....fyf.....',
      '....fyf.....',
      '.....w......',
      '....www.....',
      '....www.....',
      '....www.....',
      '....www.....',
      '....www.....',
      '...ddddd....',
      '..ddddddd...',
      '............',
    ],
  },
  // a quill and its ink
  Apprentice: {
    palette: { w: 0xe8f0ff, k: 0x2a2a35, b: 0x2d4a9a },
    rows: [
      '.........ww.',
      '........www.',
      '.......www..',
      '......www...',
      '.....www....',
      '....www.....',
      '...ww.......',
      '..w.........',
      '.k..........',
      '..bbbb......',
      '.bbbbbb.....',
      '.bbbbbb.....',
    ],
  },
  // a hammer, for work done on the road
  Journeyman: {
    palette: { H: 0x6b7280, h: 0xc8d0dc, b: 0x8a5a2b },
    rows: [
      '............',
      '.HHHHHHHH...',
      '.HhhhhhhH...',
      '.HHHHHHHH...',
      '....bb......',
      '....bb......',
      '....bb......',
      '....bb......',
      '....bb......',
      '....bb......',
      '....bb......',
      '............',
    ],
  },
  // a wand, sparking
  Adept: {
    palette: { y: GOLD, b: 0x5a3b1e, w: 0xfff6c8 },
    rows: [
      '......y..y..',
      '.........y..',
      '........yyy.',
      '.........y..',
      '.......b....',
      '......b.....',
      '.....b......',
      '....b.......',
      '...b........',
      '..w.........',
      '.w......y...',
      '............',
    ],
  },
  // a cog
  Artificer: {
    palette: { g: 0xc9a04a },
    rows: [
      '.....gg.....',
      '..g.gggg.g..',
      '.gggggggggg.',
      '..gggggggg..',
      '.ggg....ggg.',
      'gggg....gggg',
      'gggg....gggg',
      '.ggg....ggg.',
      '..gggggggg..',
      '.gggggggggg.',
      '..g.gggg.g..',
      '.....gg.....',
    ],
  },
  // a crystal ball on its stand
  Enchanter: {
    palette: { p: 0x9b6cf0, P: 0xe8dcff, d: 0x5a3b1e },
    rows: [
      '............',
      '....pppp....',
      '...pPpppp...',
      '..pPpppppp..',
      '..pppppppp..',
      '..pppppppp..',
      '...pppppp...',
      '....pppp....',
      '...dddddd...',
      '..dddddddd..',
      '............',
      '............',
    ],
  },
  // a scroll
  Sage: {
    palette: { R: 0xc9a35b, s: 0xf0dca0, k: 0x6b4a2a },
    rows: [
      '............',
      '.RRRRRRRRRR.',
      '..ssssssss..',
      '..skkkkkss..',
      '..ssssssss..',
      '..skkkksss..',
      '..ssssssss..',
      '..skkkkkss..',
      '..ssssssss..',
      '.RRRRRRRRRR.',
      '............',
      '............',
    ],
  },
  // a wizard's hat, starred
  Archmage: {
    palette: { b: 0x3a5bd9, y: GOLD, Y: 0x2a3fa0 },
    rows: [
      '.....b......',
      '.....bb.....',
      '....bbb.....',
      '....bybb....',
      '...bbbbb....',
      '...bbbbbb...',
      '..bbbybbbb..',
      '..bbbbbbbb..',
      '.bbbbbbbbbb.',
      'YYYYYYYYYYYY',
      '.YYYYYYYYYY.',
      '............',
    ],
  },
  // a staff crowned with a glowing orb
  'Grand Archmage': {
    palette: { c: 0x6ad1ff, C: 0xe8f8ff, g: 0x9be8ff, y: GOLD, b: 0x5a3b1e },
    rows: [
      '.....cc.....',
      '..g.cCcc.g..',
      '....cccc....',
      '.....cc.....',
      '....y..y....',
      '.....bb.....',
      '.....bb.....',
      '.....bb.....',
      '.....bb.....',
      '.....bb.....',
      '.....bb.....',
      '.....bb.....',
    ],
  },
  // an open tome, glowing
  Loremaster: {
    palette: { y: GOLD, Y: GOLD_DARK, w: 0xf4ead0, k: 0x8a8a96, C: 0x8b2f4f },
    rows: [
      '.....yy.....',
      '...y.yy.y...',
      '....yYYy....',
      '.....yy.....',
      '............',
      '.wwww..wwww.',
      'wkkkwwwwkkkw',
      'wwwwwwwwwwww',
      'wkkkwwwwkkkw',
      'wwwwwwwwwwww',
      'CCCCCCCCCCCC',
      '.CCCC..CCCC.',
    ],
  },
}

export const EMBLEMS_DRAWN = Object.keys(EMBLEMS)

// The rank's emblem, greyed out while it's still to be reached; null for a
// rank not drawn here.
export function emblem(rank: string, locked = false): Canvas | null {
  const art = EMBLEMS[rank]
  if (!art) return null
  const c = new Canvas(EMBLEM_PIXELS, EMBLEM_PIXELS)
  art.rows.forEach((row, y) =>
    [...row].forEach((ch, x) => {
      const color = art.palette[ch]
      if (color === undefined) return
      const grey = ((((color >> 16) & 0xff) + ((color >> 8) & 0xff) + (color & 0xff)) / 3) | 0
      c.set(x, y, locked ? mix((grey << 16) | (grey << 8) | grey, 0x30303a, 0.55) : color)
    }),
  )
  return c
}
