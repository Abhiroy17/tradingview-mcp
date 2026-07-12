/**
 * Phase 8.7 smoke test — runMatrixModes + scoreMultiTFCell.
 *
 * Run via:  node scripts/test-modes.js [symbol] [code]
 *
 * Examples:
 *   node scripts/test-modes.js                          # NSE:RELIANCE × ibs_india_swing
 *   node scripts/test-modes.js NSE:INFY                 # NSE:INFY × ibs_india_swing
 *   node scripts/test-modes.js NSE:TCS fibonacci_india_swing # custom strategy
 */
import 'dotenv/config';
import { runMatrixModes, INTRADAY_MATRIX, SWING_MATRIX } from '../src/engine/matrix-runner.js';
import { scoreMultiTFCell, rankCellsByMode, buildGenAIPayload, MODE_PROFILES } from '../src/engine/ranker-v2.js';

const symbol = process.argv[2] || 'NSE:RELIANCE';
const code = process.argv[3] || 'ibs_india_swing';
const mode = process.argv[4] || 'both';

console.log('=== Phase 8.7 Mode-Aware Scoring Smoke ===\n');
console.log('Symbol:', symbol, '| Code:', code, '| Mode:', mode);
console.log('Intraday matrix:', JSON.stringify(INTRADAY_MATRIX));
console.log('Swing matrix:   ', JSON.stringify(SWING_MATRIX));
console.log('Mode profiles:  ', JSON.stringify(MODE_PROFILES, null, 0));
console.log('');

const t0 = Date.now();

try {
  const cells = await runMatrixModes({
    cells: [{ code, symbol }],
    mode,
    provider: 'js',
    concurrency: 4,
    onProgress: ({ completed, total, code: c, symbol: s, tf, windowLabel, error }) => {
      const status = error ? 'FAIL' : 'ok';
      console.log(`  [${completed}/${total}] ${c} ${s} ${tf} × ${windowLabel} ${status}${error ? ': ' + error : ''}`);
    },
  });

  const elapsed = Date.now() - t0;
  console.log(`\nTotal elapsed: ${elapsed}ms`);

  const ranked = rankCellsByMode(cells, mode === 'swing' ? 'swing' : 'intraday');
  const scored = ranked[0];
  if (!scored?.rankingV2) {
    console.log('No ranking output');
    process.exit(1);
  }

  const r = scored.rankingV2;

  console.log('\n=== Cell rankings ===');
  console.log(`Code: ${scored.code} | Symbol: ${scored.symbol}`);
  console.log(`Intraday Score: ${r.intradayScore} (${r.intraday.confidence})`);
  console.log(`Swing Score:    ${r.swingScore} (${r.swing.confidence})`);
  console.log(`Total trades:   intraday=${r.intraday.totalTrades}, swing=${r.swing.totalTrades}`);
  console.log(`Backtests:      intraday=${r.intraday.backtestsPassed}/${countSubJobs(scored, 'intraday')}, swing=${r.swing.backtestsPassed}/${countSubJobs(scored, 'swing')}`);
  console.log(`Slope:          ${JSON.stringify(r.intraday.slope)}`);
  console.log(`Truncated:      intraday=${r.intraday.anyTruncated}, swing=${r.swing.anyTruncated}`);

  console.log('\n=== Per-TF detail ===');
  for (const [modeKey, modeBlock] of Object.entries({ intraday: r.intraday, swing: r.swing })) {
    console.log(`\n[${modeKey}]`);
    for (const [tf, det] of Object.entries(modeBlock.tfDetails || {})) {
      const tfScore = (det.score * 100).toFixed(0);
      console.log(`  ${tf}: score=${tfScore} trades=${det.trades} windows=${det.windowsScored}`);
      for (const [wl, wd] of Object.entries(det.windowDetail || {})) {
        if (wd.ok) {
          console.log(`    ${wl}: PF=${wd.profitFactor} WR=${wd.winRate}% DD=${wd.maxDrawdown}% trades=${wd.trades}${wd.bars_truncated ? ' [TRUNCATED]' : ''}`);
        } else {
          console.log(`    ${wl}: failed - ${wd.error}`);
        }
      }
    }
  }

  if (scored.provider_warnings?.length) {
    console.log('\n=== Provider warnings ===');
    for (const w of scored.provider_warnings) {
      console.log(`  ${w.tf} ${w.windowLabel}: ${w.message}`);
    }
  }

  console.log('\n=== GenAI payload ===');
  const genai = buildGenAIPayload(scored);
  console.log(JSON.stringify(genai, (k, v) => k === 'raw_grid' ? '[grid hidden]' : v, 2));

  console.log('\nDone.');
} catch (err) {
  console.error('FAILED:', err.message);
  console.error(err.stack);
  process.exit(1);
}

function countSubJobs(cell, mode) {
  const profile = MODE_PROFILES[mode];
  if (!profile) return 0;
  let n = 0;
  for (const tf of Object.keys(profile.tfWeights)) {
    n += Object.keys(profile.windowWeights).length;
  }
  return n;
}
