export interface AiSource {kind:'api'|string|'command';executable?:string;arguments_json?:string;allowed_hosts_json?:string;credential_profile?:'none'|string}
export interface AiClientDiscovery {
 kind:string;installed:boolean;executable:string|null;version:string|null;
 login:'detected'|'expired'|'not_detected';credential_source:'local'|'environment'|null;
 expires_at:string|null;default_model:string|null;models:Array<{id:string;name:string}>;models_observed_at:string|null;
}
