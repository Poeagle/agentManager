import type {FastifyPluginAsync} from 'fastify';
import {z} from 'zod';
import {requirePermission} from '../services/rbac.js';
import {userOwnsProject} from '../auth.js';
import {listNotifications,markNotificationsRead,dismissNotifications,notificationPreferences,saveNotificationPreferences} from '../services/notifications.js';
import {NotificationObserver} from '../services/notification-observer.js';
import {getDb} from '../db/index.js';

const querySchema=z.object({filter:z.enum(['pending','unread','all']).optional(),project_id:z.string().min(1).max(256).optional(),before:z.coerce.number().int().positive().optional()}).strict();
const readSchema=z.object({ids:z.array(z.number().int().positive()).max(200).default([]),through_id:z.number().int().positive().optional(),project_id:z.string().min(1).max(256).optional()}).strict().refine(value=>value.ids.length||value.through_id,{message:'请选择要标记的通知'});
const preferencesSchema=z.object({muted_project_ids:z.array(z.string().min(1).max(256)).max(1000)}).strict();

/** Personal dashboard routes. Sending input continues through the original
 * authenticated session APIs, including their current permissions and guards. */
export const notificationRoutes:FastifyPluginAsync=async app=>{
  const observer=new NotificationObserver(error=>app.log.warn({err:error},'Notification observer failed'));
  app.addHook('onReady',async()=>observer.start());
  app.addHook('onClose',async()=>observer.stop());
  app.get('/notifications',async(req,reply)=>{
    if(!requirePermission(req,reply,'agent_api'))return reply;
    const parsed=querySchema.safeParse(req.query);
    if(!parsed.success)return reply.code(400).send({error:'通知查询参数无效'});
    return reply.header('Cache-Control','private, no-store').send({...listNotifications(req.user!.id,parsed.data),monitoring_limited:observer.limited(req.user!.id)});
  });
  app.post('/notifications/read',async(req,reply)=>{
    if(!requirePermission(req,reply,'agent_api'))return reply;
    const parsed=readSchema.safeParse(req.body);
    if(!parsed.success)return reply.code(400).send({error:'通知标识无效'});
    markNotificationsRead(req.user!.id,parsed.data.ids,parsed.data.through_id,parsed.data.project_id);
    return {ok:true};
  });
  app.post('/notifications/dismiss',async(req,reply)=>{
    if(!requirePermission(req,reply,'agent_api'))return reply;
    const parsed=readSchema.safeParse(req.body);
    if(!parsed.success)return reply.code(400).send({error:'通知标识无效'});
    dismissNotifications(req.user!.id,parsed.data.ids,parsed.data.through_id,parsed.data.project_id);
    return {ok:true};
  });
  app.get('/notifications/preferences',async(req,reply)=>{
    if(!requirePermission(req,reply,'agent_api'))return reply;
    return reply.header('Cache-Control','private, no-store').send(notificationPreferences(req.user!.id));
  });
  app.put('/notifications/preferences',async(req,reply)=>{
    if(!requirePermission(req,reply,'agent_api'))return reply;
    const parsed=preferencesSchema.safeParse(req.body);
    if(!parsed.success)return reply.code(400).send({error:'通知偏好无效'});
    if(parsed.data.muted_project_ids.some(id=>!getDb().prepare('SELECT id FROM projects WHERE id=?').get(id)||!userOwnsProject(req.user!.id,id)))return reply.code(404).send({error:'项目不存在或无访问权限'});
    saveNotificationPreferences(req.user!.id,parsed.data.muted_project_ids);
    return {ok:true};
  });
};
