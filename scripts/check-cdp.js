import CDP from 'chrome-remote-interface';

const targets = await (await fetch('http://localhost:9222/json/list')).json();
const ct = targets.find(t => t.type === 'page' && /tradingview\.com\/chart/i.test(t.url));
if (!ct) { console.log('No chart target found'); process.exit(1); }
console.log('Target:', ct.title.slice(0, 60));
console.log('URL:', ct.url.slice(0, 80));

const c = await CDP({ host: 'localhost', port: 9222, target: ct.id });
await c.Runtime.enable();

const r1 = await c.Runtime.evaluate({ expression: 'typeof window.TradingViewApi', returnByValue: true });
console.log('TradingViewApi type:', r1.result.value);

if (r1.result.value === 'undefined') {
  // Check alternative paths
  const r2 = await c.Runtime.evaluate({ expression: 'typeof window.TradingView', returnByValue: true });
  console.log('TradingView type:', r2.result.value);
  const r3 = await c.Runtime.evaluate({ expression: 'typeof window.tvWidget', returnByValue: true });
  console.log('tvWidget type:', r3.result.value);
  const r4 = await c.Runtime.evaluate({ expression: 'Object.keys(window).filter(k => /trading|chart|widget/i.test(k)).join(", ")', returnByValue: true });
  console.log('Matching window keys:', r4.result.value || '(none)');
} else {
  const r5 = await c.Runtime.evaluate({ expression: 'Object.keys(window.TradingViewApi).slice(0, 15).join(", ")', returnByValue: true });
  console.log('API keys:', r5.result.value);
  const r6 = await c.Runtime.evaluate({ expression: 'window.TradingViewApi._activeChartWidgetWV ? "EXISTS" : "MISSING"', returnByValue: true });
  console.log('_activeChartWidgetWV:', r6.result.value);
}

await c.close();
