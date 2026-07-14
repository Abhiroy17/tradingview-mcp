import { screenUniverse } from '../src/engine/multibagger/index.js';

const result = await screenUniverse({
  universe: 'sec_media',
  topN: 0,
  concurrency: 2,
  onProgress: (p) => {
    if (p.phase === 'sector_restrict') console.log('[restrict]', p.message, 'source:', p.source);
    if (p.phase === 'db_prefilter') console.log('[db_pre]', p.message);
    if (p.phase === 'prefilter_done') console.log('[prefilter]', 'eligible:', p.eligible, 'excluded:', p.excluded);
    if (p.phase === 'early_mcap') console.log('[early_mcap]', p.message);
    if (p.phase === 'mcap_filter') console.log('[mcap]', p.message);
    if (p.phase === 'scored') console.log('[scored]', p.message);
  },
});

console.log('\nTotal results:', result.results?.length);
console.log('Symbols found:');
const list = result.results ? result.results : [];
list.forEach(r => console.log(' ', r.symbol, '- score:', r.multibaggerScore, '- tier:', r.tier));

const jd = list.find(r => r.symbol === 'NSE:JUSTDIAL');
console.log('\nJUSTDIAL found:', jd ? 'YES (score: ' + jd.multibaggerScore + ', tier: ' + jd.tier + ')' : 'NO');

// Check meta for excluded
if (result.meta) {
  console.log('\nMeta:', JSON.stringify(result.meta, null, 2));
}
