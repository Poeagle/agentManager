import type {FastifyInstance} from 'fastify';
import {authRoutes} from './auth.js';
import {userRoutes} from './users.js';
import {rbacRoutes} from './rbac.js';
import {eventRoutes} from './events.js';
import {hooksRoutes} from './hooks.js';
import {sessionRoutes} from './sessions.js';
import {taskRoutes} from './tasks.js';
import {streamRoutes} from './stream.js';
import {projectRoutes} from './projects.js';
import {terminalRoutes} from './terminal.js';
import {fileRoutes} from './files.js';
import {gitRoutes} from './git.js';
import {agentRoutes} from './agent.js';
import {settingsRoutes} from './settings.js';
import {sharedResourceRoutes} from './shared-resources.js';
import {promptEnhancerRoutes} from './prompt-enhancer.js';
import {platformAiRoutes} from './platform-ai.js';
import {skillsRoutes} from './skills.js';
import {userStateRoutes} from './user-state.js';
import {scheduledTaskRoutes} from './scheduled-tasks.js';

/** Explicit route inventory shared by startup and reachability checks. */
export const apiRoutePlugins = {authRoutes, userRoutes, rbacRoutes, eventRoutes, hooksRoutes, sessionRoutes, taskRoutes, streamRoutes, projectRoutes, terminalRoutes, fileRoutes, gitRoutes, agentRoutes, settingsRoutes, sharedResourceRoutes, promptEnhancerRoutes, platformAiRoutes, skillsRoutes, userStateRoutes, scheduledTaskRoutes};
export async function registerApiRoutes(app:FastifyInstance):Promise<void> {
 for(const plugin of Object.values(apiRoutePlugins))await app.register(plugin,{prefix:'/api'});
}
