import { DatabaseSync } from 'node:sqlite';
const db = new DatabaseSync(process.env.USERPROFILE + '/.workbuddy/workbuddy.db', { readOnly: true });
const q = s => db.prepare(s).get().c;
console.log('automations 总行数 =', q('SELECT COUNT(*) c FROM automations'));
console.log('automations 活行   =', q('SELECT COUNT(*) c FROM automations WHERE deleted_at IS NULL'));
try { console.log('会话总行数        =', q('SELECT COUNT(*) c FROM sessions')); } catch { console.log('会话表名不同，探测中'); }
console.log('表 =', db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE '%session%' OR name LIKE '%convers%'").all().map(r=>r.name).join(', '));
