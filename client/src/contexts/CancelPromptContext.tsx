import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";

export interface Cancellable {
  id: string;
  label: string;
  onCancel: () => void;
}

interface CancelPromptContextValue {
  register: (cancellable: Cancellable) => void;
  unregister: (id: string) => void;
}

const CancelPromptContext = createContext<CancelPromptContextValue | null>(null);

export function useCancelPrompt() {
  const ctx = useContext(CancelPromptContext);
  if (!ctx) return null;
  return ctx;
}

export function CancelPromptProvider({ children }: { children: ReactNode }) {
  const [cancellable, setCancellable] = useState<Cancellable | null>(null);
  const [showOverlay, setShowOverlay] = useState(false);
  const cancellableRef = useRef<Cancellable | null>(null);
  cancellableRef.current = cancellable;

  const register = useCallback((c: Cancellable) => {
    setCancellable((prev) => (prev?.id === c.id ? prev : c));
  }, []);

  const unregister = useCallback((id: string) => {
    setCancellable((prev) => (prev?.id === id ? null : prev));
    setShowOverlay(false);
  }, []);

  useEffect(() => {
    const lusk = (window as any).lusk;
    if (!lusk?.onRequestCancelPrompt) return;
    lusk.onRequestCancelPrompt(() => {
      if (cancellableRef.current) setShowOverlay(true);
    });
  }, []);

  const handleConfirmCancel = useCallback(() => {
    if (cancellable) {
      cancellable.onCancel();
      setCancellable(null);
    }
    setShowOverlay(false);
  }, [cancellable]);

  const handleDismiss = useCallback(() => {
    setShowOverlay(false);
  }, []);

  return (
    <CancelPromptContext.Provider value={{ register, unregister }}>
      {children}
      {showOverlay && cancellable && (
        <div
          className="cancel-prompt-overlay"
          role="dialog"
          aria-modal="true"
          aria-labelledby="cancel-prompt-title"
        >
          <div className="cancel-prompt">
            <h3 id="cancel-prompt-title">Cancel {cancellable.label}?</h3>
            <p className="cancel-prompt-desc">
              Pressed Cmd+R — stop the current operation?
            </p>
            <div className="cancel-prompt-actions">
              <button className="secondary" onClick={handleDismiss}>
                Don&apos;t cancel
              </button>
              <button className="primary" onClick={handleConfirmCancel}>
                Cancel {cancellable.label}
              </button>
            </div>
          </div>
        </div>
      )}
    </CancelPromptContext.Provider>
  );
}
