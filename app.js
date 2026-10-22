require('dotenv').config();
const path=require('path');
const crypto=require('crypto');
const express=require('express');
const session=require('express-session');
const PgStore=require('./services/session-store');
const db=require('./db/pool');
const app=express();
app.disable('x-powered-by');
if(process.env.NODE_ENV==='production')app.set('trust proxy',1);
app.use((req,res,next)=>require('./services/common').requestContext.run({ip:req.ip},next));
if(!process.env.SESSION_SECRET||process.env.SESSION_SECRET.length<24)throw new Error('SESSION_SECRET kamida 24 belgi bo‘lsin');
app.use((req,res,next)=>{res.set({'X-Content-Type-Options':'nosniff','X-Frame-Options':'DENY','Referrer-Policy':'same-origin','Content-Security-Policy':"default-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'"});next();});
app.use(express.json({limit:'1mb'}));
app.use(express.urlencoded({extended:false,limit:'1mb'}));
app.use(express.static(path.join(__dirname,'public'),{index:false}));
app.get('/health',async(req,res)=>{try{await db.query('SELECT 1');res.json({ok:true});}catch{res.status(503).json({ok:false});}});
app.use(session({name:'dekanat.sid',store:new PgStore(),secret:process.env.SESSION_SECRET,resave:false,saveUninitialized:false,rolling:true,cookie:{httpOnly:true,sameSite:'lax',secure:process.env.NODE_ENV==='production',maxAge:28800000}}));
app.use(async(req,res,next)=>{try{
  if(!req.session.csrf)req.session.csrf=crypto.randomBytes(24).toString('hex');
  if(req.session.uid){const u=(await db.query('SELECT id,ism,familiya,role,status,session_version,parol_almashtirish FROM users WHERE id=$1',[req.session.uid])).rows[0];if(u?.status&&u.session_version===req.session.version)req.user=u;else{delete req.session.uid;delete req.session.version;}}
  if(req.method==='POST'){
    const token=String(req.get('X-CSRF-Token')||req.body._csrf||'');
    const expected=req.session.csrf;
    if(Buffer.byteLength(token)!==Buffer.byteLength(expected)||!crypto.timingSafeEqual(Buffer.from(token),Buffer.from(expected)))return res.status(403).json({error:'Xavfsizlik tokeni eskirgan. Sahifani yangilang'});
  }
  next();
}catch(e){next(e);}});
app.use('/api',(req,res,next)=>{res.set('Cache-Control','no-store');next();},require('./routes/api'));
app.get('/api/*',(req,res)=>res.status(404).json({error:'Manzil topilmadi'}));
app.get('*',(req,res)=>res.sendFile(path.join(__dirname,'public/index.html')));
app.use((err,req,res,next)=>{
  const messages={'23505':'Bu ma’lumot allaqachon mavjud','23503':'Bog‘langan ma’lumot mavjud yoki tanlov noto‘g‘ri','23P01':'Bu vaqt xodimning boshqa qabuli bilan kesishadi','23514':'Kiritilgan qiymat cheklovga mos emas','22P02':'Qiymat formati noto‘g‘ri'};
  const status=err.status||(messages[err.code]?400:500);
  if(status===500)console.error(err);
  res.status(status).json({error:messages[err.code]|| (status<500?err.message:'Serverda xatolik. Qayta urinib ko‘ring')});
});
if(require.main===module){app.listen(process.env.PORT||3000,'0.0.0.0',()=>console.log(`Dekanat: http://localhost:${process.env.PORT||3000}`));require('./services/worker').start();}
module.exports=app;
