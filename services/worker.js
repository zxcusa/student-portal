const db=require('../db/pool');
const {audit,notify}=require('./common');
const token=process.env.TELEGRAM_BOT_TOKEN;
let busy=false;
async function telegram(method,body){
  const r=await fetch(`https://api.telegram.org/bot${token}/${method}`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body),signal:AbortSignal.timeout(15000)});
  const data=await r.json();if(!data.ok)throw new Error(`Telegram: ${data.error_code||r.status}`);return data.result;
}
async function maintain(){
  await db.tx(async c=>{
    const expired=(await c.query(`UPDATE navbatlar n SET status='kelmadi' FROM qabul_vaqti q WHERE q.id=n.qabul_vaqti_id AND n.status IN ('kutilmoqda','tasdiqlandi') AND (n.sana+COALESCE(n.tugash,q.end_time)) AT TIME ZONE 'Asia/Tashkent'<now() RETURNING n.*`)).rows;
    for(const n of expired){await audit(c,null,'navbat.auto_no_show','navbatlar',n.id,null,{status:'kelmadi'});await notify(c,n.student_id,`Navbat №${n.navbat_raqami}: qabul vaqti tugadi, holat — kelmadi`);}
    const reminders=(await c.query(`SELECT n.*,u.eslatma_kun,u.eslatma_soat,q.start_time, EXTRACT(EPOCH FROM ((n.sana+COALESCE(n.boshlanish,q.start_time)) AT TIME ZONE 'Asia/Tashkent'-now()))/3600 AS hours FROM navbatlar n JOIN qabul_vaqti q ON q.id=n.qabul_vaqti_id JOIN users u ON u.id=n.student_id WHERE n.status IN ('kutilmoqda','tasdiqlandi') AND n.sana BETWEEN (now() AT TIME ZONE 'Asia/Tashkent')::date AND (now() AT TIME ZONE 'Asia/Tashkent')::date+1`)).rows;
    for(const n of reminders){if(n.hours>23&&n.hours<=24&&n.eslatma_kun)await notify(c,n.student_id,`Eslatma: ertaga ${n.sana} ${(n.boshlanish||n.start_time).slice(0,5)} da navbat №${n.navbat_raqami}`,`${n.id}:day`);if(n.hours>0&&n.hours<=1&&n.eslatma_soat)await notify(c,n.student_id,`Eslatma: bir soat ichida qabulingiz bor. Navbat №${n.navbat_raqami}`,`${n.id}:hour`);}
    await c.query('DELETE FROM sessions WHERE expire<now()');await c.query('DELETE FROM tg_link_tokens WHERE expires_at<now()');await c.query('DELETE FROM login_attempts WHERE expires_at<now()');
  });
}
async function deliver(){
  if(!token)return;
  for(let i=0;i<25;i++){
    const found=await db.tx(async c=>{
      const n=(await c.query("SELECT b.*,u.telegram_id FROM bildirishnomalar b JOIN users u ON u.id=b.user_id WHERE b.holat='kutmoqda' AND b.keyingi_urinish<=now() AND u.telegram_id IS NOT NULL ORDER BY b.id LIMIT 1 FOR UPDATE OF b SKIP LOCKED")).rows[0];
      if(!n)return false;
      try{await telegram('sendMessage',{chat_id:String(n.telegram_id),text:n.matn});await c.query("UPDATE bildirishnomalar SET holat='yuborildi',yuborilgan=now(),urinishlar=urinishlar+1 WHERE id=$1",[n.id]);}
      catch(e){await c.query("UPDATE bildirishnomalar SET holat=CASE WHEN urinishlar>=7 THEN 'xato' ELSE 'kutmoqda' END,urinishlar=urinishlar+1,keyingi_urinish=now()+make_interval(secs=>LEAST(3600,30*power(2,urinishlar)::int)),xato=$2 WHERE id=$1",[n.id,e.message]);}
      return true;
    });if(!found)break;
  }
}
async function poll(){
  if(!token)return;
  // One polling leader across web replicas; offset persists through restarts.
  const c=await db.pool.connect();let locked=false;
  try{
    locked=(await c.query('SELECT pg_try_advisory_lock(287464) AS ok')).rows[0].ok;if(!locked)return;
    const offset=(await c.query("SELECT qiymat FROM sozlamalar WHERE kalit='telegram_offset'")).rows[0]?.qiymat||0;
    const updates=await telegram('getUpdates',{offset,timeout:0,allowed_updates:['message']});
    for(const u of updates){const m=u.message;let reply;
      if(m?.chat.type==='private'&&m.from?.id===m.chat.id){
        const match=/^\/start\s+([\w-]+)$/.exec(m.text||'');
        if(match){await c.query('BEGIN');try{const t=(await c.query('DELETE FROM tg_link_tokens WHERE token=$1 AND expires_at>now() RETURNING user_id',[match[1]])).rows[0];if(t){await c.query('UPDATE users SET telegram_id=$2 WHERE id=$1',[t.user_id,m.chat.id]);reply='Telegram hisobingiz Dekanat tizimiga ulandi.';}else reply='Ulash havolasi eskirgan. Profilingizdan yangi havola oling.';await c.query('COMMIT');}catch(e){await c.query('ROLLBACK');throw e;}}
        else if(m.text==='/navbatlarim'){const rows=(await c.query("SELECT n.* FROM navbatlar n JOIN users u ON u.id=n.student_id WHERE u.telegram_id=$1 AND n.sana>=(now() AT TIME ZONE 'Asia/Tashkent')::date AND n.status IN ('kutilmoqda','tasdiqlandi') ORDER BY sana,boshlanish",[m.chat.id])).rows;reply=rows.length?rows.map(n=>`№${n.navbat_raqami} — ${n.sana} ${n.boshlanish?.slice(0,5)||'Jonli navbat'} (${n.status})`).join('\n'):'Faol navbatlaringiz yo‘q.';}
        else reply='Hisobni ulash uchun veb profilidagi “Telegramni ulash” tugmasidan foydalaning. /navbatlarim — kelgusi navbatlar.';
        if(reply)await telegram('sendMessage',{chat_id:m.chat.id,text:reply});
      }
      await c.query("INSERT INTO sozlamalar(kalit,qiymat) VALUES('telegram_offset',$1) ON CONFLICT(kalit) DO UPDATE SET qiymat=$1",[JSON.stringify(u.update_id+1)]);
    }
  }finally{if(locked)await c.query('SELECT pg_advisory_unlock(287464)');c.release();}
}
async function tick(){if(busy)return;busy=true;try{await maintain();await poll();await deliver();}catch(e){console.error('Background worker:',e.code||e.message);}finally{busy=false;}}
function start(){const timer=setInterval(tick,60000);timer.unref();tick();}
module.exports={start,maintain,deliver};
