import type {EnvironmentCheck} from '../lib/api';
export function EnvironmentChecks({checks}:{checks:EnvironmentCheck[]}) {
 return <ul aria-label="环境预检结果" className="mt-2 space-y-1 text-sm">{checks.map((c,i)=><li key={i} role={c.ok?'status':'alert'} style={{color:c.ok?'var(--text-secondary)':'var(--danger, #dc2626)'}}>{c.ok?'✓':'✗'} {c.stage}：{c.message}</li>)}</ul>;
}
