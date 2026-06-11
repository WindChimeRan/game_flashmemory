/**
 * sim — deterministic game core. Public surface: createSim + the contract
 * types/config, plus the seeded Rng utilities (bots/content reuse them).
 */

export * from './types'
export * from './config'
export { createSim, waveCredit } from './sim'
export { makeRng, gaussian, hashStr, mix32 } from './rng'
export { FNV_INIT, fnvInt } from './hash'
export { heatSigma, rampHeat, HEAT_IDLE, HEAT_RAMP_LO, HEAT_RAMP_HI } from './heat'
export { greedyClearable } from './director'
export type { DirectorWorld, DirectorChunk, ActiveDemand } from './director'
