import type {AiConfig} from './config.js';
/** Only complete, unambiguous read-only questions qualify. Attachments, compound
 * requests and normal workflow instructions still go through the model loop. */
export function quickQuery(text:string):'projects'|'model'|null {
 const input=text.trim().replace(/[?？!！。]+$/u,'').trim();
 if(/^(?:请|帮我)?(?:现在|当前|目前)?(?:有哪些|有什么|列出(?:所有|全部|可访问的)?|查看(?:所有|全部|可访问的)?)项目(?:呢|啊|呀)?$/u.test(input)||/^(?:现在|当前|目前)?项目有哪些$/u.test(input)||/^(?:list|show)(?: me)?(?: all| available| accessible)? projects$/i.test(input))return 'projects';
 if(/^(?:请问)?你(?:现在|当前)?(?:是(?:什么|哪个|哪种)|用的?是(?:什么|哪个|哪种))模型(?:呢|啊|呀)?$/u.test(input)||/^what model are you(?: using)?$/i.test(input))return 'model';
 return null;
}
const escape=(text:string)=>text.replace(/[\r\n]/g,' ').replace(/([\\`*_\[\]<>])/g,'\\$1');
export function configuredModelReply(config:AiConfig){const sources={api:'外部兼容 API',codex:'服务器 Codex 客户端',claude:'服务器 Claude 客户端',command:'自定义 AI 适配器'};return `当前平台配置使用${sources[config.source?.kind||'api']}，模型为 **${escape(config.model||'客户端默认模型（未指定名称）')}**。`;}
export function projectListReply(result:any):string|null {
 if(!Array.isArray(result?.projects)||typeof result.total!=='number'||result.error)return null;
 if(!result.total)return '当前没有可访问的项目。';
 return `当前可访问的项目共有 **${result.total}** 个${result.has_more?'（以下展示前 100 个）':''}：\n\n`+result.projects.map((project:any)=>`- ${escape(String(project.name))}`).join('\n');
}
