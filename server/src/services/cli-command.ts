import {getAgent} from './agents/index.js';
export {shellSingleQuote} from './agents/shell.js';
export {codexIdentityFlags} from './agents/codex/commands.js';
export type CliType=string;
export function withAllPermissions(command:string,cliType:CliType):string{return getAgent(cliType).commands.permissions(command);}
export function withSharedResourceInstructions(command:string,cliType:CliType,instructions?:string):string{return instructions?getAgent(cliType).commands.sharedResources(command,instructions):command;}
export function buildSessionCommand(task:string,direct=false,command='',cliType:CliType='claude',resumeId?:string,assignId?:string,bindingPath?:string,streamSocket:string|null|undefined=process.env.AGENTMANAGER_CODEX_STREAM_SOCKET):string{return getAgent(cliType).commands.build({task,direct,command,resumeId,assignId,bindingPath,streamSocket});}
