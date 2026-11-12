import {realpathSync} from 'fs';

const disabledHooksPath=process.platform==='win32'?'NUL':'/dev/null';
/** Trust only the explicitly authorized project directory and disable executable hooks. */
export function gitConfig(projectPath?:string):Array<[string,string]> {
  return [['core.hooksPath',disabledHooksPath],['core.fsmonitor','false'],...projectPath?[['safe.directory',realpathSync(projectPath)] as [string,string]]:[]];
}
export function safeGitEnv(projectPath?:string):NodeJS.ProcessEnv {
  const settings=gitConfig(projectPath);
  const env:NodeJS.ProcessEnv={...process.env,GIT_CONFIG_COUNT:String(settings.length),GIT_TERMINAL_PROMPT:'0'};
  settings.forEach(([key,value],index)=>{env[`GIT_CONFIG_KEY_${index}`]=key;env[`GIT_CONFIG_VALUE_${index}`]=value;});
  return env;
}
