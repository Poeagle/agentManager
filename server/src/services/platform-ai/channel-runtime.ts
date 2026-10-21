import { EventEmitter } from 'events';

export interface ChannelConnection {
  state: 'connecting' | 'authenticating' | 'connected' | 'reconnecting' | 'disconnected' | 'error' | 'displaced';
  message: string;
  updated_at: string;
}
export interface BotTransport {
  status: ChannelConnection;
  deliver(chatId: string, content: string, context: Record<string, unknown>, deliveryId: string): Promise<void>;
}
const transports = new Map<string, BotTransport>();
const changes = new EventEmitter();
export function getBotTransport(id: string): BotTransport | undefined { return transports.get(id); }
export function setBotTransport(id: string, transport?: BotTransport): void {
  if (transport) transports.set(id, transport); else transports.delete(id);
}
export function channelsChanged(): void { changes.emit('change'); }
export function subscribeChannelChanges(listener: () => void): () => void {
  changes.on('change', listener);
  return () => changes.off('change', listener);
}
