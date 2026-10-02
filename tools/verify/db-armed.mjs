import { DatabaseSync } from 'node:sqlite';
const db = new DatabaseSync(process.env.USERPROFILE + '/.workbuddy/workbuddy.db', { readOnly: true });
const now = Date.now();
const rows = db.prepare("SELECT id,name,next_run_at,valid_until FROM automations WHERE deleted_at IS NULL").all();
let armed = 0;
for (const r of rows) {
  const vu = Date.parse(r.valid_until ?? '');
  const due = Number(r.next_run_at) <= now;
  const valid = Number.isNaN(vu) ? true : vu > now;
  if (due && valid) { armed += 1; console.log('ARMED  ' + r.id + ' | ' + String(r.name).slice(0,30) + ' | next=' + r.next_run_at + ' valid_until=' + r.valid_until); }
}
console.log('活行 ' + rows.length + ' 条，其中现在仍会被调度器捡起来(到期且未过 valid_until)的 = ' + armed);
