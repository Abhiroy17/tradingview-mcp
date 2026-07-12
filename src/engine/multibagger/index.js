/**
 * Multibagger engine — public entry point.
 */

export { computeFScore } from './fscore.js';
export { scoreFundamentals, computeSectorMedians, DEFAULT_WEIGHTS } from './scorer.js';
export { screenUniverse, quickScreen, scoreSymbol, SCREEN_PRESETS, computePresetFit } from './screener.js';
export { generateAnalysis, generateNarrative } from './analysis.js';
