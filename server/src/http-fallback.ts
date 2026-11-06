import type {FastifyInstance} from 'fastify';
import Router, {type HTTPMethod} from 'find-my-way';

/** Keep API errors out of the SPA/static wildcard, including method mismatches.
 * Use the router itself so parameterized paths and URL decoding stay consistent. */
export function installApiFallback(app: FastifyInstance): void {
  const router = Router();
  app.addHook('onRoute', route => {
    if (route.url.startsWith('/api/')) router.on((Array.isArray(route.method)?route.method:[route.method]).map(m=>m.toUpperCase()) as HTTPMethod[], route.url, () => {});
  });
  const methods: HTTPMethod[] = ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'];
  app.addHook('onRequest', async (req, reply) => {
    const url = req.url.split('?')[0];
    if (url !== '/api' && !url.startsWith('/api/')) return;
    const route = req.routeOptions.url;
    if (route?.startsWith('/api/')) return;
    const allow = methods.filter(method => {
      return !!router.find(method, url);
    });
    if (allow.length) return reply.header('Allow', allow.join(', ')).code(405).send({error: 'Method not allowed'});
    return reply.code(404).send({error: 'API route not found'});
  });
}
