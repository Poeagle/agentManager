// DSH serves browser plugins as ModuleLoader factories.
window.__ModuleLoader__.load({
  id: 'dsh-octoally-workspace',
  factory() {
    const channel = 'octoally:dsh/1';

    function apply(ctx) {
      const origins = window.__OCTOALLY_HARNESS_PARENT_ORIGINS__;
      if (window.parent === window || !Array.isArray(origins) || origins.length === 0) return;
      const workspaces = ctx.get('workspaces');
      const sessions = ctx.get('sessions');
      const navigation = ctx.get('uiWorkspace');

      ctx.effect(() => {
        let disposed = false;
        let request;
        let stopRemembering;
        function receive(event) {
          const data = event.data;
          if (event.source !== window.parent || !origins.includes(event.origin)
            || event.origin === window.location.origin || data?.channel !== channel
            || typeof data.id !== 'string' || !/^[a-f0-9]{32}$/u.test(data.id)) return;

          const send = (type, payload = {}) => window.parent.postMessage({ channel, type, id: data.id, ...payload }, event.origin);
          if (data.type === 'hello') {
            if (workspaces.list.getSnapshot().phase !== 'ready' || sessions.list.getSnapshot().phase !== 'ready') return;
            if (request?.id !== data.id) request = { id: data.id, opened: false };
            send('ready');
            return;
          }
          if (data.type !== 'open' || request?.id !== data.id || request.opened) return;
          request.opened = true;
          const { path } = data;
          if (typeof path !== 'string' || path.length > 4096 || !/^(?:\/|[a-z]:[\\/]|\\\\)/iu.test(path) || path.includes('\0')) {
            send('failed', { error: 'invalid-path' });
            return;
          }
          const current = request;
          void (async () => {
            try {
              const workspace = await workspaces.create({ path });
              if (disposed || request !== current) return;
              const key = 'octoally.harness.workspace:' + workspace.workspaceId;
              let previous;
              try { previous = window.sessionStorage.getItem(key); } catch { /* storage is optional */ }
              const archived = workspaces.list.getSnapshot().archivedSessionIds;
              if (previous && workspace.sessionIds.includes(previous) && !archived.includes(previous)) {
                navigation.openSession(previous);
              } else {
                await navigation.openWorkspace(workspace.workspaceId);
              }
              if (disposed || request !== current) return;
              stopRemembering?.();
              const remember = () => {
                const view = workspaces.list.getSnapshot().items.find(item => item.workspaceId === workspace.workspaceId);
                const currentSessions = sessions.list.getSnapshot().byId;
                const selected = view?.sessionIds.find(id => (currentSessions[id]?.retainedBy?.mainView ?? 0) > 0);
                if (selected) {
                  try { window.sessionStorage.setItem(key, selected); } catch { /* storage is optional */ }
                }
              };
              const stopSessions = sessions.list.subscribe(remember);
              const stopWorkspaces = workspaces.list.subscribe(remember);
              stopRemembering = () => { stopSessions(); stopWorkspaces(); };
              remember();
              send('opened');
            } catch (error) {
              if (!disposed && request === current) {
                send('failed', { error: error?.rpcError?.code === 'workspace/invalid-path' ? 'invalid-path' : 'workspace' });
              }
            }
          })();
        }

        window.addEventListener('message', receive);
        return () => {
          disposed = true;
          stopRemembering?.();
          window.removeEventListener('message', receive);
        };
      }, 'OctoAlly workspace binding');
    }

    return { inject: ['workspaces', 'sessions', 'uiWorkspace'], apply };
  },
});
