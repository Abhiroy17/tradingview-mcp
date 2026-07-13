import { useQuery } from '@tanstack/react-query';

/**
 * React Query hook for multibagger analysis.
 * Caches results per symbol, auto-deduplicates in-flight requests.
 */
export function useMultibaggerAnalysis(symbol, options = {}) {
  return useQuery({
    queryKey: ['multibagger', 'analysis', symbol],
    queryFn: async () => {
      const res = await fetch(`/api/v2/multibagger/analysis?symbol=${encodeURIComponent(symbol)}`);
      if (!res.ok) throw new Error(`Analysis failed: ${res.status} ${res.statusText}`);
      let data;
      try {
        data = await res.json();
      } catch {
        throw new Error('Server returned invalid response. Please retry.');
      }
      if (!data.success) throw new Error(data.error || 'Analysis failed');
      return data.analysis;
    },
    enabled: !!symbol,
    staleTime: 1000 * 60 * 10, // 10 min — fundamental data doesn't change fast
    gcTime: 1000 * 60 * 30,    // 30 min cache
    retry: 2,
    retryDelay: (attempt) => Math.min(1000 * 2 ** attempt, 8000),
    ...options,
  });
}

/**
 * React Query hook for multibagger screening (basket scan).
 */
export function useMultibaggerScreen(basket, filters, options = {}) {
  return useQuery({
    queryKey: ['multibagger', 'screen', basket, filters],
    queryFn: async () => {
      const body = { universe: basket || 'large_cap' };
      if (filters) body.filters = filters;
      const res = await fetch('/api/v2/multibagger/screen', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error(`Screen failed: ${res.status} ${res.statusText}`);
      let data;
      try {
        data = await res.json();
      } catch {
        throw new Error('Server returned invalid response. Please retry.');
      }
      if (!data.success) throw new Error(data.error || 'Screen failed');
      return data;
    },
    enabled: !!basket,
    staleTime: 1000 * 60 * 5,
    gcTime: 1000 * 60 * 15,
    retry: 1,
    retryDelay: 3000,
    ...options,
  });
}
