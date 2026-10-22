const db = require('../db/pool');
const {AsyncLocalStorage}=require('node:async_hooks');
const requestContext=new AsyncLocalStorage();
class AppError extends Error { constructor(message,status=400){super(message);this.status=status;} }
const check = (value,message,status) => { if(!value) throw new AppError(message,status); };
const text = (v,max=200) => String(v ?? '').trim().slice(0,max);
const id = v => { const n=Number(v); check(Number.isSafeInteger(n)&&n>0,'Identifikator noto‘g‘ri'); return n; };
const date = v => { check(/^\d{4}-\d{2}-\d{2}$/.test(v)&&!Number.isNaN(Date.parse(v))&&new Date(v).toISOString().slice(0,10)===v,'Sana noto‘g‘ri'); return v; };
const today = () => new Date(Date.now()+5*3600000).toISOString().slice(0,10);
const instant = (d,t) => new Date(`${d}T${t.slice(0,8)}+05:00`).getTime();
async function settings(c=db){return Object.fromEntries((await c.query('SELECT * FROM sozlamalar')).rows.map(r=>[r.kalit,r.qiymat]));}
async function audit(c,user,amal,obyekt,oid,eski,yangi){await c.query('INSERT INTO audit_log(user_id,amal,obyekt,obyekt_id,eski,yangi,ip) VALUES($1,$2,$3,$4,$5,$6,$7)',[user?.id||null,amal,obyekt,oid||null,eski?JSON.stringify(eski):null,yangi?JSON.stringify(yangi):null,requestContext.getStore()?.ip||null]);}
async function notify(c,userId,message,key=null){await c.query('INSERT INTO bildirishnomalar(user_id,matn,reminder_key) VALUES($1,$2,$3) ON CONFLICT(reminder_key) DO NOTHING',[userId,message,key]);}
module.exports={AppError,check,text,id,date,today,instant,settings,audit,notify,requestContext};
