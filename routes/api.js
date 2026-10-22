const router=require('express').Router();
const crypto=require('crypto');
const bcrypt=require('bcryptjs');
const db=require('../db/pool');
const {check,text,id,date,today,settings,audit,notify}=require('../services/common');
const {scope,staffAccess,userAccess}=require('../services/rbac');
const Booking=require('../services/booking');
const wrap=fn=>(req,res,next)=>Promise.resolve(fn(req,res,next)).catch(next);
const admin=req=>check(req.user.role==='admin','Faqat administrator uchun',403);
router.get('/session',wrap(async(req,res)=>res.json({user:req.user||null,csrf:req.session.csrf,today:today(),bot:process.env.TELEGRAM_BOT_USERNAME||null})));
router.post('/login',wrap(async(req,res)=>{
  const login=text(req.body.login,100).toLowerCase();
  const keys=[`ip:${req.ip}`,`login:${login}`];
  for(const key of keys){const r=await db.query(`INSERT INTO login_attempts(kalit,soni,expires_at) VALUES($1,1,now()+interval '15 minutes') ON CONFLICT(kalit) DO UPDATE SET soni=CASE WHEN login_attempts.expires_at<now() THEN 1 ELSE login_attempts.soni+1 END,expires_at=CASE WHEN login_attempts.expires_at<now() THEN now()+interval '15 minutes' ELSE login_attempts.expires_at END RETURNING soni`,[key]);check(r.rows[0].soni<=10,'Urinishlar ko‘p. 15 daqiqadan keyin qayta urinib ko‘ring',429);}
  const user=(await db.query('SELECT * FROM users WHERE lower(login)=$1',[login])).rows[0];
  if(!user?.status||!await bcrypt.compare(String(req.body.parol||''),user.parol)){
    await audit(db,null,'login.fail','users',null,null,{login});check(false,'Login yoki parol noto‘g‘ri',401);
  }
  await db.query('DELETE FROM login_attempts WHERE kalit=ANY($1)',[keys]);
  await new Promise((resolve,reject)=>req.session.regenerate(e=>e?reject(e):resolve()));
  req.session.uid=user.id;req.session.version=user.session_version;req.session.csrf=crypto.randomBytes(24).toString('hex');
  await audit(db,user,'login','users',user.id);
  res.json({ok:true});
}));
router.use((req,res,next)=>{if(!req.user)return res.status(401).json({error:'Tizimga kiring'});if(req.user.parol_almashtirish&&!['/profile','/password','/logout'].includes(req.path))return res.status(403).json({error:'Avval parolingizni almashtiring'});next();});
router.post('/logout',wrap(async(req,res)=>{await audit(db,req.user,'logout','users',req.user.id);req.session.destroy(()=>res.json({ok:true}));}));
router.get('/profile',wrap(async(req,res)=>{
  const profile=(await db.query(`SELECT u.id,u.ism,u.familiya,u.ochestva,u.login,u.role,u.phone,u.telegram_id,u.eslatma_kun,u.eslatma_soat,s.guruh,s.kurs FROM users u LEFT JOIN student_info s ON s.user_id=u.id WHERE u.id=$1`,[req.user.id])).rows[0];res.json(profile);
}));
router.post('/profile',wrap(async(req,res)=>{
  check(!req.body.phone||/^\+998\d{9}$/.test(req.body.phone),'Telefon +998XXXXXXXXX ko‘rinishida bo‘lsin');
  await db.query('UPDATE users SET phone=$2,eslatma_kun=$3,eslatma_soat=$4 WHERE id=$1',[req.user.id,req.body.phone||null,!!req.body.eslatma_kun,!!req.body.eslatma_soat]);res.json({ok:true});
}));
router.post('/password',wrap(async(req,res)=>{
  const u=(await db.query('SELECT parol FROM users WHERE id=$1',[req.user.id])).rows[0];
  check(await bcrypt.compare(String(req.body.old||''),u.parol),'Eski parol noto‘g‘ri');
  check(req.body.password?.length>=8&&req.body.password.length<=72&&req.body.password===req.body.confirm,'Yangi parollar bir xil, 8–72 belgi bo‘lsin');
  const r=await db.query('UPDATE users SET parol=$2,session_version=session_version+1,parol_almashtirish=false WHERE id=$1 RETURNING session_version',[req.user.id,await bcrypt.hash(req.body.password,12)]);req.session.version=r.rows[0].session_version;await audit(db,req.user,'password.change','users',req.user.id);res.json({ok:true});
}));
router.get('/departments',wrap(async(req,res)=>res.json((await db.query('SELECT * FROM bolimlar ORDER BY nomi')).rows)));
router.post('/departments',wrap(async(req,res)=>{
  admin(req);const b=req.body;check(text(b.nomi),'Bo‘lim nomi kerak');check(['fakultet','dekanat','kafedra','bolim','markaz'].includes(b.turi),'Bo‘lim turi noto‘g‘ri');
  await db.tx(async c=>{
    // Serialize hierarchy mutations, including moves made by separate administrators.
    await c.query('SELECT pg_advisory_xact_lock(287462)');
    if(b.id&&b.parent_id){const descendants=await c.query('WITH RECURSIVE d AS (SELECT id FROM bolimlar WHERE id=$1 UNION ALL SELECT b.id FROM bolimlar b JOIN d ON b.parent_id=d.id) SELECT id FROM d',[id(b.id)]);check(!descendants.rows.some(r=>r.id===Number(b.parent_id)),'Bo‘lim daraxtida sikl bo‘lishi mumkin emas');}
    let result;
    if(b.id)result=await c.query('UPDATE bolimlar SET nomi=$2,turi=$3,parent_id=$4,xona=$5,status=$6 WHERE id=$1 RETURNING id',[id(b.id),text(b.nomi),b.turi,b.parent_id?id(b.parent_id):null,text(b.xona,50),b.status!==false]);
    else result=await c.query('INSERT INTO bolimlar(nomi,turi,parent_id,xona,status) VALUES($1,$2,$3,$4,$5) RETURNING id',[text(b.nomi),b.turi,b.parent_id?id(b.parent_id):null,text(b.xona,50),b.status!==false]);
    check(result.rowCount,'Bo‘lim topilmadi',404);await audit(c,req.user,'department.save','bolimlar',result.rows[0].id,null,b);
  });res.json({ok:true});
}));
router.post('/departments/:id/delete',wrap(async(req,res)=>{admin(req);await db.query('DELETE FROM bolimlar WHERE id=$1',[id(req.params.id)]);res.json({ok:true});}));
router.get('/types',wrap(async(req,res)=>res.json((await db.query('SELECT * FROM murojaat_turlari ORDER BY nomi')).rows)));
router.post('/types',wrap(async(req,res)=>{
  const b=req.body,department=id(b.bolim_id);
  await staffAccess(req.user,0,department);check(text(b.nomi),'Murojaat nomi kerak');
  await db.tx(async c=>{
    if(b.id){
      const old=(await c.query('SELECT * FROM murojaat_turlari WHERE id=$1 FOR UPDATE',[id(b.id)])).rows[0];
      check(old,'Topilmadi',404);await staffAccess(req.user,0,old.bolim_id,c);
      if(old.bolim_id!==department)check(!(await c.query('SELECT 1 FROM navbatlar WHERE murojaat_turi_id=$1 LIMIT 1',[old.id])).rowCount,'Navbatlarda ishlatilgan murojaat turini boshqa bo‘limga ko‘chirib bo‘lmaydi. Yangi tur yarating',409);
      await c.query('UPDATE murojaat_turlari SET nomi=$2,tavsif=$3,status=$4,bolim_id=$5 WHERE id=$1',[old.id,text(b.nomi),text(b.tavsif,2000),b.status!==false,department]);
    }else await c.query('INSERT INTO murojaat_turlari(bolim_id,nomi,tavsif) VALUES($1,$2,$3)',[department,text(b.nomi),text(b.tavsif,2000)]);
  });res.json({ok:true});
}));
router.get('/assignments',wrap(async(req,res)=>res.json((await db.query('SELECT x.*,u.ism,u.familiya,b.nomi FROM xodim_bolim x JOIN users u ON u.id=x.user_id JOIN bolimlar b ON b.id=x.bolim_id ORDER BY u.familiya')).rows)));
router.post('/assignments',wrap(async(req,res)=>{
  admin(req);const b=req.body;check((await db.query("SELECT 1 FROM users WHERE id=$1 AND role IN ('teacher','dekanat','tyutor','xodim')",[id(b.user_id)])).rowCount,'Xodim tanlang');
  await db.tx(async c=>{await c.query('SELECT id FROM users WHERE id=$1 FOR UPDATE',[b.user_id]);if(b.asosiy)await c.query('UPDATE xodim_bolim SET asosiy=false WHERE user_id=$1',[b.user_id]);const has=(await c.query('SELECT 1 FROM xodim_bolim WHERE user_id=$1',[b.user_id])).rowCount;await c.query('INSERT INTO xodim_bolim(user_id,bolim_id,lavozim,asosiy) VALUES($1,$2,$3,$4) ON CONFLICT(user_id,bolim_id) DO UPDATE SET lavozim=$3,asosiy=$4',[b.user_id,id(b.bolim_id),text(b.lavozim,150),!!b.asosiy||!has]);});res.json({ok:true});
}));
router.get('/groups',wrap(async(req,res)=>{check(req.user.role!=='student','Ruxsat yo‘q',403);let groups=(await db.query('SELECT g.*,b.nomi AS fakultet,(SELECT count(*)::int FROM student_info s WHERE s.guruh=g.nomi) AS soni FROM guruhlar g JOIN bolimlar b ON b.id=g.fakultet_id ORDER BY g.nomi')).rows;if(req.user.role==='tyutor'){const assigned=(await db.query('SELECT guruh FROM tyutor_guruh WHERE tyutor_id=$1',[req.user.id])).rows.map(r=>r.guruh);groups=groups.filter(g=>assigned.includes(g.nomi));}res.json(groups);}));
router.post('/groups',wrap(async(req,res)=>{admin(req);const b=req.body;check(text(b.nomi,30),'Guruh nomi kerak');check((await db.query("SELECT 1 FROM bolimlar WHERE id=$1 AND turi='fakultet'",[id(b.fakultet_id)])).rowCount,'Fakultet tanlang');await db.query('INSERT INTO guruhlar(nomi,fakultet_id) VALUES($1,$2) ON CONFLICT(nomi) DO UPDATE SET fakultet_id=$2',[text(b.nomi,30),b.fakultet_id]);if(b.tyutor_id){check((await db.query("SELECT 1 FROM users WHERE id=$1 AND role='tyutor'",[id(b.tyutor_id)])).rowCount,'Tyutor tanlang');await db.query('INSERT INTO tyutor_guruh(tyutor_id,guruh) VALUES($1,$2) ON CONFLICT DO NOTHING',[b.tyutor_id,text(b.nomi,30)]);}res.json({ok:true});}));
router.get('/users',wrap(async(req,res)=>{
  check(['admin','dekanat','tyutor'].includes(req.user.role),'Ruxsat yo‘q',403);
  const s=await scope(req.user);const page=Math.max(1,Number(req.query.page)||1);const params=[`%${text(req.query.q,100)}%`,req.query.role||null,s,req.user.role,req.user.id];
  const where=`WHERE (u.familiya||' '||u.ism||' '||u.login||' '||COALESCE(u.phone,'')) ILIKE $1 AND ($2::text IS NULL OR u.role=$2) AND ($4='admin' OR ($4='dekanat' AND (EXISTS(SELECT 1 FROM xodim_bolim x WHERE x.user_id=u.id AND x.bolim_id=ANY($3::bigint[])) OR EXISTS(SELECT 1 FROM guruhlar g WHERE g.nomi=i.guruh AND g.fakultet_id=ANY($3::bigint[])))) OR ($4='tyutor' AND EXISTS(SELECT 1 FROM tyutor_guruh t WHERE t.tyutor_id=$5 AND t.guruh=i.guruh)))`;
  const total=(await db.query(`SELECT count(*)::int AS n FROM users u LEFT JOIN student_info i ON i.user_id=u.id ${where}`,params)).rows[0].n;
  const rows=(await db.query(`SELECT u.id,u.ism,u.familiya,u.ochestva,u.login,u.role,u.phone,u.status,i.guruh,i.kurs FROM users u LEFT JOIN student_info i ON i.user_id=u.id ${where} ORDER BY u.id DESC LIMIT 25 OFFSET $6`,[...params,(page-1)*25])).rows;res.json({rows,total,page});
}));
router.post('/users',wrap(async(req,res)=>{
  check(['admin','dekanat'].includes(req.user.role),'Ruxsat yo‘q',403);const b=req.body;
  check(text(b.ism,100)&&text(b.familiya,100)&&/^[\w.@-]{3,100}$/.test(b.login||''),'Ism, familiya va loginni kiriting');
  check(['admin','dekanat','teacher','tyutor','xodim','student'].includes(b.role),'Rol noto‘g‘ri');
  check(!b.phone||/^\+998\d{9}$/.test(b.phone),'Telefon formati noto‘g‘ri');
  if(!b.id||b.parol)check(b.parol?.length>=8&&b.parol.length<=72,'Parol 8–72 belgi bo‘lsin');
  if(b.role==='student'){check(text(b.guruh,30)&&Number.isInteger(Number(b.kurs))&&b.kurs>=1&&b.kurs<=6,'Guruh va kursni kiriting');check((await db.query('SELECT 1 FROM guruhlar WHERE nomi=$1',[text(b.guruh,30)])).rowCount,'Guruh avval ma’lumotnomaga kiritilishi kerak');}
  const hash=b.parol?await bcrypt.hash(b.parol,12):null;
  await db.tx(async c=>{
    await c.query('SELECT pg_advisory_xact_lock(287463)');
    const old=b.id?(await c.query('SELECT * FROM users WHERE id=$1 FOR UPDATE',[id(b.id)])).rows[0]:null;
    if(b.id){check(old,'Foydalanuvchi topilmadi',404);await userAccess(req.user,old,c);check(!(old.id===req.user.id&&(b.role!==old.role||b.status===false)),'O‘zingizni bloklay olmaysiz yoki rolingizni o‘zgartira olmaysiz');
      if(old.role==='admin'&&old.status&&(b.role!=='admin'||b.status===false))check((await c.query("SELECT 1 FROM users WHERE role='admin' AND status AND id<>$1",[old.id])).rowCount,'Oxirgi faol admin himoyalangan');
    }
    if(req.user.role!=='admin'){
      check(b.role!=='admin','Admin tayinlay olmaysiz',403);const s=await scope(req.user,c);
      check(b.role==='student','Xodimlarni faqat admin boshqaradi',403);
      check((await c.query('SELECT 1 FROM guruhlar WHERE nomi=$1 AND fakultet_id=ANY($2::bigint[])',[b.guruh,s])).rowCount,'Guruh fakultetingizga tegishli emas',403);
    }
    let uid;
    if(old){await c.query('UPDATE users SET ism=$2,familiya=$3,ochestva=$4,login=$5,parol=COALESCE($6,parol),role=$7,phone=$8,status=$9,session_version=session_version+1,parol_almashtirish=CASE WHEN $6::text IS NOT NULL THEN true ELSE parol_almashtirish END WHERE id=$1',[old.id,text(b.ism,100),text(b.familiya,100),text(b.ochestva,100),b.login.toLowerCase(),hash,b.role,b.phone||null,b.status!==false]);uid=old.id;if(uid===req.user.id)req.session.version=old.session_version+1;}
    else uid=(await c.query('INSERT INTO users(ism,familiya,ochestva,login,parol,role,phone,status,parol_almashtirish) VALUES($1,$2,$3,$4,$5,$6,$7,$8,true) RETURNING id',[text(b.ism,100),text(b.familiya,100),text(b.ochestva,100),b.login.toLowerCase(),hash,b.role,b.phone||null,b.status!==false])).rows[0].id;
    if(b.role==='student')await c.query('INSERT INTO student_info(user_id,guruh,kurs) VALUES($1,$2,$3) ON CONFLICT(user_id) DO UPDATE SET guruh=$2,kurs=$3',[uid,text(b.guruh,30),Number(b.kurs)]);
    else await c.query('DELETE FROM student_info WHERE user_id=$1',[uid]);
    if(old&&old.role!==b.role){check(!(await c.query("SELECT 1 FROM navbatlar n JOIN qabul_vaqti q ON q.id=n.qabul_vaqti_id WHERE (n.student_id=$1 OR q.xodim_id=$1) AND n.status IN ('kutilmoqda','tasdiqlandi') AND n.sana>= $2",[uid,today()])).rowCount,'Avval kelgusi navbatlarni bekor qiling');await c.query('UPDATE qabul_vaqti SET status=false WHERE xodim_id=$1',[uid]);if(b.role!=='student')await c.query('DELETE FROM student_info WHERE user_id=$1',[uid]);}
    if(b.status===false)await cancelFor(c,uid,'Hisob bloklangan');
    await audit(c,req.user,'user.save','users',uid,old?{role:old.role,status:old.status}:null,{role:b.role,status:b.status!==false});
  });res.json({ok:true});
}));
async function cancelFor(c,uid,reason){const rows=(await c.query("UPDATE navbatlar n SET status='bekor_qilindi',javob_izoh=$2 FROM qabul_vaqti q WHERE n.qabul_vaqti_id=q.id AND (n.student_id=$1 OR q.xodim_id=$1) AND n.sana>=$3 AND n.status IN ('kutilmoqda','tasdiqlandi') RETURNING n.*",[uid,reason,today()])).rows;for(const n of rows)await notify(c,n.student_id,`Navbat №${n.navbat_raqami} bekor qilindi: ${reason}`);}
router.get('/schedules',wrap(async(req,res)=>res.json((await db.query(`SELECT q.*,u.ism,u.familiya,b.nomi AS bolim,b.xona FROM qabul_vaqti q JOIN users u ON u.id=q.xodim_id JOIN bolimlar b ON b.id=q.bolim_id WHERE (q.status AND u.status AND b.status) OR $1='admin' ORDER BY q.hafta_kuni,q.start_time`,[req.user.role])).rows)));
router.post('/schedules',wrap(async(req,res)=>{
  const b=req.body;await staffAccess(req.user,id(b.xodim_id),id(b.bolim_id));
  check((await db.query("SELECT 1 FROM xodim_bolim x JOIN users u ON u.id=x.user_id JOIN bolimlar d ON d.id=x.bolim_id WHERE x.user_id=$1 AND x.bolim_id=$2 AND u.status AND u.role IN ('dekanat','teacher','tyutor','xodim') AND d.status",[b.xodim_id,b.bolim_id])).rowCount,'Faol xodim va unga biriktirilgan faol bo‘limni tanlang');
  check(/^([01]\d|2[0-3]):[0-5]\d$/.test(b.start_time)&&/^([01]\d|2[0-3]):[0-5]\d$/.test(b.end_time)&&b.end_time>b.start_time,'Vaqt oralig‘i noto‘g‘ri');
  check(Number.isInteger(Number(b.hafta_kuni))&&b.hafta_kuni>=1&&b.hafta_kuni<=7,'Hafta kuni noto‘g‘ri');
  check(Number.isInteger(Number(b.max_navbat))&&b.max_navbat>=1&&b.max_navbat<=500,'Sig‘im 1–500');
  const sm=b.slot_min?Number(b.slot_min):null;check(sm===null||(Number.isInteger(sm)&&sm>=5&&sm<=240),'Slot 5–240 daqiqa bo‘lsin');
  check(Booking.capacity({...b,slot_min:sm})>0,'Bu oraliqqa bitta ham slot sig‘maydi');
  await db.tx(async c=>{
    const values=[b.xodim_id,b.bolim_id,Number(b.hafta_kuni),b.start_time,b.end_time,sm,Number(b.max_navbat),b.status!==false];
    let result;
    if(b.id){const q=(await c.query('SELECT * FROM qabul_vaqti WHERE id=$1 FOR UPDATE',[id(b.id)])).rows[0];check(q,'Jadval topilmadi',404);await staffAccess(req.user,q.xodim_id,q.bolim_id,c);
      if((await c.query("SELECT 1 FROM navbatlar WHERE qabul_vaqti_id=$1 AND sana>=$2 AND status IN ('kutilmoqda','tasdiqlandi')",[q.id,today()])).rowCount)check(q.xodim_id===Number(b.xodim_id)&&q.bolim_id===Number(b.bolim_id)&&q.hafta_kuni===Number(b.hafta_kuni)&&q.start_time.slice(0,5)===b.start_time&&q.end_time.slice(0,5)===b.end_time&&q.slot_min===sm&&Number(b.max_navbat)>=q.max_navbat,'Kelgusi bronlar bor: vaqtni o‘zgartirish uchun yangi jadval yarating');
      result=await c.query('UPDATE qabul_vaqti SET xodim_id=$1,bolim_id=$2,hafta_kuni=$3,start_time=$4,end_time=$5,slot_min=$6,max_navbat=$7,status=$8 WHERE id=$9 RETURNING id',[...values,q.id]);
    }else result=await c.query('INSERT INTO qabul_vaqti(xodim_id,bolim_id,hafta_kuni,start_time,end_time,slot_min,max_navbat,status) VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id',values);
    if(b.status===false){const ns=(await c.query("UPDATE navbatlar SET status='bekor_qilindi',javob_izoh='Qabul jadvali nofaol qilindi' WHERE qabul_vaqti_id=$1 AND sana>=$2 AND status IN ('kutilmoqda','tasdiqlandi') RETURNING *",[result.rows[0].id,today()])).rows;for(const n of ns)await notify(c,n.student_id,'Qabul jadvali nofaol: navbatingiz bekor qilindi');}
    await audit(c,req.user,'schedule.save','qabul_vaqti',result.rows[0].id,null,b);
  });res.json({ok:true});
}));
router.get('/slots',wrap(async(req,res)=>res.json(await Booking.available(req.query.bolim_id,req.query.sana))));
router.post('/bookings',wrap(async(req,res)=>res.status(201).json(await Booking.book(req.user,req.body))));
router.get('/bookings',wrap(async(req,res)=>{
  const s=await scope(req.user);const b=req.query;
  const rows=(await db.query(`SELECT n.*,q.xodim_id,q.bolim_id,q.start_time,q.end_time,b.nomi AS bolim,b.xona,u.familiya||' '||u.ism AS talaba,x.familiya||' '||x.ism AS xodim,i.guruh,i.kurs,m.nomi AS murojaat FROM navbatlar n JOIN qabul_vaqti q ON q.id=n.qabul_vaqti_id JOIN bolimlar b ON b.id=q.bolim_id JOIN users u ON u.id=n.student_id JOIN users x ON x.id=q.xodim_id LEFT JOIN student_info i ON i.user_id=u.id LEFT JOIN murojaat_turlari m ON m.id=n.murojaat_turi_id WHERE ($1='admin' OR ($1='student' AND n.student_id=$2) OR ($1<>'student' AND q.xodim_id=$2) OR ($1='dekanat' AND q.bolim_id=ANY($3::bigint[])) OR ($1='tyutor' AND EXISTS(SELECT 1 FROM tyutor_guruh t WHERE t.tyutor_id=$2 AND t.guruh=i.guruh))) AND ($4::date IS NULL OR n.sana=$4) AND ($5::text IS NULL OR n.status=$5) ORDER BY n.sana DESC,COALESCE(n.boshlanish,q.start_time),n.navbat_raqami LIMIT 1000`,[req.user.role,req.user.id,s,b.sana?date(b.sana):null,b.status||null])).rows;res.json(rows);
}));
router.post('/bookings/:id/status',wrap(async(req,res)=>{await Booking.change(req.user,req.params.id,req.body.status,text(req.body.note,2000));res.json({ok:true});}));
router.get('/exceptions',wrap(async(req,res)=>{check(req.user.role!=='student','Ruxsat yo‘q',403);const s=await scope(req.user);res.json((await db.query("SELECT i.*,u.ism,u.familiya FROM qabul_istisno i JOIN users u ON u.id=i.xodim_id WHERE $1='admin' OR i.xodim_id=$2 OR ($1='dekanat' AND EXISTS(SELECT 1 FROM xodim_bolim x WHERE x.user_id=i.xodim_id AND x.bolim_id=ANY($3::bigint[]))) ORDER BY i.sana DESC",[req.user.role,req.user.id,s])).rows);}));
router.post('/exceptions',wrap(async(req,res)=>{
  const b=req.body;const staff=id(b.xodim_id),day=date(b.sana),end=b.sana_end?date(b.sana_end):day;check(day>=today(),'O‘tgan kunga istisno kiritib bo‘lmaydi');check(end>=day&&(Date.parse(end)-Date.parse(day))/86400000<=90,'Istisno oralig‘i 90 kundan oshmasin');check(text(b.sabab,255),'Sabab yozing');
  await db.tx(async c=>{
    const qs=(await c.query('SELECT * FROM qabul_vaqti WHERE xodim_id=$1 ORDER BY id FOR UPDATE',[staff])).rows;
    if(staff!==req.user.id){check(qs.length,'Xodim jadvali yo‘q');for(const q of qs)await staffAccess(req.user,staff,q.bolim_id,c);}else check(req.user.role!=='student','Ruxsat yo‘q',403);
    const affected=(await c.query("SELECT n.id FROM navbatlar n JOIN qabul_vaqti q ON q.id=n.qabul_vaqti_id WHERE q.xodim_id=$1 AND n.sana BETWEEN $2 AND $3 AND n.status IN ('kutilmoqda','tasdiqlandi')",[staff,day,end])).rowCount;
    if(!b.confirm){res.json({preview:true,affected});return;}
    await c.query("INSERT INTO qabul_istisno(xodim_id,sana,sabab) SELECT $1,d::date,$3 FROM generate_series($2::date,$4::date,interval '1 day') d ON CONFLICT(xodim_id,sana) DO UPDATE SET sabab=$3",[staff,day,text(b.sabab,255),end]);
    const ns=(await c.query("UPDATE navbatlar n SET status='bekor_qilindi',javob_izoh=$3 FROM qabul_vaqti q WHERE q.id=n.qabul_vaqti_id AND q.xodim_id=$1 AND n.sana BETWEEN $2 AND $4 AND n.status IN ('kutilmoqda','tasdiqlandi') RETURNING n.*",[staff,day,`Xodim qabul qilmaydi: ${text(b.sabab,255)}`,end])).rows;
    for(const n of ns)await notify(c,n.student_id,`Navbat №${n.navbat_raqami} bekor qilindi: ${b.sabab}`);
    await audit(c,req.user,'exception.create','qabul_istisno',null,null,b);
  });if(!res.headersSent)res.json({ok:true});
}));
router.get('/settings',wrap(async(req,res)=>{admin(req);res.json({values:await settings(),holidays:(await db.query('SELECT * FROM bayramlar ORDER BY sana')).rows});}));
router.post('/settings',wrap(async(req,res)=>{admin(req);const b=req.body;const ranges={yozilish_oynasi_kun:[1,90],bugun_yopilish_daq:[0,1440],max_faol_bron:[1,20],bekor_muddati_soat:[0,72]};await db.tx(async c=>{for(const [k,r]of Object.entries(ranges)){const v=Number(b[k]);check(Number.isInteger(v)&&v>=r[0]&&v<=r[1],`${k}: qiymat noto‘g‘ri`);await c.query('UPDATE sozlamalar SET qiymat=$2 WHERE kalit=$1',[k,JSON.stringify(v)]);}check(['avto','qolda'].includes(b.tasdiqlash_rejimi),'Tasdiqlash rejimi noto‘g‘ri');for(const k of ['tasdiqlash_rejimi','jazo_yoqilgan'])await c.query('UPDATE sozlamalar SET qiymat=$2 WHERE kalit=$1',[k,JSON.stringify(b[k])]);await audit(c,req.user,'settings.save','sozlamalar',null,null,b);});res.json({ok:true});}));
router.post('/holidays',wrap(async(req,res)=>{admin(req);check(text(req.body.nomi,150),'Bayram nomi kerak');await db.query('INSERT INTO bayramlar(sana,nomi) VALUES($1,$2) ON CONFLICT(sana) DO UPDATE SET nomi=$2',[date(req.body.sana),text(req.body.nomi,150)]);res.json({ok:true});}));
router.get('/audit',wrap(async(req,res)=>{admin(req);res.json((await db.query("SELECT a.id,a.amal,a.obyekt,a.obyekt_id,a.eski,a.yangi,a.created_at,u.login FROM audit_log a LEFT JOIN users u ON u.id=a.user_id WHERE a.amal ILIKE $1 ORDER BY a.id DESC LIMIT 200",[`%${text(req.query.q,50)}%`])).rows);}));
router.post('/telegram/link',wrap(async(req,res)=>{check(process.env.TELEGRAM_BOT_USERNAME,'Telegram bot hali sozlanmagan',503);const token=crypto.randomBytes(24).toString('base64url');await db.query("INSERT INTO tg_link_tokens(token,user_id,expires_at) VALUES($1,$2,now()+interval '10 minutes')",[token,req.user.id]);res.json({url:`https://t.me/${process.env.TELEGRAM_BOT_USERNAME}?start=${token}`});}));
router.post('/telegram/unlink',wrap(async(req,res)=>{await db.query('UPDATE users SET telegram_id=null WHERE id=$1',[req.user.id]);res.json({ok:true});}));
router.post('/users/:id/delete',wrap(async(req,res)=>{
  admin(req);const uid=id(req.params.id);check(uid!==req.user.id,'O‘zingizni o‘chira olmaysiz');
  await db.tx(async c=>{await c.query('SELECT pg_advisory_xact_lock(287463)');const u=(await c.query('SELECT id,role,status FROM users WHERE id=$1 FOR UPDATE',[uid])).rows[0];check(u,'Foydalanuvchi topilmadi',404);if(u.role==='admin'&&u.status)check((await c.query("SELECT 1 FROM users WHERE role='admin' AND status AND id<>$1",[uid])).rowCount,'Oxirgi faol admin himoyalangan');check(!(await c.query('SELECT 1 FROM navbatlar n JOIN qabul_vaqti q ON q.id=n.qabul_vaqti_id WHERE n.student_id=$1 OR q.xodim_id=$1 LIMIT 1',[uid])).rowCount,'Navbat tarixi bor. Hisobni bloklang');await c.query('DELETE FROM qabul_vaqti WHERE xodim_id=$1',[uid]);await c.query('DELETE FROM users WHERE id=$1',[uid]);await audit(c,req.user,'user.delete','users',uid,u,null);});res.json({ok:true});
}));
router.post('/types/:id/delete',wrap(async(req,res)=>{const tid=id(req.params.id);const t=(await db.query('SELECT * FROM murojaat_turlari WHERE id=$1',[tid])).rows[0];check(t,'Murojaat turi topilmadi',404);await staffAccess(req.user,0,t.bolim_id);await db.query('DELETE FROM murojaat_turlari WHERE id=$1',[tid]);await audit(db,req.user,'type.delete','murojaat_turlari',tid,t,null);res.json({ok:true});}));
router.post('/schedules/:id/delete',wrap(async(req,res)=>{const qid=id(req.params.id);await db.tx(async c=>{const q=(await c.query('SELECT * FROM qabul_vaqti WHERE id=$1 FOR UPDATE',[qid])).rows[0];check(q,'Jadval topilmadi',404);await staffAccess(req.user,q.xodim_id,q.bolim_id,c);if((await c.query('SELECT 1 FROM navbatlar WHERE qabul_vaqti_id=$1',[qid])).rowCount){await c.query('UPDATE qabul_vaqti SET status=false WHERE id=$1',[qid]);const rows=(await c.query("UPDATE navbatlar SET status='bekor_qilindi',javob_izoh='Qabul jadvali nofaol qilindi' WHERE qabul_vaqti_id=$1 AND sana>=$2 AND status IN ('kutilmoqda','tasdiqlandi') RETURNING *",[qid,today()])).rows;for(const n of rows)await notify(c,n.student_id,'Qabul jadvali nofaol qilindi. Navbat bekor qilindi');}else await c.query('DELETE FROM qabul_vaqti WHERE id=$1',[qid]);await audit(c,req.user,'schedule.delete','qabul_vaqti',qid,q,null);});res.json({ok:true});}));
router.post('/exceptions/:id/delete',wrap(async(req,res)=>{const ex=(await db.query('SELECT * FROM qabul_istisno WHERE id=$1',[id(req.params.id)])).rows[0];check(ex,'Istisno topilmadi',404);if(req.user.id!==ex.xodim_id){const qs=(await db.query('SELECT * FROM xodim_bolim WHERE user_id=$1',[ex.xodim_id])).rows;check(qs.length,'Biriktirish topilmadi');for(const q of qs)await staffAccess(req.user,ex.xodim_id,q.bolim_id);}check(req.user.role!=='student','Ruxsat yo‘q',403);await db.query('DELETE FROM qabul_istisno WHERE id=$1',[ex.id]);await audit(db,req.user,'exception.delete','qabul_istisno',ex.id,ex,null);res.json({ok:true});}));
router.post('/holidays/:date/delete',wrap(async(req,res)=>{admin(req);await db.query('DELETE FROM bayramlar WHERE sana=$1',[date(req.params.date)]);res.json({ok:true});}));
router.get('/reports',wrap(async(req,res)=>res.json(await require('../services/reports').report(req.user,req.query))));
router.use('/excel',require('./excel'));
module.exports=router;
