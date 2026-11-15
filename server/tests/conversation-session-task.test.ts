import { afterEach, expect, it } from 'vitest';
import {createTestDatabase} from './helpers/database.js';
import {getDb} from '../src/db/index.js';
import {rememberFirstSessionTask} from '../src/services/conversation-session-task.js';

let database:ReturnType<typeof createTestDatabase>|undefined;
afterEach(()=>{database?.cleanup();database=undefined;});

it('names an idle-created session from its first conversation input only',()=>{
  database=createTestDatabase();
  getDb().prepare("INSERT INTO sessions(id,task,status,cli_type) VALUES('empty','','running','claude'),('named','Keep this','running','claude')").run();
  expect(rememberFirstSessionTask('empty','  介绍一下\n这个项目  ')).toBe('介绍一下 这个项目');
  expect(getDb().prepare('SELECT task FROM sessions WHERE id=?').get('empty')).toEqual({task:'介绍一下 这个项目'});
  expect(rememberFirstSessionTask('empty','后续消息')).toBeNull();
  expect(rememberFirstSessionTask('named','替换名称')).toBeNull();
  expect(getDb().prepare('SELECT task FROM sessions WHERE id=?').get('named')).toEqual({task:'Keep this'});
});

it('does not assign a task label from an attachment-only input',()=>{
  database=createTestDatabase();
  getDb().prepare("INSERT INTO sessions(id,task,status,cli_type) VALUES('empty','','running','claude')").run();
  expect(rememberFirstSessionTask('empty','')).toBeNull();
  expect(getDb().prepare('SELECT task FROM sessions WHERE id=?').get('empty')).toEqual({task:''});
});
