import {sharedAgentStream} from './stream-hub.js';
import { UnsupportedAgentFeature, type AgentAdapter, type AgentDefinition, type AgentFeature } from './types.js';
/** Normalize optional ports once at registration. This is an explicit failure
 * policy, not an implementation of another provider's protocol. */
export function resolveAgent(definition: AgentDefinition): AgentAdapter {
    const id = definition.descriptor.id, unsupported = (feature: AgentFeature): never => { throw new UnsupportedAgentFeature(id, feature); };
    return {
        descriptor: definition.descriptor, identity: definition.identity ?? { read: session => session.native_session_id ?? null },
        history: { read: async () => null, ...definition.history }, runtime: { subscribe: () => () => { }, ...definition.runtime },
        input: { afterTerminalSubmit: async () => { }, ...definition.input }, stream:sharedAgentStream(definition.stream),
        controls: { read: async () => unsupported('controls'), validate: async () => unsupported('model'), apply: async () => unsupported('model'), ...definition.controls },
        telemetry: definition.telemetry ?? { read: async () => ({ usage: null, observed_at: null }) }, statistics: definition.statistics ?? { read: async () => [] },
        quota: definition.quota ?? { read: async () => unsupported('quota') }, retry: definition.retry ?? { retryable:()=>false,inspect: async () => unsupported('retry'), start: async () => unsupported('retry') },
        lifecycle: { preflight: async () => null, bind: async () => { }, compact: async () => unsupported('compact'), prepareFresh: async () => unsupported('newConversation'), release: async () => { }, interrupt: async () => { }, stopTurn: async () => unsupported('stopTurn'), ...definition.lifecycle },
        launch: { prepare: async () => unsupported('launch'), ready: async () => { }, ...definition.launch },
        commands: { configure: command => command, build: () => unsupported('launch'), permissions: command => command, sharedResources: () => unsupported('sharedResources'), ...definition.commands },
        management: {
            inspect: async () => unsupported('launch'),
            update: async () => unsupported('launch'),
            action: async () => unsupported('launch'),
            createProvider: async () => unsupported('launch'),
            updateProvider: async () => unsupported('launch'),
            deleteProvider: async () => unsupported('launch'),
            providerAction: async () => unsupported('launch'),
            readConfigFile: async () => unsupported('launch'),
            writeConfigFile: async () => unsupported('launch'),
            ...definition.management,
        },
    };
}
