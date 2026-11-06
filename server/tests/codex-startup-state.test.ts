import {expect,it} from 'vitest';
import {inferQuiescentSessionState} from '../src/services/session-state.js';
import {codexStartupConflict} from '../src/services/agents/codex/runtime.js';
it('recognizes the native daemon conflict before a rollout exists without treating it as an executing task',()=>{
 const state=inferQuiescentSessionState('Background server has incompatible feature settings\n1. Run without the daemon\n2. Restart the daemon\n3. Cancel');
 expect(state.processState).toBe('waiting_for_input');expect(codexStartupConflict(state.choices)).toBe(true);
 expect(codexStartupConflict(['1. Update dependency','2. Cancel'])).toBe(false);
});
