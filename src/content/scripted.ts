/**
 * ScriptedProvider (Stage 1, OOM_DESIGN.md §5.3) — deterministic seeded
 * template prose in a pulpy sci-fi/fantasy serial voice. Pillar 4: the game
 * must be fully playable with the LLM off, and prose is texture, never truth.
 *
 * Per glyph: a named recurring character (name starts with the badge letter —
 * a diegetic link between badge and prose). Per theme: 3–4 standing motifs.
 * Sentences come from slot templates; output is word pieces, each with a
 * trailing space, totalling ≥ spec.targetTokens pieces.
 *
 * Dependency law (ARCHITECTURE.md D2): content imports sim TYPES ONLY, so the
 * tiny PRNG is local (mulberry32, same family as the sim's — independent
 * streams, seeded solely from spec.seed).
 */

import type { ChunkSpec } from '../sim/types'
import type { ContentProvider } from './types'

// ── local deterministic PRNG (no value imports from sim allowed) ─────────

function mulberry(seed: number): () => number {
  let s = seed >>> 0
  return () => {
    s = (s + 0x6d2b79f5) >>> 0
    let t = s
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const pick = <T>(rand: () => number, arr: readonly T[]): T =>
  arr[Math.min(arr.length - 1, Math.floor(rand() * arr.length))]!

// ── the serial's cast: one character per badge letter ────────────────────

export interface Character {
  name: string
  title: string
  prop: string
}

const CAST: Record<string, Character> = {
  A: { name: 'Auric Vayle', title: 'the salvage-captain', prop: 'a brass astrolabe' },
  B: { name: 'Brakka Voss', title: 'the engine-witch', prop: 'her coil-hammer' },
  C: { name: 'Cinder Mal', title: 'the smuggler-priest', prop: 'a counterfeit relic-key' },
  D: { name: 'Dax Umbra', title: 'the void-courier', prop: 'a sealed dispatch case' },
  E: { name: 'Ezri Thorn', title: 'the relic-surgeon', prop: 'a bone-saw of glass' },
  F: { name: 'Fenwick Roe', title: 'the storm-pilot', prop: 'a cracked barometer' },
  G: { name: 'Grist Halloway', title: 'the tunnel-baron', prop: 'his ledger of debts' },
  H: { name: 'Hela Marrow', title: 'the lantern-keeper', prop: 'an everburning wick' },
  I: { name: 'Ivo Quenn', title: 'the signal-monk', prop: 'a silver tuning fork' },
  J: { name: 'Jasker Lune', title: 'the chart-thief', prop: 'a self-inking quill' },
  K: { name: 'Kessa Brandt', title: 'the bounty-archivist', prop: 'a magnetic compass rose' },
  L: { name: 'Lyra Stell', title: 'the dream-broker', prop: 'a vial of bottled sleep' },
  M: { name: 'Mordecai Finch', title: 'the auction-master', prop: 'a gavel of meteor iron' },
  N: { name: 'Nyx Calder', title: 'the saboteur', prop: 'a spool of razor wire' },
  O: { name: 'Orrin Bly', title: 'the harbor-master', prop: 'the tide-bell hammer' },
  P: { name: 'Petra Kost', title: 'the reactor-nun', prop: 'a rosary of fuses' },
  Q: { name: 'Quenby Marsh', title: 'the rumor-merchant', prop: 'a coat of stitched maps' },
  R: { name: 'Rook Damaris', title: 'the gun-archaeologist', prop: 'a chalk-marked revolver' },
  S: { name: 'Sable Crow', title: 'the night-surveyor', prop: 'a theodolite of black glass' },
  T: { name: 'Tamsin Grey', title: 'the time-keeper', prop: 'a pocketwatch with nine hands' },
  U: { name: 'Ulli Sten', title: 'the ice-ferryman', prop: 'a whale-oil lamp' },
  V: { name: 'Vesper Hale', title: 'the radio-witch', prop: 'an antenna staff' },
  W: { name: 'Wren Halloran', title: 'the orchard-warden', prop: 'a grafting knife' },
  X: { name: 'Xanthe Reyes', title: 'the black-box diver', prop: 'a dented pressure helm' },
  Y: { name: 'Yara Sund', title: 'the dust-prophet', prop: 'a jar of red sand' },
  Z: { name: 'Zeph Okoye', title: 'the comet-rider', prop: 'a singed flight ledger' },
}

/** Character for a glyph (total: unknown glyphs get a deterministic stranger). */
export function characterFor(glyph: string): Character {
  const key = glyph.length > 0 ? glyph[0]!.toUpperCase() : '?'
  return (
    CAST[key] ?? {
      name: `the ${key}-marked stranger`,
      title: 'the stranger',
      prop: 'an unmarked token',
    }
  )
}

// ── standing motifs per theme (matches the director's theme list) ────────

const MOTIFS: Record<string, readonly string[]> = {
  archive: ['the indexed vaults', 'a ledger of stolen names', 'the dust-sealed stacks', 'the catalogue of last words'],
  harbor: ['the rust-water quay', 'a fleet of sleeping dredgers', 'the tide-bell', "the smugglers' pontoons"],
  signal: ['the relay spire', 'a ghost frequency', 'the static choir', 'the dish-fields'],
  orchard: ['the grafted groves', 'the lantern-fruit rows', 'the pollinator drones', 'the root-cellar vats'],
  engine: ['the reactor stack', 'a chorus of pistons', 'the coolant gardens', 'the overdrive manifolds'],
  letters: ['an unsent confession', "the courier's satchel", 'the wax-sealed orders', 'the dead-drop box'],
  frontier: ['the rim settlements', 'the claim-stake beacons', 'the unmapped scar', 'the dust-line caravans'],
  relic: ['the sleeping idol', 'a shard of first-glass', 'the reliquary engine', 'the bone-circuit amulets'],
  market: ['the night bazaar', 'the counterfeit oxygen scrip', 'the auction of hours', 'the stall-lanterns'],
  storm: ['the pressure front', 'the ion squalls', 'the storm-glass', 'the shelter sirens'],
}

const FALLBACK_MOTIFS: readonly string[] = [
  'the silent quarter',
  'a borrowed lantern',
  'the long stair',
  "yesterday's map",
]

export function motifsFor(theme: string): readonly string[] {
  return MOTIFS[theme] ?? FALLBACK_MOTIFS
}

// ── word pools & sentence templates ──────────────────────────────────────

const ADJS = [
  'ruinous', 'starless', 'ember-lit', 'salt-bitten', 'half-remembered',
  'unlicensed', 'feverish', 'creaking', 'mutinous', 'glass-smooth',
] as const

const VERBS = [
  'smuggled', 'bartered', 'decoded', 'unsealed', 'rewired',
  'buried', 'summoned', 'forged', 'tracked', 'ransomed',
] as const

const OMENS = [
  'a debt come due', 'an old wound opening', 'static before the strike',
  'a door left ajar in the dark', 'the hush before the sirens',
] as const

interface Slots {
  name: string
  first: string
  title: string
  prop: string
  m1: string
  m2: string
  adj: string
  verb: string
  omen: string
}

const TEMPLATES: readonly ((s: Slots) => string)[] = [
  (s) => `${s.name}, ${s.title}, crossed ${s.m1} with ${s.prop} held high.`,
  (s) => `By dawn ${s.name} had ${s.verb} half of ${s.m1}, and ${s.m2} answered with sparks.`,
  (s) => `${s.title} or not, ${s.name} owed ${s.m1} a blood-price.`,
  (s) => `Rumor moved through ${s.m1} like ${s.omen}.`,
  (s) => `${s.name} pressed ${s.prop} to the seam of ${s.m1} and listened.`,
  (s) => `Something under ${s.m1} had learned the name ${s.first}.`,
  (s) => `The ${s.adj} light over ${s.m1} promised ${s.omen}.`,
  (s) => `${s.name} swore by ${s.prop} that ${s.m2} would burn before surrender.`,
  (s) => `Every channel out of ${s.m1} crackled with warnings about ${s.name}.`,
  (s) => `${s.first} counted the cost: ${s.m1}, ${s.m2}, and one ${s.adj} miracle.`,
  (s) => `When the klaxons stilled, ${s.name} was already deep inside ${s.m1}.`,
  (s) => `${s.prop} grew cold whenever ${s.m1} woke, and ${s.first} trusted that chill.`,
]

// ── piece generation ─────────────────────────────────────────────────────

/**
 * Synchronous core: the full deterministic piece stream for a spec.
 * Lazy generator — pulls only what the consumer asks for; always finishes
 * the sentence in progress, so total pieces ≥ max(1, targetTokens).
 */
export function* scriptedPieces(spec: ChunkSpec): Generator<string, void, undefined> {
  const rand = mulberry(spec.seed >>> 0)
  const who = characterFor(spec.glyph)
  const motifs = motifsFor(spec.theme)
  const target = Math.max(1, spec.targetTokens)
  let count = 0
  let lastTpl = -1

  while (count < target) {
    let ti = Math.min(TEMPLATES.length - 1, Math.floor(rand() * TEMPLATES.length))
    if (ti === lastTpl) ti = (ti + 1) % TEMPLATES.length
    lastTpl = ti
    const m1 = pick(rand, motifs)
    let m2 = pick(rand, motifs)
    if (m2 === m1) m2 = motifs[(motifs.indexOf(m1) + 1) % motifs.length]!
    const sentence = TEMPLATES[ti]!({
      name: who.name,
      first: who.name.split(' ')[0]!,
      title: who.title,
      prop: who.prop,
      m1,
      m2,
      adj: pick(rand, ADJS),
      verb: pick(rand, VERBS),
      omen: pick(rand, OMENS),
    })
    const upper = sentence.length > 0 ? sentence[0]!.toUpperCase() + sentence.slice(1) : sentence
    for (const word of upper.split(' ')) {
      if (word.length === 0) continue
      yield `${word} `
      count++
    }
  }
}

/** ContentProvider over the deterministic template engine. */
export class ScriptedProvider implements ContentProvider {
  nextChunk(spec: ChunkSpec): AsyncIterable<string> {
    const pieces = scriptedPieces(spec)
    return (async function* () {
      yield* pieces
    })()
  }
}
