import { createServer, type Server } from 'http';
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { delimiter, join } from 'path';
import { createRequire } from 'module';
import { spawn } from 'child_process';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WebSocketServer } from 'ws';
import { config } from '../src/config.js';
import {
  ensureNativeCodexEngine,
  inspectNativeCodexEngine,
  nativeCodexEngineSocket,
  restartNativeCodexEngine,
  stopNativeCodexEngine,
} from '../src/services/agents/codex/native-engine.js';
import { configuredCodexEngines } from '../src/services/agents/codex/engine-context.js';
import { codexManagement } from '../src/services/agents/codex/management.js';
import { managedCodexSocket } from '../src/services/agents/codex/provider-config.js';
import { updateAgentManagement } from '../src/services/agents/management-store.js';
import { capabilities } from '../src/services/agents/types.js';
import { createTestDatabase } from './helpers/database.js';

const require = createRequire(import.meta.url);

describe('AgentManager-managed Codex Engines', () => {
  let root = '';
  let server: Server | null = null;
  let sockets: WebSocketServer | null = null;
  let cleanupDatabase: (() => void) | null = null;
  let enginePids: number[] = [];
  const priorTakeover = config.takeoverCodexLaunchAgents;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'codex-native-engine-'));
    enginePids = [];
    config.takeoverCodexLaunchAgents = false;
  });

  afterEach(async () => {
    if (sockets) {
      for (const socket of sockets.clients) socket.terminate();
      await new Promise<void>(resolve => sockets!.close(() => resolve()));
    }
    if (server) {
      await new Promise<void>(resolve => server!.close(() => resolve()));
    }
    cleanupDatabase?.();
    vi.unstubAllEnvs();
    for (const pid of enginePids) {
      try { process.kill(pid, 'SIGKILL'); } catch { /* fixture already stopped */ }
    }
    config.takeoverCodexLaunchAgents = priorTakeover;
    rmSync(root, { recursive: true, force: true });
  });

  it('reports a live native Engine as managed when AgentManager owns its metadata', async () => {
    const socket = join(root, 'codex.sock');
    vi.stubEnv('AGENTMANAGER_CODEX_STREAM_SOCKET', socket);
    server = createServer();
    sockets = new WebSocketServer({ server });
    await new Promise<void>(resolve => server!.listen(socket, resolve));
    writeFileSync(join(root, 'engine.json'), JSON.stringify({
      owner: 'agentmanager',
      pid: process.pid,
      socket,
      startedAt: '2026-11-09T00:00:00.000Z',
      executable: '/test/codex',
    }));

    expect(nativeCodexEngineSocket()).toBe(socket);
    expect(inspectNativeCodexEngine()).toMatchObject({
      socket,
      pid: process.pid,
      startedAt: '2026-11-09T00:00:00.000Z',
      status: 'ready',
      managed: true,
    });
  });

  it('prefers an AgentManager-managed Provider route over a legacy environment route', () => {
    const database = createTestDatabase();
    cleanupDatabase = database.cleanup;
    mkdirSync(join(database.dir, 'providers'));
    updateAgentManagement('codex', current => ({
      ...current,
      providers: [{
        id: 'xindu',
        name: 'xindu',
        kind: 'responses',
        enabled: true,
        fields: {
          baseUrl: 'https://example.com/v1',
          models: ['model-a'],
        },
      }],
    }));
    vi.stubEnv('AGENTMANAGER_CODEX_PROVIDER_ENGINES', JSON.stringify([{
      provider: 'xindu',
      socket: join(root, 'legacy.sock'),
      models: ['model-a'],
    }]));

    const route = configuredCodexEngines().find(engine => engine.provider === 'xindu');
    expect(route?.socket).toBe(managedCodexSocket('xindu'));
  });

  it('updates duplicate model ids only in the selected Provider catalog', async () => {
    const database = createTestDatabase();
    cleanupDatabase = database.cleanup;
    const nativeHome = join(database.dir, 'native');
    const providerHome = join(database.dir, 'provider');
    mkdirSync(nativeHome);
    mkdirSync(providerHome);
    const catalog = () => JSON.stringify({ models: [{
      slug: 'shared-model',
      display_name: 'Shared Model',
      context_window: 100,
      max_context_window: 100,
      effective_context_window_percent: 90,
      input_modalities: ['text'],
    }] });
    const nativeCatalog = join(nativeHome, 'models.json');
    const providerCatalog = join(providerHome, 'model-catalog.json');
    writeFileSync(nativeCatalog, catalog());
    writeFileSync(providerCatalog, catalog());
    writeFileSync(join(nativeHome, 'config.toml'), `model_catalog_json = ${JSON.stringify(nativeCatalog)}\n`);
    writeFileSync(join(providerHome, 'config.toml'), `model_catalog_json = ${JSON.stringify(providerCatalog)}\n`);
    vi.stubEnv('CODEX_HOME', nativeHome);
    updateAgentManagement('codex', current => ({
      ...current,
      providers: [{
        id: 'provider-a',
        name: 'Provider A',
        kind: 'responses',
        enabled: true,
        fields: {
          baseUrl: 'https://example.com/v1',
          codexHome: providerHome,
          models: ['shared-model'],
        },
      }],
    }));
    const management = codexManagement({
      id: 'codex',
      label: 'Codex',
      sessionHost: 'terminal',
      capabilities: capabilities(['history', 'runtime', 'input', 'stream']),
      presentation: { icon: 'codex', color: '#000' },
    });

    await management.updateModelConfigs?.([{
      provider: 'provider-a',
      model: 'shared-model',
      contextWindow: 200,
    }]);

    expect(JSON.parse(readFileSync(nativeCatalog, 'utf8')).models[0].context_window).toBe(100);
    expect(JSON.parse(readFileSync(providerCatalog, 'utf8')).models[0].context_window).toBe(200);
  });

  it('finds and removes an orphan Engine when neither socket nor metadata remains', async () => {
    const database = createTestDatabase();
    cleanupDatabase = database.cleanup;
    const bin = join(root, 'bin');
    const socket = join(root, 'engine', 'codex.sock');
    mkdirSync(bin);
    const executable = join(bin, 'codex');
    const wsModule = require.resolve('ws');
    writeFileSync(executable, `#!${process.execPath}
const {createServer}=require('http');
const {WebSocketServer}=require(${JSON.stringify(wsModule)});
const {unlinkSync}=require('fs');
if(process.env.FAKE_ORPHAN==='1'){setInterval(()=>{},1000);}else{
  const args=process.argv.slice(2),listen=args.indexOf('--listen');
  const socket=args[listen+1].replace(/^unix:\\/\\//,'');
  const server=createServer(),wss=new WebSocketServer({server});
  const close=()=>{for(const client of wss.clients)client.terminate();server.close(()=>{try{unlinkSync(socket)}catch{}process.exit(0)});};
  process.once('SIGTERM',close);process.once('SIGINT',close);server.listen(socket);
}
`, { mode: 0o755 });
    updateAgentManagement('codex', current => ({
      ...current,
      defaults: { ...current.defaults, nativeEngineCommand: executable },
    }));
    vi.stubEnv('AGENTMANAGER_CODEX_STREAM_SOCKET', socket);
    vi.stubEnv('PATH', `${bin}${delimiter}${process.env.PATH || ''}`);
    const orphan = spawn(executable, ['app-server', '--listen', `unix://${socket}`], {
      detached: true,
      env: { ...process.env, FAKE_ORPHAN: '1' },
      stdio: 'ignore',
    });
    orphan.unref();
    enginePids.push(orphan.pid!);
    await new Promise(resolve => setTimeout(resolve, 100));

    const managed = await ensureNativeCodexEngine(false);

    expect(managed.status).toBe('ready');
    expect(managed.pid).not.toBe(orphan.pid);
    expect(() => process.kill(orphan.pid!, 0)).toThrow();
    enginePids.push(managed.pid!);
    await stopNativeCodexEngine();
  }, 15_000);

  it('starts, adopts, restarts, and stops a detached native Engine', async () => {
    const bin = join(root, 'bin');
    const socket = join(root, 'engine', 'codex.sock');
    mkdirSync(bin);
    const executable = join(bin, 'codex');
    const database = createTestDatabase();
    cleanupDatabase = database.cleanup;
    updateAgentManagement('codex', current => ({
      ...current,
      defaults: {
        ...current.defaults,
        nativeEngineCommand: executable,
        nativeEngineArgs: ['-c', 'feature.test=true'],
      },
    }));
    const wsModule = require.resolve('ws');
    writeFileSync(executable, `#!${process.execPath}
const {createServer}=require('http');
const {WebSocketServer}=require(${JSON.stringify(wsModule)});
const {unlinkSync,writeFileSync}=require('fs');
const args=process.argv.slice(2);
writeFileSync(${JSON.stringify(join(root,'args.json'))},JSON.stringify(args));
const listen=args.indexOf('--listen');
const socket=args[listen+1].replace(/^unix:\\/\\//,'');
const server=createServer();
const wss=new WebSocketServer({server});
const close=()=>{for(const client of wss.clients)client.terminate();server.close(()=>{try{unlinkSync(socket)}catch{}process.exit(0)});};
process.once('SIGTERM',close);
process.once('SIGINT',close);
server.listen(socket);
`, { mode: 0o755 });
    chmodSync(executable, 0o755);
    vi.stubEnv('AGENTMANAGER_CODEX_STREAM_SOCKET', socket);
    vi.stubEnv('PATH', `${bin}${delimiter}${process.env.PATH || ''}`);

    const first = await ensureNativeCodexEngine(false);
    expect(first).toMatchObject({ status: 'ready', managed: true });
    expect(first.pid).toBeTypeOf('number');
    enginePids.push(first.pid!);
    expect(JSON.parse(readFileSync(join(root, 'args.json'), 'utf8'))).toEqual(expect.arrayContaining([
      'app-server',
      '--listen',
      `unix://${socket}`,
      '-c',
      'feature.test=true',
    ]));

    const second = await restartNativeCodexEngine();
    expect(second).toMatchObject({ status: 'ready', managed: true });
    expect(second.pid).not.toBe(first.pid);
    expect(() => process.kill(first.pid!, 0)).toThrow();
    enginePids.push(second.pid!);

    await stopNativeCodexEngine();
    expect(inspectNativeCodexEngine()).toMatchObject({
      socket,
      pid: null,
      managed: false,
    });
    expect(() => process.kill(second.pid!, 0)).toThrow();
  }, 15_000);
});
