// Versioned, transactional v2 migration. Original tables are retained in a backup schema.
const fs = require('fs');
const path = require('path');
const bcrypt = require('bcryptjs');
const { pool, tx } = require('./pool');

(async () => {
  try {
    await tx(async c => {
      await c.query('SELECT pg_advisory_xact_lock(287461)');
      await c.query('CREATE TABLE IF NOT EXISTS schema_migrations(version text PRIMARY KEY, applied_at timestamptz DEFAULT now())');
      if ((await c.query("SELECT 1 FROM schema_migrations WHERE version='v2'")).rowCount) return;
      const old = (await c.query("SELECT data_type FROM information_schema.columns WHERE table_schema=current_schema() AND table_name='qabul_vaqti' AND column_name='week_date'")).rows[0];
      if (old) {
        await c.query('CREATE SCHEMA IF NOT EXISTS dekanat_v1_backup');
        for (const name of ['users','student_info','teacher_info','dekanat_user_info','qabul_vaqti']) await c.query(`CREATE TABLE dekanat_v1_backup.${name} AS TABLE ${name}`);
        await c.query('ALTER TABLE qabul_vaqti RENAME TO qabul_vaqti_v1');
        await c.query('ALTER TABLE student_info ALTER COLUMN guruh TYPE varchar(30) USING guruh::text');
        await c.query('ALTER TABLE dekanat_user_info ALTER COLUMN lavozim TYPE varchar(150) USING lavozim::text');
        const constraints = await c.query("SELECT conname FROM pg_constraint WHERE conrelid='users'::regclass AND contype='c' AND pg_get_constraintdef(oid) LIKE '%role%'");
        for (const row of constraints.rows) await c.query(`ALTER TABLE users DROP CONSTRAINT "${row.conname.replaceAll('"','""')}"`);
        await c.query("ALTER TABLE users ADD CONSTRAINT users_role_v2_check CHECK(role IN ('admin','dekanat','teacher','tyutor','xodim','student'))");
      }
      await c.query(fs.readFileSync(path.join(__dirname,'migrations/001_init.sql'),'utf8'));
      if (old) {
        const { rows: [b] } = await c.query("INSERT INTO bolimlar(nomi,turi) VALUES ('Dekanat (migratsiya)','dekanat') RETURNING id");
        await c.query("INSERT INTO xodim_bolim(user_id,bolim_id,lavozim,asosiy) SELECT u.id,$1,d.lavozim,true FROM users u LEFT JOIN dekanat_user_info d ON d.user_id=u.id WHERE u.role IN ('teacher','dekanat','tyutor','xodim')",[b.id]);
        const type = (await c.query("SELECT data_type FROM information_schema.columns WHERE table_schema=current_schema() AND table_name='qabul_vaqti_v1' AND column_name='start_time'")).rows[0].data_type;
        const start = type.includes('time') ? 'v.start_time' : 'make_time((v.start_time/60)::int,(v.start_time%60)::int,0)';
        const end = type.includes('time') ? "LEAST(v.end_time,TIME '23:59')" : 'make_time((LEAST(v.end_time,1439)/60)::int,(LEAST(v.end_time,1439)%60)::int,0)';
        await c.query(`INSERT INTO qabul_vaqti(xodim_id,bolim_id,hafta_kuni,start_time,end_time,slot_min,max_navbat) SELECT x.user_id,$1,v.week_date,${start},${end},15,GREATEST(1,LEAST(500,(EXTRACT(EPOCH FROM (${end})-(${start}))/900)::int)) FROM (SELECT user_id,qabul_vaqti FROM teacher_info UNION ALL SELECT user_id,qabul_vaqti FROM dekanat_user_info) x JOIN qabul_vaqti_v1 v ON v.id=x.qabul_vaqti`,[b.id]);
      }
      for (const file of ['003_extra.sql','004_runtime.sql']) await c.query(fs.readFileSync(path.join(__dirname,'migrations',file),'utf8'));
      await c.query("INSERT INTO schema_migrations(version) VALUES ('v2')");
    });
    console.log('Jadvallar tayyor.');

    const login = process.env.ADMIN_LOGIN || 'admin';
    const parol = process.env.ADMIN_PAROL;
    if ((await pool.query("SELECT 1 FROM users WHERE role='admin'")).rowCount) return;
    if (!parol || parol.length < 8) throw new Error('ADMIN_PAROL kamida 8 belgi bo‘lishi kerak');
    const hash = await bcrypt.hash(parol, 10);
    const r = await pool.query(
      `INSERT INTO users (ism, familiya, login, parol, role)
       VALUES ('Admin', 'Admin', $1, $2, 'admin')
       ON CONFLICT (login) DO NOTHING
       RETURNING id`,
      [login, hash]
    );
    console.log(r.rowCount ? `Admin yaratildi: ${login}` : `Admin allaqachon bor: ${login}`);
  } catch (err) {
    console.error('Migratsiya xatosi:', err.message);
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
})();
