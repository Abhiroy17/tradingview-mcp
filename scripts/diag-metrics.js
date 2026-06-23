/**
 * Check the raw shape of reportData.performance.all from the strategy on chart.
 */
import { getClient, evaluate } from '../src/connection.js';

async function main() {
  await getClient();

  const CHART_API = 'window.TradingViewApi._activeChartWidgetWV.value()';

  const info = await evaluate(`
    (function() {
      try {
        var chart = ${CHART_API}._chartWidget;
        var sources = chart.model().model().dataSources();
        var strat = null;
        for (var i = 0; i < sources.length; i++) {
          var s = sources[i];
          if (s.metaInfo && s.metaInfo().is_price_study === false && s.reportData) { strat = s; break; }
        }
        if (!strat) return { error: 'No strategy found' };

        var rd = typeof strat.reportData === 'function' ? strat.reportData() : strat.reportData;
        if (rd && typeof rd.value === 'function') rd = rd.value();

        var perf = rd && rd.performance;
        if (!perf) return { error: 'No performance in reportData', rdKeys: Object.keys(rd || {}) };

        var allPerf = perf.all;
        if (!allPerf) return { error: 'No performance.all', perfKeys: Object.keys(perf) };

        // Enumerate performance.all keys and their shapes
        var result = {};
        var keys = Object.keys(allPerf);
        for (var i = 0; i < keys.length; i++) {
          var k = keys[i];
          var v = allPerf[k];
          if (v && typeof v === 'object') {
            result[k] = { type: 'object', keys: Object.keys(v).slice(0, 5) };
            if (typeof v.value !== 'undefined') result[k].value = v.value;
            if (typeof v.v !== 'undefined') result[k].v = v.v;
          } else {
            result[k] = v;
          }
        }
        return { perfAllKeys: keys, samples: result };
      } catch(e) { return { error: e.message }; }
    })()
  `);

  console.log(JSON.stringify(info, null, 2));
}

main().catch(e => { console.error('FATAL:', e.message); process.exit(1); });
