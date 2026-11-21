/** Recognize native wrappers only, never ordinary prose mentioning rules. */
export function automaticConversationContext(text:string):{kind:string;label:string;source:string}|null {
  const single=singleContext(text);if(single)return single;
  // Native startup can put AGENTS.md and environment in one user message.
  // Fold only when every part is a complete known wrapper. A trailing human
  // request must remain an ordinary visible user message.
  let rest=text.trim();const parts:Array<{kind:string;label:string;source:string}>=[];
  while(rest){
    const agents=/^# AGENTS\.md instructions for [^\r\n]+\r?\n\s*<INSTRUCTIONS>/.exec(rest);
    const opening=agents||/^<(environment_context|permissions|skills_instructions|task_notification|turn_aborted|octoally_shared_resources)(?:\s[^>]*)?>/.exec(rest);
    if(!opening)return null;
    const tag=agents?'INSTRUCTIONS':opening[1],end=rest.indexOf(`</${tag}>`,opening[0].length);
    if(end<0)return null;const length=end+tag.length+3,part=singleContext(rest.slice(0,length));if(!part)return null;
    parts.push(part);rest=rest.slice(length).trim();
  }
  return parts.length>1?{kind:'combined',label:[...new Set(parts.map(part=>part.label))].join(' · '),source:parts.map(part=>part.source).filter(Boolean).join(' · ')}:null;
}
function singleContext(text:string):{kind:string;label:string;source:string}|null {
  const value=text.trim();
  if(/^<octoally_shared_resources>\n[\s\S]*\n<\/octoally_shared_resources>$/.test(value)) {
    const file=/^凭据文件：([^\r\n]+)$/m.exec(value)?.[1]?.trim();
    return {kind:'shared_resources',label:'共享资源',source:file?`.env · ${file}`:''};
  }
  const agents=/^# AGENTS\.md instructions for ([^\r\n]+)\r?\n\s*<INSTRUCTIONS>\s*[\s\S]*<\/INSTRUCTIONS>\s*$/.exec(value);
  if(agents)return {kind:'project_rules',label:'项目规则',source:`AGENTS.md · ${agents[1].trim()}`};
  for(const [tag,kind,label] of [['environment_context','environment','运行环境'],['permissions','permissions','权限说明'],['skills_instructions','skills','技能说明'],['task_notification','task_notice','任务通知'],['turn_aborted','execution_notice','执行通知']]) {
    if(new RegExp(`^<${tag}(?:\\s[^>]*)?>[\\s\\S]*<\\/${tag}>$`).test(value))return {kind,label,source:''};
  }
  return null;
}
/** Native wrapper tags are transport metadata, not HTML. Remove only complete
 * recognized wrappers so Markdown remains visible without enabling raw HTML. */
export function automaticContextMarkdown(text:string):string {
 if(!automaticConversationContext(text))return text;
 let rest=text.trim();const parts:string[]=[];
 while(rest){
  const opening=/^# AGENTS\.md instructions for [^\r\n]+\r?\n\s*<INSTRUCTIONS>/.exec(rest)||/^<(environment_context|permissions|skills_instructions|task_notification|turn_aborted|octoally_shared_resources)(?:\s[^>]*)?>/.exec(rest);
  if(!opening)return text;
  const tag=opening[1]||'INSTRUCTIONS',end=rest.indexOf(`</${tag}>`,opening[0].length);
  if(end<0)return text;
  const original=rest.slice(0,end+tag.length+3),meta=singleContext(original);
  const body=rest.slice(opening[0].length,end).trim();
  // Structured environment XML is shown faithfully as a fenced Markdown block.
  const content=body.startsWith('<')?'```xml\n'+body+'\n```':body;
  parts.push(`## ${meta?.label||'自动信息'}\n\n${content}`);rest=rest.slice(end+tag.length+3).trim();
 }
 return parts.join('\n\n');
}
