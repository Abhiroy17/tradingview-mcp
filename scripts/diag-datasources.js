/**
 * Check what data sources exist on the chart and their shapes.
 */
import { getClient } from '../src/connection.js';
import { evaluate } from '../src/connection.js';

async function main() {
  await getClient();

  // Check what dataSources exist and what properties they have
  const info = await evaluate(`
    (function() {
      try {
        var chart = window.TradingViewApi._activeChartWidgetWV.value()._chartWidget;
        var model = chart.model().model();
        var sources = model.dataSources();
        var results = [];
        for (var i = 0; i < sources.length; i++) {
          var s = sources[i];
          var entry = { idx: i, type: s.constructor.name || 'unknown' };
          try { entry.metaInfo = s.metaInfo ? Object.keys(s.metaInfo()) : 'no metaInfo'; } catch(e) { entry.metaInfo = 'error: ' + e.message; }
          try { entry.is_price_study = s.metaInfo ? s.metaInfo().is_price_study : null; } catch(e) {}
          entry.has_reportData = typeof s.reportData === 'function' || typeof s.reportData === 'object';
          entry.has_performance = typeof s.performance === 'function';
          entry.has_ordersData = typeof s.ordersData === 'function';
          try { entry.title = s.title ? (typeof s.title === 'function' ? s.title() : s.title) : null; } catch(e) {}
          results.push(entry);
        }
        return results;
      } catch(e) { return { error: e.message, stack: e.stack?.slice(0, 200) }; }
    })()
  `);

  console.log('Data sources:', JSON.stringify(info, null, 2));
}

main().catch(e => { console.error('FATAL:', e.message); process.exit(1); });
