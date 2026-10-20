import { useMemo } from 'react';
import { config } from './config';
import { createSource, type VaultSource } from './source';
import { StoreProvider } from './lib/store';
import { useRoute } from './lib/route';
import { Shell } from './components/Shell';
import { AgentsScreen } from './screens/Agents';
import { ActivityScreen } from './screens/Activity';

function Screens() {
  const route = useRoute();
  return (
    <>
      <Shell screen={route.screen} />
      {route.screen === 'activity' ? <ActivityScreen route={route} /> : <AgentsScreen route={route} />}
    </>
  );
}

export function App({ source }: { source?: VaultSource }) {
  const src = useMemo(() => source ?? createSource(), [source]);
  return (
    <StoreProvider source={src} pollMs={config.pollMs}>
      <Screens />
    </StoreProvider>
  );
}
