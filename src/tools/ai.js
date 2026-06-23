import { z } from 'zod';
import { jsonResult } from './_format.js';

const DASHBOARD_URL = 'http://localhost:3456';

export function registerAiTools(server) {
  server.tool('tv_briefing_get', 'Get a full quant briefing for a symbol: regime detection, indicators, top-ranked strategies with backtests, recent alerts, and a markdown prompt. Requires dashboard running (npm run dashboard).', {
    symbol: z.string().describe('Symbol to analyze (e.g., "NSE:RELIANCE", "AMEX:SOXS")'),
    switch_first: z.boolean().optional().describe('Switch chart to symbol before analysis (default true)'),
  }, async ({ symbol, switch_first }) => {
    try {
      const res = await fetch(`${DASHBOARD_URL}/api/ai/snapshot`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ symbol, switchFirst: switch_first }),
      });
      const data = await res.json();
      if (!data.success) return jsonResult(data, true);
      // Return the markdown prompt as primary content + structured data
      return {
        content: [
          { type: 'text', text: data.prompt },
          { type: 'text', text: `\n\n---\n**Feed cursor**: ${data.feedCursor} (pass to tv_live_feed_get as "since" to get new events)` },
        ],
      };
    } catch (err) {
      return jsonResult({ success: false, error: err.message, hint: 'Dashboard must be running on port 3456. Start it with: npm run dashboard' }, true);
    }
  });

  server.tool('tv_live_feed_get', 'Get live events (alerts, scanner signals, price alerts) since a cursor. Call repeatedly to "stream" data into chat. Requires dashboard running.', {
    since: z.number().optional().describe('Sequence cursor from last call (0 = get all available). Save the returned cursor for next call.'),
    types: z.array(z.string()).optional().describe('Filter event types: "alert", "scanner_result", "price_alert", "scanner_complete", "watchlist_update". Default: all.'),
    limit: z.number().optional().describe('Max events to return (default 200, max 500)'),
  }, async ({ since, types, limit }) => {
    try {
      const params = new URLSearchParams();
      if (since != null) params.set('since', String(since));
      if (limit != null) params.set('limit', String(limit));
      if (types?.length) params.set('types', types.join(','));

      const res = await fetch(`${DASHBOARD_URL}/api/ai/feed?${params}`);
      const data = await res.json();
      if (!data.success) return jsonResult(data, true);

      if (data.events.length === 0) {
        return { content: [{ type: 'text', text: `No new events since seq ${since || 0}. Cursor: ${data.cursor}. Call again later with since=${data.cursor}.` }] };
      }

      const summary = data.events.map(e => {
        const ts = new Date(e.ts).toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata', hour12: false });
        const d = e.data || {};
        if (e.type === 'alert') return `[${ts}] ${d.type || 'ALERT'} ${d.symbol || ''} — ${d.msg || d.reason || ''}`;
        if (e.type === 'scanner_result') return `[${ts}] SCAN ${d.symbol || ''} → ${d.signal || 'HOLD'} (${d.strategy || 'auto'})`;
        if (e.type === 'price_alert') return `[${ts}] PRICE ${d.symbol || ''} ${d.condition || ''} ${d.price || ''}`;
        return `[${ts}] ${e.type} ${JSON.stringify(d).slice(0, 100)}`;
      }).join('\n');

      return { content: [{ type: 'text', text: `## Live Feed (${data.count} events, cursor: ${data.cursor})\n\n${summary}\n\n---\nNext call: tv_live_feed_get(since=${data.cursor})` }] };
    } catch (err) {
      return jsonResult({ success: false, error: err.message, hint: 'Dashboard must be running on port 3456. Start it with: npm run dashboard' }, true);
    }
  });
}
