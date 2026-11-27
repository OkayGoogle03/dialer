import { createContext, ReactNode, useContext } from 'react';
import { CallPopup } from './CallPopup';
import { AlertPrompt } from './AlertPrompt';
import { useSoftphone } from './useSoftphone';

export type Softphone = ReturnType<typeof useSoftphone>;

const Ctx = createContext<Softphone | null>(null);

/** One softphone for the whole signed-in app: it stays registered on every screen, so calls arrive (and carry on) wherever the user is. */
export function SoftphoneProvider({ children }: { children: ReactNode }) {
  const sp = useSoftphone();
  return (
    <Ctx.Provider value={sp}>
      {children}
      <AlertPrompt sp={sp} />
      <audio ref={sp.audio} autoPlay />
      <CallPopup sp={sp} />
    </Ctx.Provider>
  );
}

export function useSharedSoftphone(): Softphone {
  const sp = useContext(Ctx);
  if (!sp) throw new Error('useSharedSoftphone needs SoftphoneProvider');
  return sp;
}
