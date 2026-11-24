// DSH serves browser plugins as ModuleLoader factories.
window.__ModuleLoader__.load({
  id: 'dsh-octoally-workspace',
  factory() {
    const channel = 'octoally:dsh/1';

    const providerChannel = 'octoally:dsh-providers/1';
    const providerNamespace = 'llm-pi-ai';
    const protocols = new Set(['openai-completions', 'openai-responses', 'anthropic-messages', 'google-generative-ai']);
    const providerId = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u;
    const modelId = /^[^\s\u0000-\u001f\u007f]{1,256}$/u;

    function endpoint(value) {
      if (typeof value !== 'string' || value.length > 2048) return;
      try {
        const url = new URL(value);
        if (['http:', 'https:'].includes(url.protocol) && !url.username && !url.password && !/[?#]/u.test(url.href)) return url.href;
      } catch { /* Invalid endpoint. */ }
    }

    async function providerSettings(remote) {
      const settings = await remote.settings.describe();
      if (!settings.ok) throw new Error('read');
      return {
        namespace: settings.value.namespaces.find(view => view.ns === providerNamespace),
        writable: settings.value.writable === true,
      };
    }

    async function listProviders(remote) {
      const [{ namespace, writable }, catalog] = await Promise.all([providerSettings(remote), remote.session.modelCatalog()]);
      if (!catalog.ok) throw new Error('read');
      const profiles = namespace?.value?.providers ?? {};
      const groups = new Map(catalog.value.groups.map(group => [group.id, group]));
      const providers = [...new Set([...Object.keys(profiles), ...groups.keys()])].map(id => {
        const profile = Object.hasOwn(profiles, id) ? profiles[id] : undefined;
        const group = groups.get(id);
        const models = new Map((group?.models ?? []).map(model => [model.id, {
          id: model.id, name: model.name, available: true,
        }]));
        for (const model of profile?.models ?? []) {
          if (!models.has(model.id)) models.set(model.id, { id: model.id, name: model.name, available: false });
        }
        return {
          id, name: profile?.displayName || group?.name || id, baseUrl: endpoint(profile?.baseURL),
          protocol: protocols.has(profile?.api) ? profile.api : undefined,
          editable: writable && !!profile && id.length <= 64 && providerId.test(id) && !!endpoint(profile.baseURL) && protocols.has(profile.api),
          models: [...models.values()],
        };
      });
      return { providers, revision: namespace?.revision, canCreate: writable && !!namespace };
    }

    async function saveProvider(remote, data) {
      const { draft, create, revision } = data;
      const baseURL = endpoint(draft?.baseUrl);
      if (!draft || typeof draft.id !== 'string' || draft.id.length > 64 || !providerId.test(draft.id)
        || ['constructor', 'prototype'].includes(draft.id)
        || typeof draft.name !== 'string' || !draft.name.trim() || draft.name.length > 128
        || !baseURL || !protocols.has(draft.protocol)
        || !Array.isArray(draft.models) || draft.models.length < 1 || draft.models.length > 100
        || !draft.models.every(id => typeof id === 'string' && modelId.test(id))
        || typeof draft.apiKey !== 'string' || draft.apiKey.length > 4096
        || typeof create !== 'boolean' || !Number.isSafeInteger(revision)) throw new Error('invalid');

      const { namespace, writable } = await providerSettings(remote);
      if (!writable || !namespace) throw new Error('unsupported');
      if (namespace.revision !== revision) throw new Error('conflict');
      const profiles = namespace.value?.providers ?? {};
      const profile = Object.hasOwn(profiles, draft.id) ? profiles[draft.id] : undefined;
      if (create) {
        const directory = await remote.llm.listConfigurableProviders();
        if (!directory.ok) throw new Error('read');
        if (profile || directory.value.some(item => item.provider === draft.id)) throw new Error('duplicate');
      } else if (!profile || !endpoint(profile.baseURL) || !protocols.has(profile.api)) {
        throw new Error('conflict');
      }

      const path = ['providers', draft.id];
      const existingModels = namespace.user?.providers?.[draft.id]?.models ?? profile?.models ?? [];
      const models = [...new Set(draft.models)].map(id => existingModels.find(model => model.id === id) ?? { id });
      const fields = { displayName: draft.name.trim(), baseURL, api: draft.protocol, models };
      // Stage a new key under a fresh reference so concurrent settings updates cannot replace a live key.
      const key = draft.apiKey.trim();
      let reference;
      if (key) {
        const bytes = crypto.getRandomValues(new Uint8Array(16));
        reference = 'OCTOALLY_' + Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('').toUpperCase();
        const stored = await remote.credentials.set(reference, key);
        if (!stored.ok) throw new Error('credential');
      }
      const ops = Object.entries(fields).map(([field, value]) => ({ op: 'set', path: [...path, field], value }));
      if (reference) ops.push({ op: 'set', path: [...path, 'apiKeyEnv'], value: reference });
      let saved;
      try {
        saved = await remote.settings.mutate(providerNamespace, ops, revision);
      } catch {
        // The Host may have committed despite a dropped response. Keep any referenced key usable.
        throw new Error('unknown');
      }
      if (!saved.ok) {
        if (reference) await remote.credentials.unset(reference).catch(() => {});
        throw new Error(saved.error.code === 'settings/conflict' ? 'conflict' : 'save');
      }
      const previous = profile?.apiKeyEnv;
      if (reference && /^OCTOALLY_[A-F0-9]{32}$/u.test(previous ?? '')
        && !Object.entries(profiles).some(([id, profile]) => id !== draft.id && profile?.apiKeyEnv === previous)) {
        await remote.credentials.unset(previous).catch(() => {});
      }
    }

    function apply(ctx) {
      const origins = window.__OCTOALLY_HARNESS_PARENT_ORIGINS__;
      if (window.parent === window || !Array.isArray(origins) || origins.length === 0) return;
      const workspaces = ctx.get('workspaces');
      const sessions = ctx.get('sessions');
      const navigation = ctx.get('uiWorkspace');
      const remote = ctx.get('remote');
      const supportsProviderManagement = !!(remote?.settings && remote?.credentials && remote?.llm && remote?.session);

      ctx.effect(() => {
        let disposed = false;
        let request;
        let stopRemembering;
        let providerRequest;
        function receive(event) {
          const data = event.data;
          if (event.source !== window.parent || !origins.includes(event.origin)
            || event.origin === window.location.origin || ![channel, providerChannel].includes(data?.channel)
            || typeof data.id !== 'string' || !/^[a-f0-9]{32}$/u.test(data.id)) return;

          const send = (type, payload = {}) => window.parent.postMessage({ channel: data.channel, type, id: data.id, ...payload }, event.origin);
          if (data.channel === providerChannel) {
            if (!supportsProviderManagement) return;
            if (data.type === 'hello') {
              if (providerRequest?.id !== data.id) providerRequest = { id: data.id, used: false };
              send('ready');
            } else if (providerRequest?.id === data.id && !providerRequest.used && ['list', 'save'].includes(data.type)) {
              providerRequest.used = true;
              void (data.type === 'list' ? listProviders(remote) : saveProvider(remote, data)).then(value => {
                if (!disposed) send('result', { value });
              }, error => {
                if (!disposed) send('error', { code: ['invalid', 'read', 'unsupported', 'conflict', 'duplicate', 'credential', 'save', 'unknown'].includes(error.message)
                  ? error.message : data.type === 'save' ? 'unknown' : 'read' });
              });
            }
            return;
          }
          if (data.type === 'hello') {
            if (workspaces.list.getSnapshot().phase !== 'ready' || sessions.list.getSnapshot().phase !== 'ready') return;
            if (request?.id !== data.id) request = { id: data.id, opened: false };
            send('ready', { modelSelection: !!remote?.session });
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
              const previousSession = previous && sessions.list.getSnapshot().byId[previous];
              const restore = previous && workspace.sessionIds.includes(previous) && !archived.includes(previous);
              if (restore && !(data.model && previousSession?.blank)) {
                navigation.openSession(previous);
              } else if (data.model !== undefined) {
                const { provider, model } = data.model ?? {};
                if (typeof provider !== 'string' || !/^[\w.:-]{1,128}$/u.test(provider)
                  || typeof model !== 'string' || !modelId.test(model) || !remote?.session) {
                  send('failed', { error: 'model' });
                  return;
                }
                const sessionId = await navigation.connectWorkspace(workspace.workspaceId);
                if (disposed || request !== current) return;
                try {
                  const selected = await remote.session.selectModel({ sessionId, provider, model });
                  if (!selected.ok) throw new Error('model');
                } catch {
                  if (!disposed && request === current) send('failed', { error: 'model' });
                  return;
                }
                if (disposed || request !== current) return;
                navigation.openSession(sessionId);
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

    return { inject: ['workspaces', 'sessions', 'uiWorkspace', 'remote', 'remote.settings', 'remote.credentials', 'remote.llm', 'remote.session'], apply };
  },
});
