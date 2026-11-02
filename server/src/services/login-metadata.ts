import {isIP} from 'node:net';
import type {FastifyRequest} from 'fastify';

export interface LoginMetadata {ip:string|null;userAgent:string|null;kind?:'browser'|'internal'}

/** Vite replaces this header from its socket peer, including WS connections.
 * Remote, untrusted forwarding headers are not evidence of a client address. */
export function requestLoginMetadata(req:FastifyRequest):LoginMetadata {
  const peer=req.raw.socket?.remoteAddress||req.ip;
  const local=['127.0.0.1','::1','::ffff:127.0.0.1'].includes(peer);
  const forwarded=req.headers['x-agentmanager-client-ip'];
  const address=local&&typeof forwarded==='string'&&isIP(forwarded)?forwarded:peer;
  const ip=address?.startsWith('::ffff:')&&isIP(address.slice(7))===4?address.slice(7):address;
  return {ip:isIP(ip||'')?ip:null,userAgent:typeof req.headers['user-agent']==='string'?req.headers['user-agent'].slice(0,512):null};
}
