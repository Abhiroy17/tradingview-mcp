import { useEffect, useRef, useState, useCallback } from 'react';

export function useSSE(onMessage, enabled) {
  const [sseConnected, setSseConnected] = useState(false);
  const eventSourceRef = useRef(null);
  const reconnectTimerRef = useRef(null);

  const connect = useCallback(() => {
    if (eventSourceRef.current) {
      eventSourceRef.current.close();
    }

    const es = new EventSource('/api/events');

    es.onopen = () => {
      setSseConnected(true);
    };

    es.onmessage = (e) => {
      try {
        const payload = JSON.parse(e.data);
        onMessage(payload);
      } catch (err) {
        // Invalid JSON, ignore
      }
    };

    es.onerror = () => {
      setSseConnected(false);
      es.close();
      // Auto-reconnect after 3 seconds
      reconnectTimerRef.current = setTimeout(() => {
        if (enabled) connect();
      }, 3000);
    };

    eventSourceRef.current = es;
  }, [onMessage, enabled]);

  const reconnect = useCallback(() => {
    if (reconnectTimerRef.current) {
      clearTimeout(reconnectTimerRef.current);
    }
    connect();
  }, [connect]);

  useEffect(() => {
    // Check initial status
    fetch('/api/status')
      .then(r => r.json())
      .then(data => {
        if (data.monitoring) {
          connect();
        }
      })
      .catch(() => {});

    return () => {
      if (eventSourceRef.current) {
        eventSourceRef.current.close();
      }
      if (reconnectTimerRef.current) {
        clearTimeout(reconnectTimerRef.current);
      }
    };
  }, []);

  useEffect(() => {
    if (enabled && !eventSourceRef.current) {
      connect();
    }
  }, [enabled, connect]);

  return { sseConnected, reconnect };
}
