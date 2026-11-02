export interface AiSource {kind:'api'|'codex'|'claude'|'command';executable?:string;arguments_json?:string;allowed_hosts_json?:string;credential_profile?:'none'|'codex'|'claude'}
