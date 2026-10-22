const router=require('express').Router();
const Excel=require('exceljs');
const bcrypt=require('bcryptjs');
const crypto=require('crypto');
const db=require('../db/pool');
const {check,text,audit}=require('../services/common');
const {scope}=require('../services/rbac');
const {report}=require('../services/reports');
const wrap=fn=>(req,res,next)=>Promise.resolve(fn(req,res)).catch(next);
const columns=['familiya','ism','ochestva','login','phone','guruh','kurs','parol'];
function workbook(title,headers,rows){const book=new Excel.Workbook();book.creator='Dekanat';const sheet=book.addWorksheet(title);sheet.columns=headers.map(h=>({header:h,key:h,width:24}));sheet.addRows(rows);sheet.getRow(1).font={bold:true,color:{argb:'FFFFFFFF'}};sheet.getRow(1).fill={type:'pattern',pattern:'solid',fgColor:{argb:'FF17634D'}};sheet.views=[{state:'frozen',ySplit:1}];sheet.autoFilter={from:'A1',to:{row:1,column:headers.length}};return book;}
async function send(res,book,name){res.set('Content-Type','application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');res.set('Content-Disposition',`attachment; filename="${name}.xlsx"`);await book.xlsx.write(res);res.end();}
router.get('/template',wrap(async(req,res)=>{check(['admin','dekanat'].includes(req.user.role),'Ruxsat yo‘q',403);await send(res,workbook('Talabalar',columns,[]),'talabalar-shablon');}));
router.get('/users',wrap(async(req,res)=>{
  check(['admin','dekanat'].includes(req.user.role),'Ruxsat yo‘q',403);const s=await scope(req.user);
  const rows=(await db.query(`SELECT u.familiya,u.ism,u.ochestva,u.login,u.phone,u.role,u.status,i.guruh,i.kurs FROM users u LEFT JOIN student_info i ON i.user_id=u.id WHERE (u.familiya||' '||u.ism||' '||u.login||' '||COALESCE(u.phone,'')) ILIKE $1 AND ($2::text IS NULL OR u.role=$2) AND ($3='admin' OR EXISTS(SELECT 1 FROM guruhlar g WHERE g.nomi=i.guruh AND g.fakultet_id=ANY($4::bigint[])) OR EXISTS(SELECT 1 FROM xodim_bolim x WHERE x.user_id=u.id AND x.bolim_id=ANY($4::bigint[]))) ORDER BY u.id LIMIT 10000`,[`%${text(req.query.q,100)}%`,req.query.role||null,req.user.role,s])).rows;
  await send(res,workbook('Foydalanuvchilar',['familiya','ism','ochestva','login','phone','role','status','guruh','kurs'],rows),'foydalanuvchilar');
}));
router.post('/import',wrap(async(req,res)=>{
  check(['admin','dekanat'].includes(req.user.role),'Ruxsat yo‘q',403);
  check(typeof req.body.file==='string'&&req.body.file.length<1000000,'Excel fayl 750 KB dan oshmasin');
  const book=new Excel.Workbook();await book.xlsx.load(Buffer.from(req.body.file,'base64'));
  const sheet=book.worksheets[0];check(sheet&&sheet.rowCount<=1001,'Ko‘pi bilan 1000 talaba yuklang');
  check(columns.every((v,i)=>String(sheet.getRow(1).getCell(i+1).value||'').trim()===v),'Shablon ustunlarini o‘zgartirmang');
  const errors=[],rows=[],seen=new Set();const s=await scope(req.user);
  const groups=(await db.query('SELECT * FROM guruhlar')).rows;const logins=new Set((await db.query('SELECT lower(login) AS login FROM users')).rows.map(u=>u.login));
  for(let i=2;i<=sheet.rowCount;i++){
    const line=sheet.getRow(i);if(!line.hasValues)continue;
    const b=Object.fromEntries(columns.map((k,j)=>[k,String(line.getCell(j+1).text||'').trim()]));b.login=b.login.toLowerCase();
    const issue=[];if(!b.ism||!b.familiya||b.ism.length>100||b.familiya.length>100)issue.push('Ism/familiya noto‘g‘ri');if(!/^[\w.@-]{3,100}$/.test(b.login))issue.push('Login formati noto‘g‘ri');if(seen.has(b.login)||logins.has(b.login))issue.push('Login takrorlangan');seen.add(b.login);
    if(b.phone&&!/^\+998\d{9}$/.test(b.phone))issue.push('Telefon formati noto‘g‘ri');if(!/^([1-6])$/.test(b.kurs))issue.push('Kurs 1–6 bo‘lsin');
    const g=groups.find(g=>g.nomi===b.guruh);if(!g)issue.push('Guruh ma’lumotnomada yo‘q');else if(req.user.role!=='admin'&&!s.includes(g.fakultet_id))issue.push('Guruh fakultetingizga tegishli emas');
    if(b.parol&&(b.parol.length<8||b.parol.length>72))issue.push('Parol 8–72 belgi bo‘lsin');if(!b.parol){b.parol=crypto.randomBytes(12).toString('base64url');b.generated=true;}
    if(issue.length)errors.push(`${i}-qator: ${issue.join('; ')}`);else rows.push(b);
  }
  if(!req.body.confirm||errors.length)return res.json({valid:rows.length,errors,preview:true});
  check(rows.length,'Import uchun qator yo‘q');
  // Hash before beginning the transaction; 10 rounds keeps bulk imports practical.
  for(const b of rows)b.hash=await bcrypt.hash(b.parol,10);
  await db.tx(async c=>{await c.query('SELECT pg_advisory_xact_lock(287463)');for(const b of rows){const uid=(await c.query("INSERT INTO users(ism,familiya,ochestva,login,phone,parol,role,parol_almashtirish) VALUES($1,$2,$3,$4,$5,$6,'student',true) RETURNING id",[b.ism,b.familiya,b.ochestva||null,b.login,b.phone||null,b.hash])).rows[0].id;await c.query('INSERT INTO student_info(user_id,guruh,kurs) VALUES($1,$2,$3)',[uid,b.guruh,Number(b.kurs)]);}await audit(c,req.user,'user.import','users',null,null,{count:rows.length});});
  res.json({ok:true,imported:rows.length,generated:rows.filter(b=>b.generated).map(b=>({login:b.login,parol:b.parol}))});
}));
router.get('/reports',wrap(async(req,res)=>{const r=await report(req.user,req.query);const book=workbook('Xodimlar',['bolim','xodim','total','completed','missed','capacity'],r.staff);const top=book.addWorksheet('Murojaat turlari');top.columns=[{header:'Murojaat',key:'nomi',width:40},{header:'Jami',key:'total',width:15}];top.addRows(r.types);const heat=book.addWorksheet('Kun-soat');heat.columns=['day','hour','total'].map(h=>({header:h,key:h,width:20}));heat.addRows(r.heat);const summary=book.addWorksheet('Umumiy');summary.addRows([['Davr',r.from,r.to],['Jami',r.total],['Qabul qilindi',r.completed],['Kelmaganlar (%)',r.noShow],['Faol',r.active],['O‘rtacha tasdiqlash (daq)',r.averageConfirmationMinutes??'Avto / ma’lumot yo‘q']]);await send(res,book,'hisobot');}));
module.exports=router;
