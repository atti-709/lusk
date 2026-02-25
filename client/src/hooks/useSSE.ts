import { useState, useEffect, useRef } from "react";
import type { ProjectState } from "@lusk/shared";

interface UseSSEResult {
  state: ProjectState | null;
  isConnected: boolean;
  error: string | null;
}

export function useSSE(sessionId: string | null): UseSSEResult {
  const [state, setState] = useState<ProjectState | null>(null);
  const [isConnected, setIsConnected] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const eventSourceRef = useRef<EventSource | null>(null);

  useEffect(() => {
    if (!sessionId) {
      setTimeout(() => {
        setState(null);
        setIsConnected(false);
        setError(null);
      }, 0);
      return;
    }

    // Clear stale state from previous session immediately but asyncly
    setTimeout(() => {
      setState(null);
      setIsConnected(false);
      setError(null);
    }, 0);

    const es = new EventSource(`/api/events/${sessionId}`);
    eventSourceRef.current = es;

    es.onopen = () => {
      setIsConnected(true);
      setError(null);
    };

    es.onmessage = (event) => {
      try {
        const data: ProjectState = JSON.parse(event.data);
        setState(data);
      } catch {
        // Ignore malformed messages
      }
    };

    es.onerror = () => {
      setIsConnected(false);
      if (es.readyState === EventSource.CLOSED) {
        setError("Connection closed");
      }
    };

    return () => {
      es.close();
      eventSourceRef.current = null;
    };
  }, [sessionId]);

  return { state, isConnected, error };
}
