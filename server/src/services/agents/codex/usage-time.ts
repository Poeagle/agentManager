import {localDateKey} from '../../scheduled-task-conditions.js';

/** One platform-local clock for every account, including SSH collectors. */
export const usageTimezone=()=>Intl.DateTimeFormat().resolvedOptions().timeZone;
export const usageDay=(at:number=Date.now(),timezone=usageTimezone())=>localDateKey(at,timezone);
