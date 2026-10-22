require('dotenv').config();
const {test,before,after}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const {Pool}=require('pg');
const bcrypt=require('bcryptjs');
const db=require('../db/pool');
const Booking=require('../services/booking');
const {today}=require('../services/common');
const schema=`dekanat_test_${Date.now()}`;
const control=new Pool({...db.pool.options});
db.pool.options.options=`-c search_path=${schema},public`;
let server,url,admin,students=[],staff,other,bolim,faculty,type,qid,day;
function client(){let cookie='',csrf='';return async(path,body,token=true)=>{
  const r=await fetch(url+'/api'+path,{method:body===undefined?'GET':'POST',headers:{cookie,'content-type':'application/json',...(token?{'x-csrf-token':csrf}:{})},body:body===undefined?undefined:JSON.stringify(body)});
  if(r.headers.get('set-cookie'))cookie=r.headers.get('set-cookie').split(';')[0];
  const data=r.headers.get('content-type')?.includes('json')?await r.json():await r.arrayBuffer();if(path==='/session')csrf=data.csrf;return {status:r.status,data};
};}
before(async()=>{
  await control.query(`CREATE SCHEMA ${schema}`);
  for(const file of ['001_init.sql','003_extra.sql','004_runtime.sql'])await db.query(fs.readFileSync(`db/migrations/${file}`,'utf8'));
  const hash=await bcrypt.hash('TestPass123!',10);
  async function add(role,login){return (await db.query('INSERT INTO users(ism,familiya,login,parol,role) VALUES($1,$2,$3,$4,$5) RETURNING *',[login,'Test',login,hash,role])).rows[0];}
  admin=await add('admin','admin');staff=await add('teacher','staff');other=await add('teacher','other');
  for(let i=0;i<32;i++)students.push(await add('student',`student${i}`));
  faculty=(await db.query("INSERT INTO bolimlar(nomi,turi) VALUES('Test fakultet','fakultet') RETURNING id")).rows[0].id;
  bolim=(await db.query("INSERT INTO bolimlar(nomi,turi,parent_id) VALUES('Test bo‘lim','bolim',$1) RETURNING id",[faculty])).rows[0].id;
  await db.query('INSERT INTO xodim_bolim(user_id,bolim_id,asosiy) VALUES($1,$2,true)',[staff.id,bolim]);
  type=(await db.query("INSERT INTO murojaat_turlari(bolim_id,nomi) VALUES($1,'Test murojaat') RETURNING id",[bolim])).rows[0].id;
  day=new Date(Date.parse(today())+3*86400000).toISOString().slice(0,10);
  qid=(await db.query("INSERT INTO qabul_vaqti(xodim_id,bolim_id,hafta_kuni,start_time,end_time,slot_min,max_navbat) VALUES($1,$2,EXTRACT(ISODOW FROM $3::date),'09:00','11:00',15,6) RETURNING id",[staff.id,bolim,day])).rows[0].id;
  server=require('../app').listen(0,'127.0.0.1');await new Promise(resolve=>server.once('listening',resolve));url=`http://127.0.0.1:${server.address().port}`;
});
after(async()=>{if(server)await new Promise(resolve=>server.close(resolve));await db.pool.end();assert.match(schema,/^dekanat_test_\d+$/);await control.query(`DROP SCHEMA ${schema} CASCADE`);await control.end();});
const body=(extra={})=>({qabul_vaqti_id:qid,murojaat_turi_id:type,sana:day,...extra});
test('role-dependent fields and department changes are validated and persisted',async()=>{
  const c=client();await c('/session');await c('/login',{login:'admin',parol:'TestPass123!'});await c('/session');
  const base={ism:'Form',familiya:'Test',login:'role-change',parol:'TestPass123!',role:'dekanat',status:true,guruh:'SHOULD-NOT-SAVE',kurs:'garbage'};
  assert.equal((await c('/users',base)).status,200,'Staff must not require group/course');
  const user=(await db.query("SELECT * FROM users WHERE login='role-change'")).rows[0];
  assert.equal((await db.query('SELECT 1 FROM student_info WHERE user_id=$1',[user.id])).rowCount,0);
  await db.query("INSERT INTO guruhlar(nomi,fakultet_id) VALUES('FORM-21',$1)",[faculty]);
  assert.equal((await c('/users',{...base,id:user.id,role:'student',parol:'',guruh:'',kurs:''})).status,400);
  assert.equal((await c('/users',{...base,id:user.id,role:'student',parol:'',guruh:'FORM-21',kurs:2})).status,200);
  assert.equal((await db.query('SELECT guruh FROM student_info WHERE user_id=$1',[user.id])).rows[0].guruh,'FORM-21');
  assert.equal((await c('/users',{...base,id:user.id,role:'teacher',parol:''})).status,200);
  assert.equal((await db.query('SELECT 1 FROM student_info WHERE user_id=$1',[user.id])).rowCount,0);
  const schedule={xodim_id:staff.id,bolim_id:faculty,hafta_kuni:1,start_time:'12:00',end_time:'13:00',slot_min:15,max_navbat:4};
  const invalid=await c('/schedules',schedule);assert.equal(invalid.status,400);assert.match(invalid.data.error,/biriktirilgan/);
  const movable=(await db.query("INSERT INTO murojaat_turlari(bolim_id,nomi) VALUES($1,'Movable') RETURNING id",[bolim])).rows[0];
  assert.equal((await c('/types',{id:movable.id,bolim_id:faculty,nomi:'Movable',status:true})).status,200);
  assert.equal((await db.query('SELECT bolim_id FROM murojaat_turlari WHERE id=$1',[movable.id])).rows[0].bolim_id,faculty);
  await Booking.book(students[0],body({navbat_raqami:6}));
  assert.equal((await c('/types',{id:type,bolim_id:faculty,nomi:'Test murojaat',status:true})).status,409);
  assert.equal((await db.query('SELECT bolim_id FROM murojaat_turlari WHERE id=$1',[type])).rows[0].bolim_id,bolim);
  // Keep this regression isolated from the shared booking scenarios below.
  const booking=(await db.query('SELECT id FROM navbatlar WHERE student_id=$1',[students[0].id])).rows[0];
  await Booking.change(students[0],booking.id,'bekor_qilindi','Test cleanup');
});
test('slot capacity and server-derived time',async()=>{const rows=await Booking.available(bolim,day);assert.equal(rows[0].slots.length,6);assert.equal(rows[0].slots[5].tugash,'10:30:00');});
test('15 simultaneous students: exactly one gets requested slot',async()=>{const results=await Promise.allSettled(students.slice(0,15).map(u=>Booking.book(u,body({navbat_raqami:3,boshlanish:'23:00'}))));assert.equal(results.filter(r=>r.status==='fulfilled').length,1);assert.equal(results.find(r=>r.status==='fulfilled').value.boshlanish,'09:30:00');});
test('same student cannot book same schedule twice',async()=>{const results=await Promise.allSettled([Booking.book(students[15],body({navbat_raqami:1})),Booking.book(students[15],body({navbat_raqami:2}))]);assert.equal(results.filter(r=>r.status==='fulfilled').length,1);});
test('rejected slot can be reused; invalid transitions are refused',async()=>{const n=await Booking.book(students[16],body({navbat_raqami:4}));await assert.rejects(Booking.change(staff,n.id,'qabul_qilindi',''),/Kelajak/);await assert.rejects(Booking.change(other,n.id,'bekor_qilindi','Sabab'),/ruxsat/i);await assert.rejects(Booking.change(staff,n.id,'bekor_qilindi',''),/Sabab/);await Booking.change(students[16],n.id,'bekor_qilindi','');const again=await Booking.book(students[17],body({navbat_raqami:4}));assert.equal(again.navbat_raqami,4);await assert.rejects(Booking.change(students[16],n.id,'tasdiqlandi',''),/holatga/);});
test('wrong day, wrong type and past day are refused',async()=>{await assert.rejects(Booking.book(students[18],body({sana:new Date(Date.parse(day)+86400000).toISOString().slice(0,10)})),/qabul yo‘q/);await assert.rejects(Booking.book(students[18],body({murojaat_turi_id:999999})),/Murojaat/);await assert.rejects(Booking.book(students[18],body({sana:'2020-01-01'})),/oynasidan/);});
test('DB overlap exclusion and unassigned department checks',async()=>{await assert.rejects(db.query("INSERT INTO qabul_vaqti(xodim_id,bolim_id,hafta_kuni,start_time,end_time,slot_min,max_navbat) SELECT xodim_id,bolim_id,hafta_kuni,'10:00','12:00',15,6 FROM qabul_vaqti WHERE id=$1",[qid]),{code:'23P01'});await assert.rejects(db.query("INSERT INTO qabul_vaqti(xodim_id,bolim_id,hafta_kuni,start_time,end_time,max_navbat) VALUES($1,$2,1,'08:00','09:00',6)",[other.id,bolim]),{code:'23503'});});
test('CSRF, case insensitive login, role restrictions and reports',async()=>{const c=client();await c('/session');assert.equal((await c('/login',{login:'admin',parol:'TestPass123!'},false)).status,403);assert.equal((await c('/login',{login:'ADMIN',parol:'TestPass123!'})).status,200);await c('/session');for(const path of ['/departments','/types','/assignments','/schedules','/bookings','/groups','/settings','/audit','/reports','/excel/template','/excel/users','/excel/reports']){const r=await c(path);assert.equal(r.status,200,`${path}: ${JSON.stringify(r.data)}`);}
  const s=client();await s('/session');await s('/login',{login:'student20',parol:'TestPass123!'});await s('/session');assert.equal((await s('/settings')).status,403);assert.equal((await s('/departments',{nomi:'Hack',turi:'bolim'})).status,403);assert.equal((await s('/users')).status,403);
});
test('blocked account loses session immediately',async()=>{const c=client();await c('/session');await c('/login',{login:'student21',parol:'TestPass123!'});await c('/session');await db.query('UPDATE users SET status=false WHERE id=$1',[students[21].id]);assert.equal((await c('/profile')).status,401);});
test('30 parallel live-queue requests fill exactly 20 places',async()=>{const q=(await db.query("INSERT INTO qabul_vaqti(xodim_id,bolim_id,hafta_kuni,start_time,end_time,slot_min,max_navbat) VALUES($1,$2,EXTRACT(ISODOW FROM $3::date),'11:00','12:00',NULL,20) RETURNING id",[staff.id,bolim,day])).rows[0];const outcomes=await Promise.allSettled(students.slice(0,30).map(u=>Booking.book(u,body({qabul_vaqti_id:q.id}))));const success=outcomes.filter(r=>r.status==='fulfilled');assert.equal(success.length,20);assert.equal(new Set(success.map(r=>r.value.navbat_raqami)).size,20);assert.ok(success.every(r=>r.value.boshlanish===null));});
test('active-booking limit holds across simultaneous different schedules',async()=>{const u=(await db.query("INSERT INTO users(ism,familiya,login,parol,role) VALUES('Limit','Test','limit','unused','student') RETURNING *")).rows[0];const qs=[];for(const hour of [12,14,16,18])qs.push((await db.query('INSERT INTO qabul_vaqti(xodim_id,bolim_id,hafta_kuni,start_time,end_time,slot_min,max_navbat) VALUES($1,$2,EXTRACT(ISODOW FROM $3::date),$4,$5,15,4) RETURNING id',[staff.id,bolim,day,`${hour}:00`,`${hour+1}:00`])).rows[0]);const results=await Promise.allSettled(qs.map(q=>Booking.book(u,body({qabul_vaqti_id:q.id,navbat_raqami:1}))));assert.equal(results.filter(r=>r.status==='fulfilled').length,3);assert.match(results.find(r=>r.status==='rejected').reason.message,/limiti/);});
test('faculty scope and self-protection are enforced',async()=>{const {userAccess,scope}=require('../services/rbac');const dean=(await db.query("INSERT INTO users(ism,familiya,login,parol,role) VALUES('Dean','Test','dean','unused','dekanat') RETURNING *")).rows[0];await db.query('INSERT INTO xodim_bolim(user_id,bolim_id,asosiy) VALUES($1,$2,true)',[dean.id,bolim]);await db.query("INSERT INTO guruhlar(nomi,fakultet_id) VALUES('TEST-21',$1)",[faculty]);await db.query("INSERT INTO student_info(user_id,guruh,kurs) VALUES($1,'TEST-21',2)",[students[25].id]);assert.ok((await scope(dean)).includes(bolim));await userAccess(dean,students[25]);await assert.rejects(userAccess(dean,students[26]),/fakultetingizga/);await assert.rejects(userAccess(dean,admin),/Ruxsat/);const c=client();await c('/session');await c('/login',{login:'admin',parol:'TestPass123!'});await c('/session');assert.equal((await c('/users',{id:admin.id,ism:'Admin',familiya:'Test',login:'admin',role:'student',status:false,guruh:'TEST-21',kurs:1})).status,400);assert.equal((await c(`/users/${admin.id}/delete`,{})).status,400);assert.ok((await db.query("SELECT 1 FROM audit_log WHERE amal='login' AND ip IS NOT NULL")).rowCount);});
test('Excel preview, generated password and forced first-login password change',async()=>{const Excel=require('exceljs');const wb=new Excel.Workbook();const sh=wb.addWorksheet('Talabalar');sh.addRow(['familiya','ism','ochestva','login','phone','guruh','kurs','parol']);sh.addRow(['Import','Talaba','','excel-student','','TEST-21',2,'']);const file=Buffer.from(await wb.xlsx.writeBuffer()).toString('base64');const c=client();await c('/session');await c('/login',{login:'admin',parol:'TestPass123!'});await c('/session');const preview=await c('/excel/import',{file});assert.equal(preview.data.valid,1);assert.equal(preview.data.errors.length,0);assert.equal((await db.query("SELECT 1 FROM users WHERE login='excel-student'")).rowCount,0);const imported=await c('/excel/import',{file,confirm:true});assert.equal(imported.status,200);const password=imported.data.generated[0].parol;const u=(await db.query("SELECT * FROM users WHERE login='excel-student'")).rows[0];assert.ok(u.parol_almashtirish);assert.ok(await bcrypt.compare(password,u.parol));const s=client();await s('/session');await s('/login',{login:'excel-student',parol:password});await s('/session');assert.equal((await s('/bookings')).status,403);assert.equal((await s('/password',{old:password,password:'ChangedTest123!',confirm:'ChangedTest123!'})).status,200);assert.equal((await s('/bookings')).status,200);});
test('history prevents deletion and empty reference data can be removed',async()=>{const c=client();await c('/session');await c('/login',{login:'admin',parol:'TestPass123!'});await c('/session');assert.equal((await c(`/users/${students[15].id}/delete`,{})).status,400);const d=(await db.query("INSERT INTO bolimlar(nomi,turi) VALUES('Delete me','bolim') RETURNING id")).rows[0];assert.equal((await c(`/departments/${d.id}/delete`,{})).status,200);const t=(await db.query("INSERT INTO murojaat_turlari(bolim_id,nomi) VALUES($1,'Delete type') RETURNING id",[bolim])).rows[0];assert.equal((await c(`/types/${t.id}/delete`,{})).status,200);});
test('exception range preview then commit cancels bookings and queues notifications',async()=>{const c=client();await c('/session');await c('/login',{login:'admin',parol:'TestPass123!'});await c('/session');const b={xodim_id:staff.id,sana:day,sana_end:new Date(Date.parse(day)+86400000).toISOString().slice(0,10),sabab:'Xizmat safari'};const preview=await c('/exceptions',b);assert.equal(preview.status,200);assert.ok(preview.data.affected>=1);assert.equal((await db.query('SELECT 1 FROM qabul_istisno')).rowCount,0);assert.equal((await c('/exceptions',{...b,confirm:true})).status,200);assert.equal((await db.query('SELECT 1 FROM qabul_istisno')).rowCount,2);assert.equal((await Booking.available(bolim,day)).length,0);await assert.rejects(Booking.book(students[22],body()),/qabul yo‘q/);const active=await db.query("SELECT 1 FROM navbatlar WHERE status IN ('kutilmoqda','tasdiqlandi')");assert.equal(active.rowCount,0);assert.ok((await db.query('SELECT 1 FROM bildirishnomalar')).rowCount>0);});
test('login attempt limit is durable in PostgreSQL',async()=>{const c=client();await c('/session');for(let i=0;i<10;i++)assert.equal((await c('/login',{login:'missing',parol:'wrong'})).status,401);assert.equal((await c('/login',{login:'missing',parol:'wrong'})).status,429);});
