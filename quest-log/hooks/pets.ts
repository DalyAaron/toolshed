// The pets, in pixels: a 12-pixel sprite each, drawn from a grid of palette
// letters, and how one moves: it bobs, blinks, hops when it's happy, sags
// when it's not, and hearts rise off it for a moment after it's petted.
// Pure (no $), like scene.ts; quest.py holds everything else about pets.

import { Canvas, mix } from './scene'

type Sprite = { palette: Record<string, number>; rows: readonly string[] }

// `.` is see-through; `e` is an eye (drawn shut on a blink, in `body`).
const EYE = 0x1b1b24
const SPRITES: Record<string, Sprite & { body: number }> = {
  duck: {
    body: 0xf7d23e,
    palette: { y: 0xf7d23e, Y: 0xd9a91e, o: 0xf08a24, w: 0xfff6c8 },
    rows: [
      '............',
      '....yyyy....',
      '...yyyyyy...',
      '...yeyyyy...',
      '...yyyyoooo.',
      '...yyyyooo..',
      '.Y..yyyy....',
      '.YyyyyyyyY..',
      '.yyyywwyyyy.',
      '..yyyyyyyY..',
      '...YYYYYY...',
      '............',
    ],
  },
  frog: {
    body: 0x5cb85c,
    palette: { g: 0x5cb85c, G: 0x3d8b3d, w: 0xf4f4f4, p: 0xf29bb0, l: 0xb8e08a },
    rows: [
      '............',
      '..ww....ww..',
      '.wwew..wewww',
      '.wwwwggwwww.',
      '.gggggggggg.',
      '.gpggggggpg.',
      '.gGGGGGGGGg.',
      '..gllllllg..',
      '.gglllllllg.',
      '.gg.gggg.gg.',
      'GG..G..G..GG',
      '............',
    ],
  },
  slime: {
    body: 0x6fd08c,
    palette: { s: 0x6fd08c, S: 0x3e9f5c, w: 0xe8fff0, p: 0xf29bb0 },
    rows: [
      '............',
      '............',
      '.....ss.....',
      '....ssss....',
      '...swssss...',
      '..swssssss..',
      '..sesssses..',
      '.ssssssssss.',
      '.spsssssspss',
      '.SssssssssS.',
      '..SSSSSSSS..',
      '............',
    ],
  },
  cat: {
    body: 0xe89a3c,
    palette: { o: 0xe89a3c, O: 0xb86a1c, w: 0xfff2e0, p: 0xf6a6b2, k: 0x2a1a10 },
    rows: [
      '..o......o..',
      '..oo....oo..',
      '..opoooopo..',
      '..oooooooo..',
      '..oeooooeo..',
      '..oowkkwoo..',
      '...oowwoo...',
      '..oOoOoOoo.O',
      '..oowwwwoo.O',
      '..oowwwwooO.',
      '..oo.oo.oo..',
      '............',
    ],
  },
  dog: {
    body: 0xb5794a,
    palette: { b: 0xb5794a, B: 0x6b4024, w: 0xf2e6d0, k: 0x241510, r: 0xe0505a },
    rows: [
      '............',
      '...bbbbbb...',
      '..BbbbbbbB..',
      '.BBebbbbeBB.',
      '.BBbbwwbbBB.',
      '..BbwkkwbB..',
      '...bwwrwb...',
      '....bbbb...b',
      '...bbbbbb.b.',
      '...bwwwwbb..',
      '...bb..bb...',
      '............',
    ],
  },
  owl: {
    body: 0x8a5a3a,
    palette: { n: 0x8a5a3a, N: 0x5e3a22, y: 0xf2c94c, o: 0xe8902a, c: 0xe9d6b0 },
    rows: [
      '..N......N..',
      '..NnnnnnnN..',
      '.nyyynnyyyn.',
      '.nyeynnyeyn.',
      '.nyyynnyyyn.',
      '.nnnnoonnnn.',
      '.NnncoocnnN.',
      '.NnccccccnN.',
      '.NnccccccnN.',
      '..nnnnnnnn..',
      '...o....o...',
      '............',
    ],
  },
  axolotl: {
    body: 0xf6a6c8,
    palette: { p: 0xf6a6c8, P: 0xe0609a, w: 0xfff0f6, k: 0x7a2a4a },
    rows: [
      '............',
      'P..........P',
      'PP.pppppp.PP',
      '.PppppppppP.',
      'PPpeppppepPP',
      '.Pppppppppp.',
      '..ppkppkpp..',
      '...pppppp...',
      '..pwwwwwpppp',
      '..pp....pppP',
      '..p......PP.',
      '............',
    ],
  },
  fox: {
    body: 0xe8702a,
    palette: { o: 0xe8702a, O: 0xb04a14, w: 0xfff4ea, k: 0x2a1a10 },
    rows: [
      '.o........o.',
      '.oo......oo.',
      '.owo....owo.',
      '.oooooooooo.',
      '.oeoooooeoo.',
      '..wwoooww...',
      '...wwkww....',
      '....wwww....',
      '...oooooo.oo',
      '..ooowwoooOo',
      '..oO.oO.Ooww',
      '............',
    ],
  },
  ghost: {
    body: 0xeeeefa,
    palette: { w: 0xeeeefa, W: 0xb8b8d8, p: 0xf6a6b2, k: 0x2a2a40 },
    rows: [
      '....wwww....',
      '...wwwwww...',
      '..wwwwwwww..',
      '..weewweew..',
      '..weewweew..',
      '..wwwwwwww..',
      '..wpwkkwpw..',
      '..wwwkkwww..',
      '..wwwwwwww..',
      '..wwwwwwww..',
      '..wW.wW.wW..',
      '............',
    ],
  },
  dragon: {
    body: 0x4fa86a,
    palette: { d: 0x4fa86a, D: 0x2f7044, y: 0xf2d06a, r: 0xe0503a, w: 0xf4f4f4 },
    rows: [
      '.w........w.',
      '.dd......dd.',
      '..dddddddd..',
      '.ddeddddedd.',
      '.dddddddddd.',
      '..ddrddrdd..',
      'DD.ddyyydd.D',
      'DDDdyyyyydDD',
      '.D.dyyyyyd.D',
      '...dd..dd..d',
      '..ddd..ddd..',
      '............',
    ],
  },
}

export const SPECIES = Object.keys(SPRITES)
// the drawing: the sprite and room above it for a hop and for hearts
export const PET_COLUMNS = 14
export const PET_ROWS = 9

const HEART = 0xf0506e
const HEART_SHAPE = ['x.x', 'xxx', '.x.']

export type PetPose = {
  // 0 to 100
  joy: number
  hungry: boolean
  // seconds since it was last petted; hearts rise for the first two
  sincePetted: number
}

// The pet at `t` seconds. Each pet keeps its own rhythm (`seed`), so a pen of
// them doesn't bob in step.
export function petFrame(species: string, t: number, pose: PetPose, seed = 0): Canvas {
  const sprite = SPRITES[species] ?? SPRITES.slime!
  const c = new Canvas(PET_COLUMNS, PET_ROWS * 2)
  const happy = pose.joy >= 65
  const sad = pose.joy < 20 || pose.hungry
  const phase = t + seed * 0.37

  // a slow breath for everyone, a hop for the happy, nothing much for the sad
  let lift = 0
  if (happy) lift = Math.max(0, Math.round(2.4 * Math.sin(phase * 4))) // a hop every ~1.6s
  else if (!sad) lift = Math.sin(phase * 2) > 0.3 ? 1 : 0
  const blink = phase % 3.7 < 0.18
  const top = 6 - lift

  sprite.rows.forEach((row, y) => {
    Array.from(row).forEach((ch, x) => {
      if (ch === '.') return
      let colour = ch === 'e' ? (blink ? sprite.body : EYE) : (sprite.palette[ch] ?? sprite.body)
      if (sad) colour = mix(colour, 0x6a6a7a, 0.35)
      c.set(1 + x, top + y, colour)
    })
  })

  // hearts, rising and spreading for two seconds after a pet
  if (pose.sincePetted >= 0 && pose.sincePetted < 2) {
    const u = pose.sincePetted / 2
    for (const [i, dx] of [
      [0, 2],
      [1, 8],
    ] as const) {
      const hy = Math.round(top - 3 - u * 4) - i
      const hx = dx + Math.round(Math.sin(u * 6 + i) * 1)
      HEART_SHAPE.forEach((line, y) =>
        Array.from(line).forEach((ch, x) => {
          if (ch === 'x') c.set(hx + x, hy + y, HEART)
        }),
      )
    }
  }
  return c
}
