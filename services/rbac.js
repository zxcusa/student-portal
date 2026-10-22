const db = require('../db/pool');
const {check}=require('./common');
async function scope(user,c=db){
  if(user.role==='admin')return null;
  if(user.role!=='dekanat')return [];
  return (await c.query(`WITH RECURSIVE up AS (SELECT b.* FROM bolimlar b JOIN xodim_bolim x ON x.bolim_id=b.id WHERE x.user_id=$1 AND x.asosiy UNION ALL SELECT b.* FROM bolimlar b JOIN up ON up.parent_id=b.id), down AS (SELECT id FROM up WHERE turi='fakultet' UNION ALL SELECT b.id FROM bolimlar b JOIN down ON b.parent_id=down.id) SELECT id FROM down`,[user.id])).rows.map(r=>r.id);
}
async function staffAccess(user,staffId,bolimId,c=db){
  if(user.role==='admin'||(user.id===Number(staffId)&&user.role!=='student'))return;
  const s=await scope(user,c);check(user.role==='dekanat'&&s.includes(Number(bolimId)),'Bu bo‘limga ruxsat yo‘q',403);
}
async function userAccess(actor,target,c=db){
  if(actor.role==='admin')return;
  check(actor.role==='dekanat'&&target.role!=='admin','Ruxsat yo‘q',403);
  const s=await scope(actor,c);
  const r=await c.query(`SELECT 1 FROM xodim_bolim WHERE user_id=$1 AND bolim_id=ANY($2::bigint[]) UNION ALL SELECT 1 FROM student_info i JOIN guruhlar g ON g.nomi=i.guruh WHERE i.user_id=$1 AND g.fakultet_id=ANY($2::bigint[])`,[target.id,s]);
  check(r.rowCount,'Foydalanuvchi fakultetingizga tegishli emas',403);
}
module.exports={scope,staffAccess,userAccess};
