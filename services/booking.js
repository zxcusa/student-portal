const db=require('../db/pool');
const {check,id,date,today,instant,settings,audit,notify}=require('./common');
const {staffAccess}=require('./rbac');
const OCCUPIED=['kutilmoqda','tasdiqlandi','qabul_qilindi','kelmadi'];
const ACTIVE=['kutilmoqda','tasdiqlandi'];
function capacity(q){return q.slot_min===null?q.max_navbat:Math.min(q.max_navbat,Math.floor((minutes(q.end_time)-minutes(q.start_time))/q.slot_min));}
function minutes(t){const [h,m]=t.split(':').map(Number);return h*60+m;}
function clock(m){return `${String(Math.floor(m/60)).padStart(2,'0')}:${String(m%60).padStart(2,'0')}:00`;}
function slot(q,n){return q.slot_min===null?{boshlanish:null,tugash:null}:{boshlanish:clock(minutes(q.start_time)+(n-1)*q.slot_min),tugash:clock(minutes(q.start_time)+n*q.slot_min)};}
async function available(bolimId,sana,c=db){
  date(sana);
  const {rows}=await c.query(`SELECT q.*,u.ism,u.familiya,b.nomi AS bolim,b.xona FROM qabul_vaqti q JOIN users u ON u.id=q.xodim_id AND u.status JOIN bolimlar b ON b.id=q.bolim_id AND b.status WHERE q.bolim_id=$1 AND q.status AND q.hafta_kuni=EXTRACT(ISODOW FROM $2::date) AND NOT EXISTS(SELECT 1 FROM qabul_istisno i WHERE i.xodim_id=q.xodim_id AND i.sana=$2) AND NOT EXISTS(SELECT 1 FROM bayramlar WHERE sana=$2) ORDER BY q.start_time,u.familiya`,[id(bolimId),sana]);
  const config=await settings(c);
  const occupied=(await c.query('SELECT qabul_vaqti_id,navbat_raqami FROM navbatlar WHERE sana=$1 AND status=ANY($2) AND qabul_vaqti_id=ANY($3::bigint[])',[sana,OCCUPIED,rows.map(q=>q.id)])).rows;
  const occupiedSlots=new Set(occupied.map(r=>`${r.qabul_vaqti_id}:${r.navbat_raqami}`));
  return rows.map(q=>({...q,slots:Array.from({length:capacity(q)},(_,i)=>{const n=i+1,s=slot(q,n);return {navbat_raqami:n,...s,band:occupiedSlots.has(`${q.id}:${n}`),yopiq:instant(sana,s.boshlanish||q.start_time)-Date.now()<config.bugun_yopilish_daq*60000};})}));
}
async function book(user,body){
  check(user.role==='student','Faqat talaba o‘z nomidan navbat oladi',403);
  const qid=id(body.qabul_vaqti_id),sana=date(body.sana),type=id(body.murojaat_turi_id);
  check(String(body.mavzu||'').length<=1000,'Mavzu 1000 belgidan oshmasin');
  try{return await db.tx(async c=>{
    // Serialize per student before schedule: active limits hold across different schedules too.
    const student=(await c.query('SELECT * FROM users WHERE id=$1 FOR UPDATE',[user.id])).rows[0];
    check(student?.status&&student.role==='student','Hisob faol emas',403);
    const q=(await c.query(`SELECT q.*,u.status AS xodim_faol,b.status AS bolim_faol,b.nomi AS bolim FROM qabul_vaqti q JOIN users u ON u.id=q.xodim_id JOIN bolimlar b ON b.id=q.bolim_id WHERE q.id=$1 FOR UPDATE OF q`,[qid])).rows[0];
    check(q&&q.status&&q.xodim_faol&&q.bolim_faol,'Qabul faol emas');
    const config=await settings(c);
    const days=(Date.parse(sana)-Date.parse(today()))/86400000;
    check(days>=0&&days<=config.yozilish_oynasi_kun,'Sana yozilish oynasidan tashqarida');
    const allowed=await available(q.bolim_id,sana,c);check(allowed.some(v=>v.id===qid),'Bu sanada qabul yo‘q');
    check((await c.query('SELECT 1 FROM murojaat_turlari WHERE id=$1 AND bolim_id=$2 AND status FOR SHARE',[type,q.bolim_id])).rowCount,'Murojaat turi bo‘limga tegishli emas');
    if((await c.query("SELECT 1 FROM bolimlar WHERE id=$1 AND turi='dekanat'",[q.bolim_id])).rowCount){
      const faculty=(await c.query(`WITH RECURSIVE p AS (SELECT * FROM bolimlar WHERE id=$1 UNION ALL SELECT b.* FROM bolimlar b JOIN p ON p.parent_id=b.id) SELECT id FROM p WHERE turi='fakultet'`,[q.bolim_id])).rows[0];
      if(faculty)check((await c.query('SELECT 1 FROM student_info s JOIN guruhlar g ON g.nomi=s.guruh WHERE s.user_id=$1 AND g.fakultet_id=$2',[user.id,faculty.id])).rowCount,'Faqat o‘z fakultetingiz dekanatiga yozila olasiz',403);
    }
    const active=(await c.query('SELECT * FROM navbatlar WHERE student_id=$1 AND status=ANY($2)',[user.id,ACTIVE])).rows;
    check(active.filter(n=>n.sana>=today()).length<config.max_faol_bron,'Faol navbatlar limiti tugagan');
    check(!active.some(n=>n.qabul_vaqti_id===qid&&n.sana===sana),'Bu qabulga allaqachon yozilgansiz',409);
    if(config.jazo_yoqilgan)check(!(await c.query("SELECT 1 FROM navbatlar WHERE student_id=$1 AND status='kelmadi' AND sana>=CURRENT_DATE-30 GROUP BY student_id HAVING count(*)>=3 AND max(sana)>CURRENT_DATE-7",[user.id])).rowCount,'Kelmaganlik sababli yozilish vaqtincha yopiq');
    const occupied=(await c.query('SELECT navbat_raqami FROM navbatlar WHERE qabul_vaqti_id=$1 AND sana=$2 AND status=ANY($3)',[qid,sana,OCCUPIED])).rows.map(r=>r.navbat_raqami);
    let n=body.navbat_raqami?Number(body.navbat_raqami):1;
    if(!body.navbat_raqami)while(occupied.includes(n))n++;
    check(Number.isInteger(n)&&n>=1&&n<=capacity(q),'Bo‘sh joy qolmadi',409);
    check(!occupied.includes(n),'Bu vaqt hozirgina band bo‘ldi, boshqa vaqt tanlang',409);
    const s=slot(q,n);
    check(instant(sana,s.boshlanish||q.start_time)-Date.now()>=config.bugun_yopilish_daq*60000,'Bu vaqtga yozilish yopilgan');
    const overlap=await c.query(`SELECT 1 FROM navbatlar n JOIN qabul_vaqti q ON q.id=n.qabul_vaqti_id WHERE n.student_id=$1 AND n.sana=$2 AND n.status=ANY($3) AND COALESCE(n.boshlanish,q.start_time)<$5::time AND COALESCE(n.tugash,q.end_time)>$4::time`,[user.id,sana,ACTIVE,s.boshlanish||q.start_time,s.tugash||q.end_time]);
    check(!overlap.rowCount,'Bu vaqtda boshqa qabulingiz bor',409);
    const status=config.tasdiqlash_rejimi==='avto'?'tasdiqlandi':'kutilmoqda';
    const result=(await c.query(`INSERT INTO navbatlar(student_id,qabul_vaqti_id,murojaat_turi_id,sana,boshlanish,tugash,navbat_raqami,mavzu,status) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,[user.id,qid,type,sana,s.boshlanish,s.tugash,n,body.mavzu||null,status])).rows[0];
    await audit(c,user,'navbat.create','navbatlar',result.id,null,result);
    await notify(c,user.id,`Navbat №${n}: ${sana}, ${(s.boshlanish||q.start_time).slice(0,5)}. ${q.bolim}. Holat: ${status}`);
    return result;
  });}catch(e){if(e.code==='23505'){e.status=409;e.message='Bu vaqt band yoki sizda ushbu qabulga navbat bor';}throw e;}
}
async function change(user,nid,status,note){
  return db.tx(async c=>{
    const n=(await c.query(`SELECT n.*,q.xodim_id,q.bolim_id,q.start_time,q.end_time FROM navbatlar n JOIN qabul_vaqti q ON q.id=n.qabul_vaqti_id WHERE n.id=$1 FOR UPDATE OF n`,[id(nid)])).rows[0];
    check(n,'Navbat topilmadi',404);
    const transitions={kutilmoqda:['tasdiqlandi','rad_etildi','bekor_qilindi','kelmadi'],tasdiqlandi:['bekor_qilindi','qabul_qilindi','kelmadi']};
    check(transitions[n.status]?.includes(status),'Bu holatga o‘tish mumkin emas',409);
    if(user.role==='student'){
      check(n.student_id===user.id&&status==='bekor_qilindi','Ruxsat yo‘q',403);
      const config=await settings(c);check(instant(n.sana,n.boshlanish||n.start_time)-Date.now()>=config.bekor_muddati_soat*3600000,'Bekor qilish muddati o‘tgan');
    }else{
      await staffAccess(user,n.xodim_id,n.bolim_id,c);
      if(['bekor_qilindi','rad_etildi'].includes(status))check(note?.trim(),'Sabab yozish majburiy');
    }
    if(status==='tasdiqlandi')check(n.sana>=today(),'O‘tgan navbatni tasdiqlab bo‘lmaydi',409);
    if(status==='qabul_qilindi')check(n.sana<=today(),'Kelajakdagi navbatni qabul qilib bo‘lmaydi',409);
    if(status==='kelmadi')check(instant(n.sana,n.tugash||n.end_time)<Date.now(),'Qabul hali tugamagan',409);
    await c.query('UPDATE navbatlar SET status=$2,javob_izoh=$3 WHERE id=$1',[n.id,status,note||null]);
    await audit(c,user,'navbat.status','navbatlar',n.id,{status:n.status},{status,note});
    await notify(c,n.student_id,`Navbat №${n.navbat_raqami} (${n.sana}): ${status}. ${note||''}`);
  });
}
module.exports={book,available,change,capacity,slot,ACTIVE,OCCUPIED};
