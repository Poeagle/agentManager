import {beforeEach,describe,expect,it,vi} from 'vitest';
vi.mock('../src/services/session-manager.js',()=>({getSession:vi.fn(),isSessionActive:vi.fn(),reconnectSession:vi.fn(),recoverSessionOnAttach:vi.fn()}));
import * as manager from '../src/services/session-manager.js';
import {attachExistingSession} from '../src/services/session-attachment.js';
beforeEach(()=>{vi.resetAllMocks();vi.mocked(manager.getSession).mockReturnValue({id:'s',status:'detached'} as any);vi.mocked(manager.isSessionActive).mockReturnValue(false);});
describe('existing terminal attachment',()=>{
 it('is idempotent when another socket already restored the session',async()=>{vi.mocked(manager.isSessionActive).mockReturnValue(true);expect(await attachExistingSession('s')).toBe(true);expect(manager.reconnectSession).not.toHaveBeenCalled();});
 it('reattaches the surviving detached wrapper',async()=>{vi.mocked(manager.reconnectSession).mockResolvedValue(true);expect(await attachExistingSession('s')).toBe(true);expect(manager.reconnectSession).toHaveBeenCalledExactlyOnceWith('s');expect(manager.recoverSessionOnAttach).not.toHaveBeenCalled();});
 it('recovers a stale running record by checking its surviving terminal',async()=>{vi.mocked(manager.getSession).mockReturnValue({id:'s',status:'running'} as any);vi.mocked(manager.reconnectSession).mockResolvedValue(false);vi.mocked(manager.recoverSessionOnAttach).mockResolvedValue(true);expect(await attachExistingSession('s')).toBe(true);expect(manager.recoverSessionOnAttach).toHaveBeenCalledExactlyOnceWith('s');});
 it.each(['failed','completed','cancelled','pending','launching','released'])('never starts or revives a %s session',async status=>{vi.mocked(manager.getSession).mockReturnValue({id:'s',status} as any);expect(await attachExistingSession('s')).toBe(false);expect(manager.reconnectSession).not.toHaveBeenCalled();expect(manager.recoverSessionOnAttach).not.toHaveBeenCalled();});
 it('leaves a missing wrapper stopped',async()=>{vi.mocked(manager.reconnectSession).mockResolvedValue(false);vi.mocked(manager.recoverSessionOnAttach).mockResolvedValue(false);expect(await attachExistingSession('s')).toBe(false);});
});
