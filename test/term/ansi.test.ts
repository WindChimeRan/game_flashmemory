import { describe, expect, test } from 'bun:test'
import {
  ALT_SCREEN_OFF,
  ALT_SCREEN_ON,
  BSU,
  ESU,
  MOUSE_OFF,
  MOUSE_ON,
  SGR_RESET,
  attrParams,
  bgParam,
  colorTo256,
  cursorTo,
  decrst,
  decset,
  fgParam,
  rgb,
  rgbTo256,
  sgr,
} from '../../src/term/ansi'
import {
  ATTR_BOLD,
  ATTR_DIM,
  ATTR_ITALIC,
  ATTR_REVERSE,
  ATTR_UNDERLINE,
  DEFAULT_COLOR,
  TRUECOLOR_BIT,
} from '../../src/term/types'

describe('cursor and modes', () => {
  test('cursorTo is 0-based in, 1-based CUP out', () => {
    expect(cursorTo(0, 0)).toBe('\x1b[1;1H')
    expect(cursorTo(4, 9)).toBe('\x1b[5;10H')
  })

  test('decset/decrst single and multi', () => {
    expect(decset(1049)).toBe('\x1b[?1049h')
    expect(decrst(1049)).toBe('\x1b[?1049l')
    expect(decset(1000, 1002, 1006)).toBe('\x1b[?1000;1002;1006h')
  })

  test('mode constants', () => {
    expect(ALT_SCREEN_ON).toBe('\x1b[?1049h')
    expect(ALT_SCREEN_OFF).toBe('\x1b[?1049l')
    expect(BSU).toBe('\x1b[?2026h')
    expect(ESU).toBe('\x1b[?2026l')
    expect(MOUSE_ON).toBe('\x1b[?1000;1002;1006h')
    expect(MOUSE_OFF).toBe('\x1b[?1006;1002;1000l')
    expect(SGR_RESET).toBe('\x1b[0m')
  })
})

describe('SGR builders', () => {
  test('sgr composition and empty', () => {
    expect(sgr([])).toBe('')
    expect(sgr([1, '38;5;3'])).toBe('\x1b[1;38;5;3m')
  })

  test('attrParams covers all attribute bits', () => {
    expect(attrParams(0)).toEqual([])
    expect(attrParams(ATTR_BOLD)).toEqual([1])
    expect(attrParams(ATTR_DIM)).toEqual([2])
    expect(attrParams(ATTR_ITALIC)).toEqual([3])
    expect(attrParams(ATTR_UNDERLINE)).toEqual([4])
    expect(attrParams(ATTR_REVERSE)).toEqual([7])
    expect(attrParams(ATTR_BOLD | ATTR_UNDERLINE | ATTR_REVERSE)).toEqual([1, 4, 7])
  })

  test('fg/bg default', () => {
    expect(fgParam(DEFAULT_COLOR, true)).toBe('39')
    expect(bgParam(DEFAULT_COLOR, true)).toBe('49')
  })

  test('fg/bg 256-palette index passthrough', () => {
    expect(fgParam(5, true)).toBe('38;5;5')
    expect(bgParam(232, false)).toBe('48;5;232')
  })

  test('fg/bg truecolor when supported', () => {
    expect(fgParam(rgb(255, 0, 0), true)).toBe('38;2;255;0;0')
    expect(bgParam(rgb(1, 2, 3), true)).toBe('48;2;1;2;3')
  })

  test('fg/bg truecolor quantized when unsupported', () => {
    expect(fgParam(rgb(255, 0, 0), false)).toBe('38;5;196')
    expect(bgParam(rgb(0, 0, 0), false)).toBe('48;5;16')
  })

  test('rgb packs with the truecolor bit', () => {
    expect(rgb(255, 0, 0)).toBe(TRUECOLOR_BIT | 0xff0000)
    expect(rgb(0, 0, 1) & TRUECOLOR_BIT).toBe(TRUECOLOR_BIT)
  })
})

describe('truecolor → 256 quantization', () => {
  test('cube corners', () => {
    expect(rgbTo256(0, 0, 0)).toBe(16)
    expect(rgbTo256(255, 255, 255)).toBe(231)
    expect(rgbTo256(255, 0, 0)).toBe(196)
    expect(rgbTo256(0, 255, 0)).toBe(46)
    expect(rgbTo256(0, 0, 255)).toBe(21)
  })

  test('exact cube levels map to their cube cell', () => {
    // levels 0,95,135,175,215,255 → indices 0..5
    expect(rgbTo256(95, 135, 175)).toBe(16 + 36 * 1 + 6 * 2 + 3)
    expect(rgbTo256(215, 95, 255)).toBe(16 + 36 * 4 + 6 * 1 + 5)
  })

  test('grays land on the grayscale ramp', () => {
    expect(rgbTo256(8, 8, 8)).toBe(232) // ramp start
    expect(rgbTo256(128, 128, 128)).toBe(244) // 8 + 12*10 = 128 exact
    expect(rgbTo256(238, 238, 238)).toBe(255) // ramp end
  })

  test('near-black and near-white grays clamp to ramp ends or cube', () => {
    expect(rgbTo256(3, 3, 3)).toBeOneOf([16, 232])
    // 247 gray: cube 255 (d=192) beats ramp 238 (d=243)
    expect(rgbTo256(247, 247, 247)).toBe(231)
  })

  test('non-gray colors prefer the cube', () => {
    expect(rgbTo256(250, 10, 10)).toBe(196)
    expect(rgbTo256(100, 150, 200)).toBe(16 + 36 * 1 + 6 * 2 + 4)
  })

  test('out-of-range inputs are clamped', () => {
    expect(rgbTo256(-10, 0, 0)).toBe(16)
    expect(rgbTo256(300, 300, 300)).toBe(231)
  })

  test('colorTo256 handles all encodings', () => {
    expect(colorTo256(DEFAULT_COLOR)).toBe(-1)
    expect(colorTo256(42)).toBe(42)
    expect(colorTo256(rgb(255, 0, 0))).toBe(196)
  })
})
