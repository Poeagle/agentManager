/** Recognize native wrappers only, never ordinary prose mentioning rules. */
export function automaticConversationContext(text:string):{kind:string;label:string;source:string}|null {
  const value=text.trim();
  const agents=/^# AGENTS\.md instructions for ([^\r\n]+)\r?\n\s*<INSTRUCTIONS>\s*[\s\S]*<\/INSTRUCTIONS>\s*$/.exec(value);
  if(agents)return {kind:'project_rules',label:'项目规则',source:`AGENTS.md · ${agents[1].trim()}`};
  for(const [tag,kind,label] of [['environment_context','environment','运行环境'],['permissions','permissions','权限说明'],['skills_instructions','skills','技能说明'],['task_notification','task_notice','任务通知'],['turn_aborted','execution_notice','执行通知']]) {
    if(new RegExp(`^<${tag}(?:\\s[^>]*)?>[\\s\\S]*<\\/${tag}>$`).test(value))return {kind,label,source:''};
  }
  return null;
}
