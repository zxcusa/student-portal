const session=require('express-session');
const db=require('../db/pool');
class PgStore extends session.Store {
  get(sid,cb){db.query('SELECT sess FROM sessions WHERE sid=$1 AND expire>now()',[sid]).then(r=>cb(null,r.rows[0]?.sess||null),cb);}
  set(sid,sess,cb=()=>{}){db.query('INSERT INTO sessions(sid,sess,expire) VALUES($1,$2,$3) ON CONFLICT(sid) DO UPDATE SET sess=$2,expire=$3',[sid,JSON.stringify(sess),sess.cookie.expires||new Date(Date.now()+28800000)]).then(()=>cb(),cb);}
  touch(sid,sess,cb=()=>{}){db.query('UPDATE sessions SET expire=$2 WHERE sid=$1',[sid,sess.cookie.expires]).then(()=>cb(),cb);}
  destroy(sid,cb=()=>{}){db.query('DELETE FROM sessions WHERE sid=$1',[sid]).then(()=>cb(),cb);}
}
module.exports=PgStore;
