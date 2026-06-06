import { FastifyPluginAsync } from 'fastify';
import { subscribe } from '../services/event-store.js';
import { userOwnsProject } from '../auth.js';

/**
 * WebSocket stream for real-time events to the dashboard.
 * Each connection only receives events for projects owned by the logged-in user.
 */
export const streamRoutes: FastifyPluginAsync = async (app) => {
  app.get('/stream', { websocket: true }, (socket, req) => {
    const userId = req.user?.id;
    // Subscribe to events
    const unsubscribe = subscribe((event: any) => {
      // Only forward events belonging to the user's projects. Events without a
      // project_id are system-level (e.g. pings) and pass through.
      if (event.project_id && (!userId || !userOwnsProject(userId, event.project_id))) return;
      try {
        socket.send(JSON.stringify(event));
      } catch {
        // Socket closed
      }
    });

    socket.on('close', () => {
      unsubscribe();
    });

    // Send initial ping
    socket.send(JSON.stringify({ type: 'connected', timestamp: new Date().toISOString() }));
  });
};
