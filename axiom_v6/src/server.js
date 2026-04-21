#!/usr/bin/env node
'use strict';
/**
 * AXIOM v5 — Complete IDE Backend
 * Real WebSocket terminal · Admin Dashboard · Memory Engine · Zero npm deps
 */
const http=require('http'),https=require('https'),fs=require('fs'),path=require('path');
const os=require('os'),urlMod=require('url'),crypto=require('crypto');
const {exec,spawn,execSync}=require('child_process');
let pty;try{pty=require('node-pty');}catch(e){console.warn('node-pty not available, falling back to spawn');}
const mysql=require('mysql2/promise');

// ══════════════════════════════════════════════════════════════
// LSP CLIENT — Language Server Protocol manager
// ══════════════════════════════════════════════════════════════
const lspServers={};  // lang -> { proc, pending, seq, buffer, initialized, diagnostics, rootUri }
const LSP_CMDS={
  python:{cmd:'pyright-langserver',args:['--stdio'],alt:['pylsp','python-lsp-server']},
  javascript:{cmd:'typescript-language-server',args:['--stdio'],alt:[]},
  typescript:{cmd:'typescript-language-server',args:['--stdio'],alt:[]},
  go:{cmd:'gopls',args:['serve'],alt:[]},
  rust:{cmd:'rust-analyzer',args:[],alt:[]},
  c:{cmd:'clangd',args:[],alt:[]},
  cpp:{cmd:'clangd',args:[],alt:[]},
  css:{cmd:'vscode-css-language-server',args:['--stdio'],alt:['css-languageserver']},
  html:{cmd:'vscode-html-language-server',args:['--stdio'],alt:['html-languageserver']},
  json:{cmd:'vscode-json-language-server',args:['--stdio'],alt:[]},
};

function findBin(name){try{execSync('which '+name,{encoding:'utf8',timeout:3000});return true;}catch(e){return false;}}

function getLspBin(lang){
  const cfg=LSP_CMDS[lang];if(!cfg)return null;
  if(findBin(cfg.cmd))return{cmd:cfg.cmd,args:cfg.args};
  for(const alt of(cfg.alt||[])){if(findBin(alt))return{cmd:alt,args:['--stdio']};}
  return null;
}

function lspSend(srv,method,params,isNotif=false){
  return new Promise((resolve,reject)=>{
    const msg={jsonrpc:'2.0',method,params};
    if(!isNotif){msg.id=srv.seq++;srv.pending[msg.id]={resolve,reject,ts:Date.now()};
      setTimeout(()=>{if(srv.pending[msg.id]){srv.pending[msg.id].reject(new Error('LSP timeout'));delete srv.pending[msg.id];}},15000);
    }else{resolve(null);}
    const body=JSON.stringify(msg);
    const hdr=`Content-Length: ${Buffer.byteLength(body)}\r\n\r\n`;
    try{srv.proc.stdin.write(hdr+body);}catch(e){if(!isNotif)reject(e);}
  });
}

function parseLspOutput(srv){
  while(true){
    const idx=srv.buffer.indexOf('\r\n\r\n');if(idx===-1)break;
    const hdr=srv.buffer.substring(0,idx);
    const clm=hdr.match(/Content-Length:\s*(\d+)/i);
    if(!clm){srv.buffer=srv.buffer.substring(idx+4);continue;}
    const cl=parseInt(clm[1]),start=idx+4;
    if(srv.buffer.length<start+cl)break;
    const body=srv.buffer.substring(start,start+cl);
    srv.buffer=srv.buffer.substring(start+cl);
    try{
      const msg=JSON.parse(body);
      if(msg.id!==undefined&&srv.pending[msg.id]){srv.pending[msg.id].resolve(msg.result||msg.error||null);delete srv.pending[msg.id];}
      else if(msg.method==='textDocument/publishDiagnostics'){srv.diagnostics[msg.params.uri]=msg.params.diagnostics||[];}
      else if(msg.method==='window/logMessage'||msg.method==='window/showMessage'){}
      // Auto-respond to workspace/configuration requests
      else if(msg.method==='workspace/configuration'&&msg.id){
        const resp=JSON.stringify({jsonrpc:'2.0',id:msg.id,result:(msg.params?.items||[]).map(()=>({}))});
        try{srv.proc.stdin.write(`Content-Length: ${Buffer.byteLength(resp)}\r\n\r\n${resp}`);}catch(e){}
      }
      else if(msg.method==='client/registerCapability'&&msg.id){
        const resp=JSON.stringify({jsonrpc:'2.0',id:msg.id,result:null});
        try{srv.proc.stdin.write(`Content-Length: ${Buffer.byteLength(resp)}\r\n\r\n${resp}`);}catch(e){}
      }
    }catch(e){}
  }
}

async function startLsp(lang,rootDir){
  const key=lang+'::'+rootDir;
  if(lspServers[key]&&!lspServers[key].dead)return lspServers[key];
  const bin=getLspBin(lang);if(!bin)return null;
  const proc=spawn(bin.cmd,bin.args,{cwd:rootDir,stdio:['pipe','pipe','pipe'],env:{...process.env}});
  const srv={proc,pending:{},seq:1,buffer:'',initialized:false,diagnostics:{},dead:false,lang,rootUri:'file://'+rootDir,openDocs:new Set()};
  proc.stdout.on('data',d=>{srv.buffer+=d.toString();parseLspOutput(srv);});
  proc.stderr.on('data',()=>{});
  proc.on('exit',()=>{srv.dead=true;delete lspServers[key];});
  proc.on('error',()=>{srv.dead=true;delete lspServers[key];});
  lspServers[key]=srv;
  try{
    await lspSend(srv,'initialize',{processId:process.pid,rootUri:srv.rootUri,
      rootPath:rootDir,
      capabilities:{textDocument:{
        completion:{completionItem:{snippetSupport:true,deprecatedSupport:true,labelDetailsSupport:true},contextSupport:true},
        hover:{contentFormat:['markdown','plaintext']},definition:{},references:{},
        rename:{prepareSupport:true},
        signatureHelp:{signatureInformation:{parameterInformation:{labelOffsetSupport:true},activeParameterSupport:true}},
        formatting:{},rangeFormatting:{},
        codeAction:{codeActionLiteralSupport:{codeActionKind:{valueSet:['quickfix','refactor','refactor.extract','refactor.inline','refactor.rewrite','source','source.organizeImports']}}},
        publishDiagnostics:{relatedInformation:true},
        semanticTokens:{requests:{full:true},tokenTypes:['namespace','type','class','enum','interface','struct','typeParameter','parameter','variable','property','enumMember','event','function','method','macro','keyword','modifier','comment','string','number','regexp','operator','decorator'],tokenModifiers:['declaration','definition','readonly','static','deprecated','abstract','async'],formats:['relative'],multilineTokenSupport:false}
      },workspace:{workspaceFolders:true,configuration:true}},
      workspaceFolders:[{uri:srv.rootUri,name:path.basename(rootDir)}]
    });
    lspSend(srv,'initialized',{},true);
    srv.initialized=true;
  }catch(e){srv.dead=true;try{proc.kill();}catch(ee){}delete lspServers[key];return null;}
  return srv;
}

function langToLspId(lang){
  const map={python:'python',javascript:'javascript',typescript:'typescript',js:'javascript',ts:'typescript',go:'go',rust:'rust',c:'c',cpp:'cpp',css:'css',html:'html',json:'json',jsx:'javascriptreact',tsx:'typescriptreact'};
  return map[lang]||lang;
}

function fileToUri(fp){return 'file://'+fp;}

function applyTextEdits(text,edits){
  // Apply LSP text edits to a string (edits are line/character based)
  const lines=text.split('\n');
  // Sort edits in reverse order to apply from bottom to top
  const sorted=[...edits].sort((a,b)=>{
    if(b.range.start.line!==a.range.start.line)return b.range.start.line-a.range.start.line;
    return b.range.start.character-a.range.start.character;
  });
  for(const edit of sorted){
    const sl=edit.range.start.line,sc=edit.range.start.character;
    const el=edit.range.end.line,ec=edit.range.end.character;
    const before=lines.slice(0,sl).join('\n')+(sl>0?'\n':'')+(lines[sl]||'').substring(0,sc);
    const after=(lines[el]||'').substring(ec)+(el<lines.length-1?'\n':'')+lines.slice(el+1).join('\n');
    const result=before+edit.newText+after;
    const newLines=result.split('\n');
    lines.length=0;lines.push(...newLines);
  }
  return lines.join('\n');
}

async function lspOpen(srv,filePath,content,lang){
  const uri=fileToUri(filePath);
  if(srv.openDocs.has(uri))return;
  srv.openDocs.add(uri);
  await lspSend(srv,'textDocument/didOpen',{textDocument:{uri,languageId:langToLspId(lang),version:1,text:content}},true);
}

async function lspChange(srv,filePath,content,version){
  const uri=fileToUri(filePath);
  await lspSend(srv,'textDocument/didChange',{textDocument:{uri,version},contentChanges:[{text:content}]},true);
}

// ══════════════════════════════════════════════════════════════
// DAP CLIENT — Debug Adapter Protocol manager
// ══════════════════════════════════════════════════════════════
const debugSessions={};
const DAP_CMDS={
  python:{cmd:'python3',args:['-m','debugpy','--listen','0','--wait-for-client'],type:'attach',port:5678},
  javascript:{cmd:'node',args:['--inspect-brk'],type:'launch'},
  go:{cmd:'dlv',args:['debug','--headless','--api-version=2','--listen=127.0.0.1:0'],type:'attach'},
};

function startDapSession(lang,filePath,rootDir){
  const id=crypto.randomUUID();
  const cfg=DAP_CMDS[lang];if(!cfg)return{error:'No debugger for '+lang};
  let proc,port=0;
  if(lang==='python'){
    port=5678+Object.keys(debugSessions).length;
    proc=spawn('python3',['-m','debugpy','--listen',String(port),'--wait-for-client',filePath],{cwd:rootDir,stdio:['pipe','pipe','pipe']});
  }else if(lang==='javascript'){
    const inspPort=9229+Object.keys(debugSessions).length;
    port=inspPort;
    proc=spawn('node',['--inspect-brk='+inspPort,filePath],{cwd:rootDir,stdio:['pipe','pipe','pipe']});
  }else if(lang==='go'){
    port=38697+Object.keys(debugSessions).length;
    proc=spawn('dlv',['debug','--headless','--api-version=2','--listen=127.0.0.1:'+port],{cwd:rootDir,stdio:['pipe','pipe','pipe']});
  }else{return{error:'Unsupported debug language'};}
  let output='';
  proc.stdout.on('data',d=>{output+=d.toString();if(output.length>50000)output=output.slice(-25000);});
  proc.stderr.on('data',d=>{output+=d.toString();if(output.length>50000)output=output.slice(-25000);});
  proc.on('exit',code=>{const s=debugSessions[id];if(s)s.exited=true;});
  debugSessions[id]={proc,lang,file:filePath,port,output:'',breakpoints:[],exited:false,started:Date.now()};
  return{id,port,lang};
}

// ══════════════════════════════════════════════════════════════
// COLLABORATION — WebSocket rooms for real-time editing
// ══════════════════════════════════════════════════════════════
const collabRooms={};  // roomId -> { doc, users: [{socket,name,color,cursor}], version }

function getRoom(roomId){
  if(!collabRooms[roomId])collabRooms[roomId]={doc:'',users:[],version:0,history:[]};
  return collabRooms[roomId];
}

function broadcastRoom(roomId,msg,excludeSocket){
  const room=collabRooms[roomId];if(!room)return;
  const data=JSON.stringify(msg);
  room.users.forEach(u=>{
    if(u.socket!==excludeSocket){try{u.socket.write(encodeWsFrame(data));}catch(e){}}
  });
}

// ══════════════════════════════════════════════════════════════
// TASK RUNNER — Detect and run project tasks
// ══════════════════════════════════════════════════════════════
function detectTasks(dir){
  const tasks=[];
  // package.json scripts
  try{const pkg=JSON.parse(fs.readFileSync(path.join(dir,'package.json'),'utf8'));
    Object.entries(pkg.scripts||{}).forEach(([k,v])=>tasks.push({name:k,cmd:`npm run ${k}`,source:'package.json',detail:v}));
  }catch(e){}
  // Makefile targets
  try{const mk=fs.readFileSync(path.join(dir,'Makefile'),'utf8');
    (mk.match(/^([a-zA-Z_][a-zA-Z0-9_-]*):/gm)||[]).forEach(m=>{const t=m.slice(0,-1);tasks.push({name:t,cmd:`make ${t}`,source:'Makefile'});});
  }catch(e){}
  // Cargo.toml
  try{fs.accessSync(path.join(dir,'Cargo.toml'));
    ['build','run','test','check','clippy'].forEach(c=>tasks.push({name:'cargo '+c,cmd:'cargo '+c,source:'Cargo.toml'}));
  }catch(e){}
  // Go
  try{fs.accessSync(path.join(dir,'go.mod'));
    ['build','run .','test ./...','vet ./...'].forEach(c=>tasks.push({name:'go '+c,cmd:'go '+c,source:'go.mod'}));
  }catch(e){}
  // Python
  try{fs.accessSync(path.join(dir,'setup.py'));tasks.push({name:'python setup.py',cmd:'python3 setup.py install',source:'setup.py'});}catch(e){}
  try{fs.accessSync(path.join(dir,'pyproject.toml'));
    ['pytest','mypy .','ruff check .','black .'].forEach(c=>tasks.push({name:c,cmd:c,source:'pyproject.toml'}));
  }catch(e){}
  // Docker
  try{fs.accessSync(path.join(dir,'docker-compose.yml'));
    ['up','down','build','logs'].forEach(c=>tasks.push({name:'docker-compose '+c,cmd:'docker-compose '+c,source:'docker-compose.yml'}));
  }catch(e){}
  try{fs.accessSync(path.join(dir,'Dockerfile'));
    tasks.push({name:'docker build',cmd:'docker build -t $(basename $(pwd)) .',source:'Dockerfile'});
  }catch(e){}
  return tasks;
}

const PORT=5000,DATA=path.join(os.homedir(),'.axiom');
const KEY_FILE=path.join(DATA,'key'),MEM_FILE=path.join(DATA,'memory.json');
const CFG_FILE=path.join(DATA,'config.json'),DB_FILE=path.join(DATA,'axiom.db');
const SNIP_FILE=path.join(DATA,'snippets.json');
const CHATS_FILE=path.join(DATA,'chats.json');
fs.mkdirSync(DATA,{recursive:true,mode:0o700});

// ── Config ──────────────────────────────────────────────────────
function loadCfg(){try{return JSON.parse(fs.readFileSync(CFG_FILE,'utf8'));}catch(e){}
  const c={token:crypto.randomBytes(32).toString('hex'),created:new Date().toISOString()};
  fs.writeFileSync(CFG_FILE,JSON.stringify(c,null,2),{mode:0o600});return c;}
const CFG=loadCfg();

// ── Rate limiter ─────────────────────────────────────────────────
const rl=new Map();
function rateOk(ip){const n=Date.now(),b=rl.get(ip)||{c:0,r:n+60000};if(n>b.r){b.c=0;b.r=n+60000;}b.c++;rl.set(ip,b);return b.c<=400;}

// ── Path sandbox ─────────────────────────────────────────────────
function safe(p){if(!p)return null;const r=path.resolve((p+'').replace(/^~/,os.homedir()));return[os.homedir(),'/tmp'].some(b=>r.startsWith(path.resolve(b)))?r:null;}

// ── Plans ────────────────────────────────────────────────────────
// Four subscription tiers. `price` is USD/month; `kes` is the KES/month
// shown on the M-Pesa billing panel. `features` drives the plan cards.
const PLANS={
  free:{
    name:'Free',price:0,kes:0,tagline:'For trying out AXIOM',
    features:['Basic IDE + editor','Community support','1K AI tokens/day','1 workspace']
  },
  starter:{
    name:'Starter',price:9,kes:1170,tagline:'For hobbyists and students',
    features:['Everything in Free','5K AI tokens/day','GitHub + Google login','Email support']
  },
  pro:{
    name:'Pro',price:19,kes:2470,tagline:'For professional developers',
    features:['Everything in Starter','Unlimited AI tokens','Priority response times','Advanced debugging + LSP']
  },
  team:{
    name:'Team',price:49,kes:6370,tagline:'For small teams',
    features:['Everything in Pro','5 seats included','Admin dashboard + analytics','Shared workspaces & billing']
  }
};

// ── MySQL Database ───────────────────────────────────────────────
const dbPool=mysql.createPool({
  host:process.env.DB_HOST||'localhost',
  user:process.env.DB_USER||'root',
  password:process.env.DB_PASS||'Zawadi@18',
  database:process.env.DB_NAME||'axiom',
  waitForConnections:true,
  connectionLimit:10,
  queueLimit:0,
  timezone:'+00:00',
  decimalNumbers:true
});

const DB={
  async createUser(o){
    const id=crypto.randomUUID();
    const email=(o.email||'').toLowerCase();
    try{
      const [existing]=await dbPool.query('SELECT id FROM users WHERE email=?',[email]);
      if(existing.length)return{error:'Email exists'};
      const u={id,name:o.name||'',email,plan:o.plan||'free',role:o.role||'user',status:'active',total_paid:0,total_cost:0,chat_count:0,tokens_in:0,tokens_out:0,last_seen:null,created_at:new Date().toISOString().slice(0,19).replace('T',' ')};
      await dbPool.query('INSERT INTO users (id,name,email,plan,role,status,total_paid,total_cost,chat_count,tokens_in,tokens_out,last_seen,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)',
        [u.id,u.name,u.email,u.plan,u.role,u.status,u.total_paid,u.total_cost,u.chat_count,u.tokens_in,u.tokens_out,u.last_seen,u.created_at]);
      return u;
    }catch(e){console.error('DB.createUser:',e.message);return{error:e.message};}
  },
  async getUser(id){
    try{const [rows]=await dbPool.query('SELECT * FROM users WHERE id=?',[id]);return rows[0]||null;}
    catch(e){console.error('DB.getUser:',e.message);return null;}
  },
  async updateUser(id,p){
    try{
      const sets=[];const vals=[];
      for(const [k,v] of Object.entries(p)){if(['id'].includes(k))continue;sets.push(k+'=?');vals.push(v);}
      if(!sets.length)return null;
      vals.push(id);
      await dbPool.query('UPDATE users SET '+sets.join(',')+' WHERE id=?',vals);
      return this.getUser(id);
    }catch(e){console.error('DB.updateUser:',e.message);return null;}
  },
  async deleteUser(id){
    try{await dbPool.query('DELETE FROM users WHERE id=?',[id]);return true;}
    catch(e){console.error('DB.deleteUser:',e.message);return false;}
  },
  async getUsers(f={}){
    try{
      let sql='SELECT * FROM users WHERE 1=1';const vals=[];
      if(f.plan){sql+=' AND plan=?';vals.push(f.plan);}
      if(f.search){sql+=' AND (LOWER(name) LIKE ? OR LOWER(email) LIKE ?)';const s='%'+f.search.toLowerCase()+'%';vals.push(s,s);}
      sql+=' ORDER BY created_at DESC';
      const [rows]=await dbPool.query(sql,vals);return rows;
    }catch(e){console.error('DB.getUsers:',e.message);return[];}
  },
  async recordPayment(o){
    try{
      const id=crypto.randomUUID();
      const now=new Date().toISOString().slice(0,19).replace('T',' ');
      await dbPool.query('INSERT INTO payments (id,user_id,email,name,plan,amount,status,type,stripe_id,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)',
        [id,o.user_id||null,o.email||'',o.name||'',o.plan||'',o.amount||0,o.status||'pending',o.type||'subscription',o.stripe_id||'',now]);
      if(o.user_id){
        await dbPool.query('UPDATE users SET total_paid=total_paid+?, plan=? WHERE id=?',[o.amount||0,o.plan||'free',o.user_id]);
      }
      return{id,user_id:o.user_id,email:o.email,name:o.name,plan:o.plan,amount:o.amount,status:o.status,type:o.type,stripe_id:o.stripe_id||'',created_at:now};
    }catch(e){console.error('DB.recordPayment:',e.message);return{error:e.message};}
  },
  async getPayments(f={}){
    try{
      let sql='SELECT * FROM payments WHERE 1=1';const vals=[];
      if(f.user_id){sql+=' AND user_id=?';vals.push(f.user_id);}
      if(f.days){sql+=' AND created_at >= DATE_SUB(NOW(), INTERVAL ? DAY)';vals.push(f.days);}
      sql+=' ORDER BY created_at DESC';
      const [rows]=await dbPool.query(sql,vals);return rows;
    }catch(e){console.error('DB.getPayments:',e.message);return[];}
  },
  async recordUsage(o){
    try{
      const id=crypto.randomUUID();
      const now=new Date().toISOString().slice(0,19).replace('T',' ');
      await dbPool.query('INSERT INTO usage_log (id,user_id,action,tokens_in,tokens_out,cost,created_at) VALUES (?,?,?,?,?,?,?)',
        [id,o.user_id||null,o.action||'',o.tokens_in||0,o.tokens_out||0,o.cost||0,now]);
      if(o.user_id){
        await dbPool.query('UPDATE users SET tokens_in=tokens_in+?, tokens_out=tokens_out+?, total_cost=total_cost+?, chat_count=chat_count+1, last_seen=? WHERE id=?',
          [o.tokens_in||0,o.tokens_out||0,o.cost||0,now,o.user_id]);
      }
    }catch(e){console.error('DB.recordUsage:',e.message);}
  },
  async getAnalytics(){
    try{
      const [[uStats]]=await dbPool.query('SELECT COUNT(*) AS total_users, SUM(CASE WHEN plan!="free" THEN 1 ELSE 0 END) AS paying_users, SUM(CASE WHEN DATE(created_at)=CURDATE() THEN 1 ELSE 0 END) AS new_today FROM users');
      const [[revStats]]=await dbPool.query('SELECT COALESCE(SUM(amount),0) AS total, COALESCE(SUM(CASE WHEN DATE_FORMAT(created_at,"%Y-%m")=DATE_FORMAT(NOW(),"%Y-%m") THEN amount ELSE 0 END),0) AS monthly, COALESCE(SUM(CASE WHEN DATE(created_at)=CURDATE() THEN amount ELSE 0 END),0) AS today FROM payments WHERE status="succeeded"');
      const [planCounts]=await dbPool.query('SELECT plan, COUNT(*) AS cnt FROM users GROUP BY plan');
      const bp={free:0,starter:0,pro:0,team:0};planCounts.forEach(r=>bp[r.plan]=r.cnt);
      const mrr=Object.entries(PLANS).reduce((s,[k,p])=>s+(p.price||0)*(bp[k]||0),0);
      const [[usageStats]]=await dbPool.query('SELECT COALESCE(SUM(tokens_in+tokens_out),0) AS total_tokens, COALESCE(SUM(cost),0) AS total_cost, COUNT(CASE WHEN action="chat" THEN 1 END) AS total_chats FROM usage_log');
      // Daily charts
      const [dailyRevRows]=await dbPool.query('SELECT DATE(created_at) AS d, SUM(amount) AS amt FROM payments WHERE status="succeeded" AND created_at >= DATE_SUB(NOW(), INTERVAL 30 DAY) GROUP BY DATE(created_at)');
      const [dailySigRows]=await dbPool.query('SELECT DATE(created_at) AS d, COUNT(*) AS cnt FROM users WHERE created_at >= DATE_SUB(NOW(), INTERVAL 30 DAY) GROUP BY DATE(created_at)');
      const dailyRev={},dailySig={};
      for(let i=29;i>=0;i--){const d=new Date(Date.now()-i*86400000).toISOString().slice(0,10);dailyRev[d]=0;dailySig[d]=0;}
      dailyRevRows.forEach(r=>{const d=new Date(r.d).toISOString().slice(0,10);if(dailyRev[d]!==undefined)dailyRev[d]=+r.amt;});
      dailySigRows.forEach(r=>{const d=new Date(r.d).toISOString().slice(0,10);if(dailySig[d]!==undefined)dailySig[d]=r.cnt;});
      // Top users
      const [topUsers]=await dbPool.query('SELECT id,name,email,plan,total_paid FROM users ORDER BY total_paid DESC LIMIT 10');
      // Recent payments
      const [recentPays]=await dbPool.query('SELECT * FROM payments WHERE status="succeeded" ORDER BY created_at DESC LIMIT 15');
      return{
        overview:{total_users:uStats.total_users||0,paying_users:+(uStats.paying_users||0),new_today:uStats.new_today||0},
        revenue:{total:+revStats.total,monthly:+revStats.monthly,today:+revStats.today,mrr,arr:mrr*12},
        plans:bp,
        usage:{total_tokens:+usageStats.total_tokens,total_cost:+(+usageStats.total_cost).toFixed(4),total_chats:usageStats.total_chats||0},
        charts:{dailyRevenue:dailyRev,dailySignups:dailySig},
        topByRevenue:topUsers,
        recent_payments:recentPays
      };
    }catch(e){console.error('DB.getAnalytics:',e.message);return{overview:{total_users:0,paying_users:0,new_today:0},revenue:{total:0,monthly:0,today:0,mrr:0,arr:0},plans:{free:0,starter:0,pro:0,team:0},usage:{total_tokens:0,total_cost:0,total_chats:0},charts:{dailyRevenue:{},dailySignups:{}},topByRevenue:[],recent_payments:[]};}
  },
  async nlQuery(q){
    const low=q.toLowerCase();
    if(low.match(/revenue|money|paid|income/)){
      const [pays]=await dbPool.query('SELECT * FROM payments WHERE status="succeeded" ORDER BY created_at DESC LIMIT 20');
      const [[s]]=await dbPool.query('SELECT SUM(amount) AS total, COUNT(*) AS cnt FROM payments WHERE status="succeeded"');
      return{answer:`Total revenue: $${(+(s.total||0)).toFixed(2)} from ${s.cnt||0} payments`,data:pays,type:'payments'};
    }
    if(low.match(/mrr|monthly recurring/)){const a=await this.getAnalytics();return{answer:`MRR: $${a.revenue.mrr} | ARR: $${a.revenue.arr}`,data:a.plans,type:'summary'};}
    if(low.match(/user|signup|customer/)){
      const [users]=await dbPool.query('SELECT * FROM users ORDER BY created_at DESC LIMIT 20');
      const [[c]]=await dbPool.query('SELECT COUNT(*) AS cnt FROM users');
      return{answer:`Total users: ${c.cnt}`,data:users,type:'users'};
    }
    const a=await this.getAnalytics();return{answer:`Platform: ${a.overview.total_users} users, $${a.revenue.total.toFixed(2)} revenue, $${a.revenue.mrr}/mo MRR`,data:a,type:'analytics'};
  },
  async seedDemo(){
    const [existing]=await dbPool.query('SELECT COUNT(*) AS cnt FROM users');
    if(existing[0].cnt>0)return;
    const demos=[['Amara Osei','amara@example.com','pro'],['Kofi Mensah','kofi@example.com','free'],['Sofia Rodriguez','sofia@startup.io','starter'],['James Chen','james@tech.co','pro'],['Priya Sharma','priya@company.com','team']];
    for(const [name,email,plan] of demos){
      const u=await this.createUser({name,email,plan});
      if(u.error)continue;
      if(plan!=='free'){
        const price=PLANS[plan]?.price||9;
        for(let m=0;m<3;m++)await this.recordPayment({user_id:u.id,email,name,plan,amount:price,status:'succeeded',type:'subscription'});
      }
    }
    console.log('  Demo data seeded to MySQL');
  },
  // Keep backward-compat stubs for any code that calls load()/save()
  load(){return this;},
  save(){}
};

// ── Memory engine ────────────────────────────────────────────────
const Mem={
  _d:null,
  load(){if(this._d)return this._d;try{this._d=JSON.parse(fs.readFileSync(MEM_FILE,'utf8'));}catch(e){this._d={v:5,sessions:0,chats:0,lastSeen:null,identity:{},langs:[],bugs:[],insights:[],decisions:[],todos:[],facts:[],sessionNotes:[],bookmarks:[]};}return this._d;},
  save(){if(this._d)fs.writeFileSync(MEM_FILE,JSON.stringify(this._d,null,2),{mode:0o600});},
  get(){return this.load();},patch(p){Object.assign(this.load(),p);this.save();return this._d;},
  addFact(f){const m=this.load();if(!m.facts.includes(f)){m.facts.unshift(f);m.facts=m.facts.slice(0,400);}this.save();},
  addBug(e,s,l){const m=this.load();m.bugs.unshift({e:e.slice(0,250),s:s.slice(0,200),l,d:new Date().toISOString()});m.bugs=m.bugs.slice(0,300);this.save();},
  addLang(n){const m=this.load();const ex=m.langs.find(l=>l.n.toLowerCase()===n.toLowerCase());if(ex)ex.d=new Date().toISOString();else m.langs.push({n,d:new Date().toISOString()});this.save();},
  addTodo(t){const m=this.load();m.todos.unshift({t,done:false,d:new Date().toISOString()});m.todos=m.todos.slice(0,300);this.save();},
  addDecision(t){const m=this.load();m.decisions.unshift({t,d:new Date().toISOString()});m.decisions=m.decisions.slice(0,150);this.save();},
  addInsight(t){const m=this.load();m.insights.unshift({t,d:new Date().toISOString()});m.insights=m.insights.slice(0,200);this.save();},
  startSession(){const m=this.load();m.sessions=(m.sessions||0)+1;m.lastSeen=new Date().toISOString();this.save();return m;},
  extract(u,a){
    const low=u.toLowerCase();
    ['python','javascript','typescript','go','rust','java','react','vue','next.js','fastapi','django','node','flutter','dart','ruby','bash','sql','kotlin','swift','elixir'].forEach(l=>{if(low.includes(l))this.addLang(l);});
    if(['error','traceback','exception','not working','bug','broken'].some(w=>low.includes(w))&&a.length>50)this.addBug(u.slice(0,200),a.slice(0,200),'code');
    if(["i'll use","going with","decided"].some(t=>low.includes(t)))this.addDecision(u.slice(0,200));
    if(["todo:","i should","need to","remind me"].some(t=>low.includes(t)))this.addTodo(u.slice(0,120));
    if(["i prefer","i use","my name","i'm using"].some(t=>low.includes(t)))this.addFact(u.slice(0,120));
    if(["realized","learned","figured out"].some(t=>low.includes(t)))this.addInsight(u.slice(0,150));
    const m=this.load();m.chats=(m.chats||0)+1;this.save();
  },
  context(){
    const m=this.load();if(!m.sessions||m.sessions<=1)return'';
    const p=[`\n\n═══ AXIOM MEMORY — Session ${m.sessions} ═══`];
    if(m.identity?.name)p.push(`Engineer: ${m.identity.name}${m.identity.role?' · '+m.identity.role:''}`);
    if(m.langs?.length)p.push(`Stack: ${m.langs.slice(0,10).map(l=>l.n).join(', ')}`);
    if(m.bugs?.length){p.push('Bugs fixed:');m.bugs.slice(0,3).forEach(b=>p.push(`  · [${b.l}] ${b.e.slice(0,80)}`));}
    if(m.todos?.filter(t=>!t.done).length){p.push('Open TODOs:');m.todos.filter(t=>!t.done).slice(0,4).forEach(t=>p.push(`  · ${t.t.slice(0,100)}`));}
    if(m.facts?.length){p.push('Facts:');m.facts.slice(0,5).forEach(f=>p.push(`  · ${f}`));}
    if(m.sessionNotes?.length)p.push(`Last session: ${m.sessionNotes[0].s}`);
    return p.join('\n');
  },
  clear(){this._d={v:5,sessions:0,chats:0,lastSeen:null,identity:{},langs:[],bugs:[],insights:[],decisions:[],todos:[],facts:[],sessionNotes:[],bookmarks:[]};this.save();}
};

// ── Snippets ─────────────────────────────────────────────────────
const Snippets={
  load(){try{return JSON.parse(fs.readFileSync(SNIP_FILE,'utf8'));}catch(e){return[];}},
  save(s){fs.writeFileSync(SNIP_FILE,JSON.stringify(s,null,2),{mode:0o600});},
  add(name,code,lang,desc){const s=this.load();s.unshift({id:crypto.randomUUID(),name,code,lang,desc,created:new Date().toISOString()});this.save(s.slice(0,200));},
  remove(id){this.save(this.load().filter(s=>s.id!==id));}
};

// ── Chats ────────────────────────────────────────────────────────
const Chats={
  load(){try{return JSON.parse(fs.readFileSync(CHATS_FILE,'utf8'));}catch(e){return[];}},
  save(c){fs.writeFileSync(CHATS_FILE,JSON.stringify(c,null,2),{mode:0o600});},
  add(title,messages,lang){const c=this.load();const chat={id:crypto.randomUUID(),title:title.slice(0,120),messages,lang:lang||'',created:new Date().toISOString(),updated:new Date().toISOString()};c.unshift(chat);this.save(c.slice(0,200));return chat;},
  update(id,messages,title){const c=this.load();const i=c.findIndex(x=>x.id===id);if(i===-1)return null;if(messages)c[i].messages=messages;if(title)c[i].title=title;c[i].updated=new Date().toISOString();this.save(c);return c[i];},
  remove(id){const c=this.load().filter(x=>x.id!==id);this.save(c);},
  get(id){return this.load().find(x=>x.id===id)||null;}
};

// ── East African Proverbs ────────────────────────────────────────
const EA_PROVERBS=[
  'Haraka haraka haina baraka — Hurry hurry has no blessing',
  'Mtu ni watu — A person is people (Ubuntu)',
  'Kidole kimoja hakivunji chawa — One finger cannot crush a louse',
  'Asiyefunzwa na mamaye hufunzwa na ulimwengu — Who is not taught by mother is taught by the world',
  'Dau la mnyonge haliendi joshi — The canoe of the weak does not sail well',
  'Pole pole ndio mwendo — Slowly slowly is the way',
  'Umoja ni nguvu, utengano ni udhaifu — Unity is strength, division is weakness',
  'Penye nia pana njia — Where there is a will there is a way',
  'Mgeni siku mbili; siku ya tatu mpe jembe — A guest for two days; the third day give them a hoe',
  'Haba na haba hujaza kibaba — Little by little fills the measure',
  'Mtegemea cha nduguye hufa maskini — He who depends on his relatives dies poor',
  'Mvumilivu hula mbivu — The patient one eats ripe fruit',
  'Akili ni mali — Wisdom is wealth',
  'Maji yakimwagika hayazoleki — Spilled water cannot be gathered',
  'Elimu haina mwisho — Education has no end',
  'Jifunze kwa makosa — Learn from mistakes',
  'Msafiri kafiri — A traveler has no tribe',
  'Kuishi kwingi kuona mengi — To live long is to see much',
  'Maji ni uhai — Water is life',
  'Asante ya punda ni teke — The gratitude of a donkey is a kick'
];
function randomProverb(){return EA_PROVERBS[Math.floor(Math.random()*EA_PROVERBS.length)];}

// ── System prompt ────────────────────────────────────────────────
function sysPrompt(extra=''){return`You are AXIOM — Zawadi's personal AI software engineer, proudly built in East Africa. Claude Sonnet by Anthropic. Principal-level intelligence. Persistent memory.

You embody the Ubuntu philosophy: "Mtu ni watu" — I am because we are. You greet in Swahili naturally: Habari (hello), Karibu (welcome), Asante (thanks), Sawa (okay), Poa (cool). Sprinkle East African proverbs when giving advice.

Today's wisdom: "${randomProverb()}"

You understand the East African tech ecosystem deeply: M-Pesa mobile money, Safaricom APIs, Flutterwave/Paystack payments, iHub Nairobi, Andela, Africa's Talking, Twiga Foods tech, USSD apps, low-bandwidth optimization. You know KES, TZS, UGX currencies. You think in EAT timezone (UTC+3).

Expertise: Python, JS/TS, Go, Rust, Java, Kotlin, Swift, React, Next.js, Vue, Svelte, FastAPI, Django, Node, Flutter, PostgreSQL, Redis, Docker, K8s, AWS, Terraform, AI/ML, security, M-Pesa integration, USSD, mobile-first development.

Always write production-ready code: error handling, types, imports, edge cases. Root cause first when debugging. Push back on bad approaches. Reference memory naturally. Optimize for African internet conditions — bundle sizes, offline-first, progressive enhancement.${Mem.context()}${extra}`;}

// ── Helpers ──────────────────────────────────────────────────────
function getKey(k){if(k)return k;if(process.env.ANTHROPIC_API_KEY)return process.env.ANTHROPIC_API_KEY;try{return fs.readFileSync(KEY_FILE,'utf8').trim();}catch(e){return'';}}
function parseBody(req){return new Promise(r=>{let b='';req.on('data',c=>b+=c);req.on('end',()=>{try{r({text:b,json:JSON.parse(b)});}catch(e){r({text:b,json:{}});}});});}
function sendJson(res,data,status=200){const j=JSON.stringify(data);res.writeHead(status,{'Content-Type':'application/json','Access-Control-Allow-Origin':'*'});res.end(j);}
function cors(res){res.setHeader('Access-Control-Allow-Origin','*');res.setHeader('Access-Control-Allow-Headers','Content-Type,X-Axiom-Token');res.setHeader('Access-Control-Allow-Methods','GET,POST,PUT,DELETE,PATCH,OPTIONS');res.setHeader('X-Content-Type-Options','nosniff');}
const SKIP=['node_modules','.git','__pycache__','.axiom','dist','build','.next','.nuxt','coverage','.cache'];
function listDir(dir){const s=safe(dir);if(!s)return[];try{return fs.readdirSync(s,{withFileTypes:true}).filter(e=>!SKIP.includes(e.name)).map(e=>{try{const fp=path.join(s,e.name),st=fs.statSync(fp);return{name:e.name,type:e.isDirectory()?'dir':'file',path:fp,size:st.size,mtime:st.mtime.toISOString(),ext:path.extname(e.name).slice(1)};}catch(e){return null;}}).filter(Boolean).sort((a,b)=>a.type===b.type?a.name.localeCompare(b.name):a.type==='dir'?-1:1);}catch(e){return[];}}
function runCode(code,lang,stdin=''){return new Promise(resolve=>{const R={python:'python3',javascript:'node',bash:'bash',sh:'bash',ruby:'ruby'};const E={python:'.py',javascript:'.js',bash:'.sh',ruby:'.rb'};const runner=R[lang?.toLowerCase()];if(!runner)return resolve({output:`Language '${lang}' not supported`,error:true});const tmp=path.join(os.tmpdir(),`ax_${Date.now()}${E[lang.toLowerCase()]||'.py'}`);fs.writeFileSync(tmp,code,{mode:0o600});const p=spawn(runner,[tmp],{timeout:30000});let out='',err='';if(stdin){p.stdin.write(stdin);p.stdin.end();}p.stdout.on('data',d=>out+=d);p.stderr.on('data',d=>err+=d);p.on('close',code=>{try{fs.unlinkSync(tmp);}catch(e){}resolve({output:(out+(err?'\n'+err:'')).trim()||'(no output)',exitCode:code,error:code!==0});});p.on('error',e=>{try{fs.unlinkSync(tmp);}catch(x){}resolve({output:'Error: '+e.message,error:true});});});}
function git(cwd,...args){return new Promise(resolve=>{const s=safe(cwd);if(!s)return resolve({ok:false,out:'Path not allowed'});exec(`git -C "${s}" ${args.join(' ')}`,{timeout:15000,env:{...process.env,GIT_TERMINAL_PROMPT:'0'}},(err,out,se)=>resolve({ok:!err,out:(out||'')+(se&&!out?se:''),err:err?.message||''}));});}

// ════════════════════════════════════════════════════════════════
// PURE-NODE WEBSOCKET TERMINAL — Real bash shell, no npm needed
// ════════════════════════════════════════════════════════════════
const terminals=new Map(); // id -> {shell, sockets}

function wsAccept(key){return crypto.createHash('sha1').update(key+'258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');}

function decodeWsFrame(buf){
  try{
    if(buf.length<2)return null;
    const fin=(buf[0]&0x80)!==0,opcode=buf[0]&0x0f;
    const masked=(buf[1]&0x80)!==0;
    let len=buf[1]&0x7f,offset=2;
    if(len===126){if(buf.length<4)return null;len=buf.readUInt16BE(2);offset=4;}
    else if(len===127){if(buf.length<10)return null;len=Number(buf.readBigUInt64BE(2));offset=10;}
    if(buf.length<offset+(masked?4:0)+len)return null;
    const mask=masked?buf.slice(offset,offset+4):null;
    if(masked)offset+=4;
    const payload=Buffer.from(buf.slice(offset,offset+len));
    if(masked)for(let i=0;i<payload.length;i++)payload[i]^=mask[i%4];
    return{opcode,data:payload,totalLen:offset+len};
  }catch(e){return null;}
}

function encodeWsFrame(data){
  const b=Buffer.isBuffer(data)?data:Buffer.from(data,'utf8');
  if(b.length<126)return Buffer.concat([Buffer.from([0x81,b.length]),b]);
  if(b.length<65536)return Buffer.concat([Buffer.from([0x81,126,b.length>>8,b.length&0xff]),b]);
  const h=Buffer.alloc(10);h[0]=0x81;h[1]=127;h.writeBigUInt64BE(BigInt(b.length),2);
  return Buffer.concat([h,b]);
}

function handleWsUpgrade(req,socket,path){
  // Verify token
  const u=urlMod.parse(req.url,true);
  if(u.query.token!==CFG.token){socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');socket.destroy();return;}

  const key=req.headers['sec-websocket-key'];
  socket.write(
    'HTTP/1.1 101 Switching Protocols\r\n'+
    'Upgrade: websocket\r\nConnection: Upgrade\r\n'+
    'Sec-WebSocket-Accept: '+wsAccept(key)+'\r\n\r\n'
  );
  socket.setTimeout(0);
  socket.setNoDelay(true);

  if(path.startsWith('/ws/terminal')){
    const cwd=safe(u.query.cwd)||os.homedir();
    const termId=u.query.id||crypto.randomUUID();
    const cols=parseInt(u.query.cols)||120;
    const rows=parseInt(u.query.rows)||30;
    const reqShell=u.query.shell||'';

    // Try to reconnect to existing shell process
    const existing=terminals.get(termId);
    if(existing&&existing.shell&&!existing.shell.killed){
      // Reattach: update the socket reference so the existing onData sender uses the new socket
      const oldSocket=existing.socket;
      existing.socket=socket;
      try{if(oldSocket&&oldSocket!==socket)oldSocket.destroy();}catch(e){}
      try{socket.write(encodeWsFrame('\x1b[32m[Session restored]\x1b[0m\r\n'));}catch(e){}
      // Resize if needed
      try{if(pty)existing.shell.resize(cols,rows);}catch(e){}
      let buf=Buffer.alloc(0);
      socket.on('data',chunk=>{
        buf=Buffer.concat([buf,chunk]);
        while(buf.length>0){
          const frame=decodeWsFrame(buf);
          if(!frame)break;
          if(frame.opcode===8){try{socket.destroy();}catch(e){}break;}
          if(frame.opcode===9){try{socket.write(encodeWsFrame(Buffer.from([0x8a,0])));}catch(e){}}
          if(frame.opcode===1){
            const txt=frame.data.toString();
            if(txt.startsWith('\x1b[RESIZE:')){
              try{const parts=txt.match(/RESIZE:(\d+),(\d+)/);if(parts&&pty)existing.shell.resize(+parts[1],+parts[2]);}catch(e){}
            }else{try{existing.shell.write(txt);}catch(e){}}
          }
          if(frame.opcode===2){try{existing.shell.write(frame.data);}catch(e){}}
          buf=buf.slice(frame.totalLen);
        }
      });
      socket.on('close',()=>{/* keep shell alive for reconnect */});
      socket.on('error',()=>{/* keep shell alive for reconnect */});
      return;
    }

    // Detect user's default shell
    const SHELLS=['/bin/zsh','/bin/bash','/bin/sh'];
    let defaultShell=process.env.SHELL||'/bin/bash';
    if(reqShell){
      const allowed=['/bin/bash','/bin/zsh','/bin/sh','/usr/bin/fish','/bin/fish','python3','python','node'];
      if(allowed.includes(reqShell))defaultShell=reqShell;
    }

    if(pty){
      const shell=pty.spawn(defaultShell,[],{
        name:'xterm-256color',
        cols,rows,
        cwd,
        env:{...process.env,TERM:'xterm-256color',COLORTERM:'truecolor',FORCE_COLOR:'3',LANG:process.env.LANG||'en_US.UTF-8'}
      });
      const termEntry={shell,socket};
      terminals.set(termId,termEntry);

      // The onData handler always writes to termEntry.socket (which gets updated on reconnect)
      shell.onData(data=>{try{termEntry.socket.write(encodeWsFrame(data));}catch(e){}});
      shell.onExit(({exitCode})=>{
        try{termEntry.socket.write(encodeWsFrame(`\r\n\x1b[90m[Process exited with code ${exitCode}]\x1b[0m\r\n`));}catch(e){}
        terminals.delete(termId);
        try{termEntry.socket.destroy();}catch(e){}
      });

      let buf=Buffer.alloc(0);
      socket.on('data',chunk=>{
        buf=Buffer.concat([buf,chunk]);
        while(buf.length>0){
          const frame=decodeWsFrame(buf);
          if(!frame)break;
          if(frame.opcode===8){try{shell.kill();socket.destroy();}catch(e){}break;}
          if(frame.opcode===9){try{socket.write(encodeWsFrame(Buffer.from([0x8a,0])));}catch(e){}}
          if(frame.opcode===1){
            const txt=frame.data.toString();
            if(txt.startsWith('\x1b[RESIZE:')){
              try{
                const parts=txt.match(/RESIZE:(\d+),(\d+)/);
                if(parts)shell.resize(+parts[1],+parts[2]);
              }catch(e){}
            }else{
              try{shell.write(txt);}catch(e){}
            }
          }
          if(frame.opcode===2){try{shell.write(frame.data);}catch(e){}}
          buf=buf.slice(frame.totalLen);
        }
      });
      socket.on('close',()=>{/* keep shell alive for reconnect; shell exit handler cleans up */});
      socket.on('error',()=>{/* keep shell alive for reconnect */});

    }else{
      // Fallback: plain spawn (no PTY)
      const shell=spawn(defaultShell,['-i'],{
        env:{...process.env,TERM:'xterm-256color',COLORTERM:'truecolor',FORCE_COLOR:'1'},
        cwd
      });
      shell.stdout.on('data',d=>send(d));
      shell.stderr.on('data',d=>send(d));
      shell.on('close',()=>{send('\r\n\x1b[31m[Process exited]\x1b[0m\r\n');try{socket.destroy();}catch(e){}});

      let buf=Buffer.alloc(0);
      socket.on('data',chunk=>{
        buf=Buffer.concat([buf,chunk]);
        while(buf.length>0){
          const frame=decodeWsFrame(buf);
          if(!frame)break;
          if(frame.opcode===8){try{socket.destroy();}catch(e){}break;}
          if(frame.opcode===9){socket.write(encodeWsFrame(Buffer.from([0x8a,0])));}
          if(frame.opcode===1||frame.opcode===2){try{shell.stdin.write(frame.data);}catch(e){}}
          buf=buf.slice(frame.totalLen);
        }
      });
      socket.on('close',()=>{try{shell.kill();}catch(e){}});
      socket.on('error',()=>{try{shell.kill();}catch(e){}});
      setTimeout(()=>send(`\x1b[2J\x1b[H\x1b[32mAXIOM Terminal\x1b[0m — bash shell\r\nCwd: ${cwd}\r\n\r\n`),100);
    }

  } else if(path.startsWith('/ws/collab')){
    // Collaboration WebSocket
    const roomId=u.query.room||'default';
    const userName=decodeURIComponent(u.query.name||'Anonymous');
    const userColor='#'+Math.floor(Math.random()*0xFFFFFF).toString(16).padStart(6,'0');
    const room=getRoom(roomId);
    const user={socket,name:userName,color:userColor,cursor:{line:0,character:0},id:crypto.randomUUID()};
    room.users.push(user);
    const send=d=>{try{socket.write(encodeWsFrame(JSON.stringify(d)));}catch(e){}};
    // Send initial state
    send({type:'init',doc:room.doc,version:room.version,users:room.users.map(u=>({id:u.id,name:u.name,color:u.color,cursor:u.cursor})),userId:user.id});
    // Broadcast join
    broadcastRoom(roomId,{type:'user_join',user:{id:user.id,name:user.name,color:user.color,cursor:user.cursor}},socket);
    let buf2=Buffer.alloc(0);
    socket.on('data',chunk=>{
      buf2=Buffer.concat([buf2,chunk]);
      while(buf2.length>0){
        const frame=decodeWsFrame(buf2);if(!frame)break;
        if(frame.opcode===8){socket.destroy();break;}
        if(frame.opcode===1){
          try{
            const msg=JSON.parse(frame.data.toString());
            if(msg.type==='edit'){
              room.doc=msg.content;room.version++;
              room.history.push({user:user.name,ts:Date.now(),len:msg.content.length});
              if(room.history.length>100)room.history=room.history.slice(-50);
              broadcastRoom(roomId,{type:'edit',content:msg.content,version:room.version,userId:user.id},socket);
            }else if(msg.type==='cursor'){
              user.cursor=msg.cursor||{line:0,character:0};
              user.selection=msg.selection||null;
              broadcastRoom(roomId,{type:'cursor',userId:user.id,cursor:user.cursor,selection:user.selection,name:user.name,color:user.color},socket);
            }else if(msg.type==='chat'){
              broadcastRoom(roomId,{type:'chat',userId:user.id,name:user.name,text:msg.text,ts:Date.now()});
            }
          }catch(e){}
        }
        buf2=buf2.slice(frame.totalLen);
      }
    });
    const cleanup=()=>{
      room.users=room.users.filter(u=>u.socket!==socket);
      broadcastRoom(roomId,{type:'user_leave',userId:user.id});
      if(!room.users.length)delete collabRooms[roomId];
    };
    socket.on('close',cleanup);socket.on('error',cleanup);

  } else {
    socket.destroy();
  }
}

// ── HTTP Server ──────────────────────────────────────────────────
const server=http.createServer(async(req,res)=>{
  cors(res);
  const ip=req.socket.remoteAddress||'';
  if(req.method==='OPTIONS'){res.writeHead(204);res.end();return;}
  if(!rateOk(ip)){res.writeHead(429);res.end(JSON.stringify({error:'Rate limited'}));return;}
  const parsed=urlMod.parse(req.url,true),route=parsed.pathname,q=parsed.query;
  const{text:rawBody,json:data}=['POST','PUT','PATCH','DELETE'].includes(req.method)?await parseBody(req):{text:'',json:{}};

  const PUBLIC=['/api/ping','/api/token','/api/billing/webhook','/api/plans','/api/auth/auto-login',
    '/api/auth/providers',
    '/api/auth/github/start','/api/auth/github/callback',
    '/api/auth/google/start','/api/auth/google/callback'];
  if(route.startsWith('/api/')&&!PUBLIC.includes(route)){
    const tok=req.headers['x-axiom-token']||q.token||'';
    if(tok!==CFG.token){res.writeHead(401);res.end(JSON.stringify({error:'Invalid token'}));return;}
  }

  if(!route.startsWith('/api/')){
    const pub=path.join(__dirname,'..','public');
    let fp=route==='/'?path.join(pub,'index.html'):route==='/admin'||route==='/admin/'?path.join(pub,'admin.html'):path.join(pub,route.slice(1));
    const rfp=path.resolve(fp);
    if(!rfp.startsWith(path.resolve(pub))){res.writeHead(403);res.end('Forbidden');return;}
    if(fs.existsSync(rfp)&&fs.statSync(rfp).isFile()){const mime={'.html':'text/html','.js':'application/javascript','.css':'text/css','.svg':'image/svg+xml','.png':'image/png','.ico':'image/x-icon'};res.writeHead(200,{'Content-Type':mime[path.extname(rfp)]||'text/plain','Cache-Control':'no-store'});res.end(fs.readFileSync(rfp));return;}
    const idx=path.join(pub,route.startsWith('/admin')?'admin.html':'index.html');
    res.writeHead(200,{'Content-Type':'text/html','Cache-Control':'no-store'});
    res.end(fs.existsSync(idx)?fs.readFileSync(idx):Buffer.from('AXIOM'));return;
  }

  // System
  if(route==='/api/ping'){const tok=req.headers['x-axiom-token'];return sendJson(res,{ok:true,v:'6.0',ws_terminal:true,auth:tok===CFG.token,token:CFG.token});}
  if(route==='/api/token'&&req.method==='POST')return sendJson(res,{ok:data.token===CFG.token});
  if(route==='/api/plans')return sendJson(res,{plans:PLANS});

  // API key
  if(route==='/api/key'&&req.method==='GET'){const k=getKey();return sendJson(res,{hasKey:!!k,masked:k?k.slice(0,14)+'••••':''});}
  if(route==='/api/key'&&req.method==='POST'){if(!(data.key||'').startsWith('sk-ant-'))return sendJson(res,{error:'Invalid key'},400);fs.writeFileSync(KEY_FILE,data.key,{mode:0o600});return sendJson(res,{ok:true});}

  // Memory
  if(route==='/api/memory'){if(req.method==='GET')return sendJson(res,Mem.load());if(req.method==='PUT'){Mem.patch(data);return sendJson(res,{ok:true,memory:Mem.load()});}if(req.method==='DELETE'){Mem.clear();return sendJson(res,{ok:true});}}
  if(route==='/api/memory/fact'&&req.method==='POST'){Mem.addFact(data.f||data.fact||'');return sendJson(res,{ok:true});}
  if(route==='/api/memory/insight'&&req.method==='POST'){Mem.addInsight(data.t||'');return sendJson(res,{ok:true});}
  if(route==='/api/memory/todo'&&req.method==='POST'){Mem.addTodo(data.t||'');return sendJson(res,{ok:true});}
  if(route==='/api/memory/todo/done'&&req.method==='POST'){const m=Mem.load();const t=m.todos.find(x=>x.t===data.t);if(t)t.done=true;Mem.save();return sendJson(res,{ok:true});}
  if(route==='/api/memory/export'&&req.method==='GET'){res.writeHead(200,{'Content-Type':'application/json','Content-Disposition':'attachment; filename="axiom_memory.json"','Access-Control-Allow-Origin':'*'});res.end(JSON.stringify(Mem.load(),null,2));return;}
  if(route==='/api/session/start'&&req.method==='POST'){const m=Mem.startSession();return sendJson(res,{memory:m,sessions:m.sessions});}
  if(route==='/api/session/end'&&req.method==='POST'){if(data.s){const m=Mem.load();m.sessionNotes.unshift({s:data.s,d:new Date().toISOString()});m.sessionNotes=m.sessionNotes.slice(0,50);Mem.save();}return sendJson(res,{ok:true});}

  // Snippets
  if(route==='/api/snippets'&&req.method==='GET')return sendJson(res,Snippets.load());
  if(route==='/api/snippets'&&req.method==='POST'){Snippets.add(data.name||'Untitled',data.code||'',data.lang||'',data.desc||'');return sendJson(res,{ok:true,snippets:Snippets.load()});}
  if(route.match(/^\/api\/snippets\/[^/]+$/)&&req.method==='DELETE'){Snippets.remove(route.split('/')[3]);return sendJson(res,{ok:true});}

  // Files
  if(route==='/api/files'&&req.method==='GET'){const d=safe(q.path||os.homedir());if(!d)return sendJson(res,{error:'Not allowed'},403);return sendJson(res,{entries:listDir(d),current:d,home:os.homedir()});}
  if(route==='/api/file'&&req.method==='GET'){const s=safe(q.path);if(!s)return sendJson(res,{error:'Not allowed'},403);try{const st=fs.statSync(s);if(st.size>5*1024*1024)return sendJson(res,{error:'File too large'},400);return sendJson(res,{content:fs.readFileSync(s,'utf8'),path:s});}catch(e){return sendJson(res,{error:e.message},400);}}
  if(route==='/api/file'&&req.method==='POST'){const s=safe(data.path);if(!s)return sendJson(res,{error:'Not allowed'},403);try{fs.mkdirSync(path.dirname(s),{recursive:true});fs.writeFileSync(s,data.content??'');return sendJson(res,{ok:true});}catch(e){return sendJson(res,{error:e.message},400);}}
  if(route==='/api/file'&&req.method==='DELETE'){const s=safe(data.path);if(!s)return sendJson(res,{error:'Not allowed'},403);try{fs.unlinkSync(s);return sendJson(res,{ok:true});}catch(e){return sendJson(res,{error:e.message},400);}}
  if(route==='/api/mkdir'&&req.method==='POST'){const s=safe(data.path);if(!s)return sendJson(res,{error:'Not allowed'},403);try{fs.mkdirSync(s,{recursive:true});return sendJson(res,{ok:true});}catch(e){return sendJson(res,{error:e.message},400);}}
  if(route==='/api/rename'&&req.method==='POST'){const a=safe(data.from),b=safe(data.to);if(!a||!b)return sendJson(res,{error:'Not allowed'},403);try{fs.renameSync(a,b);return sendJson(res,{ok:true});}catch(e){return sendJson(res,{error:e.message},400);}}

  // Search
  if(route==='/api/search'&&req.method==='POST'){
    const dir=safe(data.dir||os.homedir());if(!dir)return sendJson(res,{error:'Not allowed'},403);
    const results=[];
    (function walk(d,depth){if(depth>6||results.length>120)return;try{fs.readdirSync(d,{withFileTypes:true}).forEach(e=>{if(SKIP.includes(e.name)||e.name.startsWith('.'))return;const fp=path.join(d,e.name);if(e.isDirectory()){walk(fp,depth+1);return;}if(data.filename&&e.name.toLowerCase().includes(data.filename.toLowerCase())){results.push({file:fp,name:e.name,type:'file'});return;}if(data.query){try{const lines=fs.readFileSync(fp,'utf8').split('\n');lines.forEach((line,i)=>{if(results.length>120)return;if(line.toLowerCase().includes(data.query.toLowerCase()))results.push({file:fp,line:i+1,text:line.trim().slice(0,140),name:e.name});});}catch(e){}}});}catch(e){}  })(dir,0);
    return sendJson(res,{results:results.slice(0,120)});
  }

  // Git
  if(route==='/api/git/status'&&req.method==='GET')return sendJson(res,await git(q.dir||os.homedir(),'status','--short','--branch'));
  if(route==='/api/git/log'&&req.method==='GET')return sendJson(res,await git(q.dir||os.homedir(),'log','--oneline','--decorate','-30'));
  if(route==='/api/git/diff'&&req.method==='GET')return sendJson(res,await git(q.dir||os.homedir(),'diff'));
  if(route==='/api/git/branches'&&req.method==='GET')return sendJson(res,await git(q.dir||os.homedir(),'branch','-a'));
  if(route==='/api/git/stage'&&req.method==='POST')return sendJson(res,await git(data.dir,'add',data.file||'.'));
  if(route==='/api/git/unstage'&&req.method==='POST')return sendJson(res,await git(data.dir,'restore','--staged',data.file||'.'));
  if(route==='/api/git/commit'&&req.method==='POST')return sendJson(res,await git(data.dir,'commit','-m',`"${(data.msg||'AXIOM commit').replace(/"/g,"'")}"`));
  if(route==='/api/git/pull'&&req.method==='POST')return sendJson(res,await git(data.dir,'pull','--rebase'));
  if(route==='/api/git/push'&&req.method==='POST')return sendJson(res,await git(data.dir,'push'));
  if(route==='/api/git/checkout'&&req.method==='POST')return sendJson(res,await git(data.dir,'checkout',data.branch));
  if(route==='/api/git/new-branch'&&req.method==='POST')return sendJson(res,await git(data.dir,'checkout','-b',data.branch));
  if(route==='/api/git/stash'&&req.method==='POST')return sendJson(res,await git(data.dir,'stash',data.pop?'pop':'push'));
  if(route==='/api/git/init'&&req.method==='POST')return sendJson(res,await git(data.dir,'init'));

  // Run code
  if(route==='/api/run'&&req.method==='POST'){if(!data.code||data.code.length>200000)return sendJson(res,{error:'Invalid code'},400);return sendJson(res,await runCode(data.code,data.lang||'python',data.stdin||''));}

  // AI complete
  if(route==='/api/complete'&&req.method==='POST'){
    const apiKey=getKey();if(!apiKey)return sendJson(res,{error:'No API key'},401);
    const rb=JSON.stringify({model:'claude-sonnet-4-20250514',max_tokens:400,system:'Code completion engine. Return ONLY the completion text. No markdown, no explanation, no backticks.',messages:[{role:'user',content:`Language: ${data.lang||'code'}\nCode before cursor:\n${data.prefix}\nComplete naturally from exactly where the code left off:`}]});
    try{const result=await new Promise((resolve,reject)=>{const r=https.request({hostname:'api.anthropic.com',path:'/v1/messages',method:'POST',headers:{'Content-Type':'application/json','x-api-key':apiKey,'anthropic-version':'2023-06-01','Content-Length':Buffer.byteLength(rb)}},(res)=>{let d='';res.on('data',c=>d+=c);res.on('end',()=>{try{resolve(JSON.parse(d));}catch(e){reject(e);}});});r.on('error',reject);r.write(rb);r.end();});return sendJson(res,{completion:result.content?.[0]?.text||''});}
    catch(e){return sendJson(res,{error:e.message},500);}
  }

  // AI chat streaming
  if(route==='/api/chat'&&req.method==='POST'){
    const apiKey=getKey(data.apiKey);if(!apiKey)return sendJson(res,{error:'No API key — add in Settings ⚙'},401);
    const msgs=(data.messages||[]).slice(-50);
    const fileCtx=data.fileContext?`\n\nFile open: ${data.fileName||'file'}\n\`\`\`${data.fileLang||''}\n${data.fileContext.slice(0,8000)}\n\`\`\``:'';
    // Project-aware AI context
    let projCtx='';
    if(data.projectContext){
      const pc=data.projectContext;
      const parts=['\n\n═══ PROJECT CONTEXT ═══'];
      if(pc.files)parts.push(`Project: ${pc.files} files`);
      if(pc.languages&&Object.keys(pc.languages).length)parts.push(`Languages: ${Object.entries(pc.languages).sort((a,b)=>b[1]-a[1]).slice(0,8).map(([k,v])=>k+':'+v).join(', ')}`);
      if(pc.structure?.length){parts.push('File tree:');pc.structure.slice(0,50).forEach(f=>parts.push(`  ${f.path} (${f.size>1024?(f.size/1024).toFixed(1)+'KB':f.size+'B'})`));}
      if(pc.imports?.length){parts.push('Import graph:');pc.imports.slice(0,20).forEach(i=>parts.push(`  ${i.file} → ${i.imports.slice(0,6).join(', ')}`));}
      if(pc.configFiles&&Object.keys(pc.configFiles).length){Object.entries(pc.configFiles).slice(0,3).forEach(([name,content])=>{parts.push(`\n── ${name} ──\n${content.slice(0,1500)}`);});}
      projCtx=parts.join('\n');
    }
    // Related files context
    let relCtx='';
    if(data.relatedFiles?.length){
      const rparts=['\n\n═══ RELATED FILES ═══'];
      data.relatedFiles.forEach(r=>{rparts.push(`── ${r.path} ──\n${r.content.slice(0,2000)}`);});
      relCtx=rparts.join('\n');
    }
    res.writeHead(200,{'Content-Type':'text/event-stream','Cache-Control':'no-cache','Connection':'keep-alive','Access-Control-Allow-Origin':'*','X-Accel-Buffering':'no'});
    const rb=JSON.stringify({model:'claude-sonnet-4-20250514',max_tokens:8192,stream:true,system:sysPrompt(projCtx+fileCtx+relCtx),messages:msgs});
    const apiReq=https.request({hostname:'api.anthropic.com',path:'/v1/messages',method:'POST',headers:{'Content-Type':'application/json','x-api-key':apiKey,'anthropic-version':'2023-06-01','Content-Length':Buffer.byteLength(rb)}},apiRes=>{
      let full='';apiRes.on('data',chunk=>{res.write(chunk);const s=chunk.toString();const m=s.match(/"text":"((?:[^"\\]|\\.)*)"/);if(m)full+=m[1].replace(/\\n/g,'\n').replace(/\\"/g,'"').replace(/\\\\/g,'\\');});
      apiRes.on('end',()=>{res.end();const lastUser=msgs.length?msgs[msgs.length-1].content:'';if(lastUser&&typeof lastUser==='string')Mem.extract(lastUser,full);});
    });
    apiReq.on('error',()=>{try{res.end();}catch(x){}});apiReq.write(rb);apiReq.end();return;
  }

  // Admin routes
  if(route==='/api/admin/analytics'&&req.method==='GET')return sendJson(res,await DB.getAnalytics());
  if(route==='/api/admin/users'&&req.method==='GET'){const users=await DB.getUsers({plan:q.plan,search:q.search});return sendJson(res,{users,total:users.length});}
  if(route==='/api/admin/users'&&req.method==='POST'){const u=await DB.createUser({name:data.name,email:data.email,plan:data.plan||'free'});if(u.error)return sendJson(res,u,409);return sendJson(res,{user:u});}
  if(route.match(/^\/api\/admin\/users\/[^/]+$/)&&req.method==='GET'){const u=await DB.getUser(route.split('/')[4]);if(!u)return sendJson(res,{error:'Not found'},404);return sendJson(res,{user:u,payments:await DB.getPayments({user_id:u.id})});}
  if(route.match(/^\/api\/admin\/users\/[^/]+$/)&&req.method==='PUT'){const u=await DB.updateUser(route.split('/')[4],data);return sendJson(res,{user:u});}
  if(route.match(/^\/api\/admin\/users\/[^/]+$/)&&req.method==='DELETE'){await DB.deleteUser(route.split('/')[4]);return sendJson(res,{ok:true});}
  if(route==='/api/admin/payments'&&req.method==='GET'){const pays=await DB.getPayments({days:q.days?+q.days:undefined});return sendJson(res,{payments:pays,total:pays.length,sum:pays.reduce((s,p)=>s+(+(p.amount)||0),0)});}
  if(route==='/api/admin/payments'&&req.method==='POST'){const p=await DB.recordPayment({user_id:data.user_id,email:data.email,name:data.name,plan:data.plan,amount:+data.amount||0,status:'succeeded',type:'manual'});return sendJson(res,{payment:p});}
  if(route==='/api/admin/query'&&req.method==='POST'){
    const question=data.question||'';if(!question)return sendJson(res,{error:'No question'},400);
    const local=await DB.nlQuery(question);const apiKey=getKey();if(!apiKey)return sendJson(res,{...local,ai_enhanced:false});
    const a=await DB.getAnalytics();
    const sys=`You are AXIOM Admin AI for Zawadi. Live data: ${a.overview.total_users} users, ${a.overview.paying_users} paying, $${a.revenue.total.toFixed(2)} revenue, $${a.revenue.mrr}/mo MRR. Local query: ${local.answer}. Answer concisely with insights.`;
    try{const rb=JSON.stringify({model:'claude-sonnet-4-20250514',max_tokens:800,system:sys,messages:[{role:'user',content:question}]});const result=await new Promise((resolve,reject)=>{const r=https.request({hostname:'api.anthropic.com',path:'/v1/messages',method:'POST',headers:{'Content-Type':'application/json','x-api-key':apiKey,'anthropic-version':'2023-06-01','Content-Length':Buffer.byteLength(rb)}},(res)=>{let d='';res.on('data',c=>d+=c);res.on('end',()=>{try{resolve(JSON.parse(d));}catch(e){reject(e);}});});r.on('error',reject);r.write(rb);r.end();});return sendJson(res,{...local,ai_answer:result.content?.[0]?.text||local.answer,ai_enhanced:true});}
    catch(e){return sendJson(res,{...local,ai_enhanced:false});}
  }
  if(route==='/api/admin/chat'&&req.method==='POST'){
    const apiKey=getKey();if(!apiKey)return sendJson(res,{error:'No API key'},401);
    const a=await DB.getAnalytics();const msgs=(data.messages||[]).slice(-20);
    const sys=`You are AXIOM Admin for Zawadi. Live: ${a.overview.total_users} users, $${a.revenue.mrr}/mo MRR, $${a.revenue.total.toFixed(2)} total. Give specific insights and recommendations.`;
    res.writeHead(200,{'Content-Type':'text/event-stream','Cache-Control':'no-cache','Connection':'keep-alive','Access-Control-Allow-Origin':'*','X-Accel-Buffering':'no'});
    const rb=JSON.stringify({model:'claude-sonnet-4-20250514',max_tokens:2048,stream:true,system:sys,messages:msgs});
    const apiReq=https.request({hostname:'api.anthropic.com',path:'/v1/messages',method:'POST',headers:{'Content-Type':'application/json','x-api-key':apiKey,'anthropic-version':'2023-06-01','Content-Length':Buffer.byteLength(rb)}},apiRes=>{apiRes.on('data',chunk=>res.write(chunk));apiRes.on('end',()=>res.end());});
    apiReq.on('error',()=>{try{res.end();}catch(x){}});apiReq.write(rb);apiReq.end();return;
  }
  if(route==='/api/admin/users/export'&&req.method==='GET'){const users=await DB.getUsers();const csv='id,name,email,plan,status,total_paid,chat_count,created_at\n'+users.map(u=>[u.id,u.name,u.email,u.plan,u.status,u.total_paid||0,u.chat_count||0,u.created_at].join(',')).join('\n');res.writeHead(200,{'Content-Type':'text/csv','Content-Disposition':'attachment; filename="axiom_users.csv"','Access-Control-Allow-Origin':'*'});res.end(csv);return;}

  // Lint — basic static analysis for Problems panel
  if(route==='/api/lint'&&req.method==='POST'){
    const code=data.code||'',lang=data.lang||'',problems=[];
    const lines=code.split('\n');
    lines.forEach((line,i)=>{
      const ln=i+1,tr=line.trimEnd();
      // Universal checks
      if(tr.length>200)problems.push({ln,col:201,msg:'Line too long ('+tr.length+' chars)',sev:'warning'});
      if(/\t/.test(tr))problems.push({ln,col:line.indexOf('\t')+1,msg:'Tab character (use spaces)',sev:'info'});
      if(/console\.log\b/.test(tr))problems.push({ln,col:tr.indexOf('console.log')+1,msg:'console.log left in code',sev:'warning'});
      if(/debugger\b/.test(tr))problems.push({ln,col:tr.indexOf('debugger')+1,msg:'debugger statement',sev:'error'});
      if(/\beval\s*\(/.test(tr))problems.push({ln,col:tr.indexOf('eval')+1,msg:'eval() is dangerous',sev:'error'});
      // JS/TS
      if(['javascript','typescript'].includes(lang)){
        if(/var\s+/.test(tr))problems.push({ln,col:tr.indexOf('var')+1,msg:"Use 'const' or 'let' instead of 'var'",sev:'warning'});
        if(/==(?!=)/.test(tr)&&!/===/.test(tr))problems.push({ln,col:tr.indexOf('==')+1,msg:"Use '===' instead of '=='",sev:'warning'});
        if(/\bwindow\b/.test(tr))problems.push({ln,col:tr.indexOf('window')+1,msg:'Direct window access — consider abstraction',sev:'info'});
      }
      // Python
      if(lang==='python'){
        if(/\bprint\s*\(/.test(tr)&&code.split('\n').length>10)problems.push({ln,col:tr.indexOf('print')+1,msg:'print() — remove for production',sev:'info'});
        if(/except:\s*$/.test(tr))problems.push({ln,col:tr.indexOf('except')+1,msg:'Bare except clause catches all errors',sev:'warning'});
        if(/^\s*pass\s*$/.test(tr))problems.push({ln,col:tr.indexOf('pass')+1,msg:'Empty block with pass',sev:'info'});
      }
      // Secrets
      if(/(?:password|secret|api_?key|token)\s*=\s*['"][^'"]{4,}/i.test(tr))problems.push({ln,col:1,msg:'Possible hardcoded secret/credential',sev:'error'});
      // TODO
      if(/\bTODO\b|\bFIXME\b|\bHACK\b/.test(tr)){const m=tr.match(/\b(TODO|FIXME|HACK)\b/);problems.push({ln,col:tr.indexOf(m[0])+1,msg:m[0]+': '+tr.trim(),sev:'info'});}
    });
    return sendJson(res,{problems:problems.slice(0,100)});
  }


  // ── USER AUTH ROUTES ──────────────────────────────────────────────
  // Auto-login: creates default user on first run (localhost-only, safe since server binds 127.0.0.1)
  if(route==='/api/auth/auto-login'&&req.method==='POST'){
    const d=UsersDB.load();
    if(d.users.length===0){
      const r=UsersDB.register('Zawadi','zawadi@axiom.dev','axiom2024','pro');
      if(r.error)return sendJson(res,{error:r.error},500);
      return sendJson(res,r);
    }
    const u=d.users[0];
    const{hash:_h,salt:_s,...safe}=u;
    return sendJson(res,{user:safe,token:makeJWT({id:u.id,email:u.email,plan:u.plan})});
  }
  if(route==='/api/auth/register'&&req.method==='POST'){
    if(!data.email||!data.password||data.password.length<6)return sendJson(res,{error:'Email and password (6+ chars) required'},400);
    const r=UsersDB.register(data.name||'User',data.email,data.password,data.plan||'free');
    if(r.error)return sendJson(res,r,409);
    return sendJson(res,r);
  }
  if(route==='/api/auth/login'&&req.method==='POST'){
    if(!data.email||!data.password)return sendJson(res,{error:'Email and password required'},400);
    const r=UsersDB.login(data.email,data.password);
    if(r.error)return sendJson(res,r,401);
    return sendJson(res,r);
  }
  if(route==='/api/auth/me'&&req.method==='GET'){
    const tok=req.headers['x-user-token']||q.token;
    const u=tok?UsersDB.getByToken(tok):null;
    if(!u)return sendJson(res,{error:'Not authenticated'},401);
    return sendJson(res,{user:u});
  }
  if(route==='/api/auth/profile'&&req.method==='PUT'){
    const tok=req.headers['x-user-token'];
    const me=tok?UsersDB.getByToken(tok):null;
    if(!me)return sendJson(res,{error:'Not authenticated'},401);
    const r=UsersDB.updateProfile(me.id,data);
    return sendJson(res,r);
  }
  if(route==='/api/auth/users'&&req.method==='GET'){
    // admin only
    return sendJson(res,{users:UsersDB.load().users.map(({hash,salt,...u})=>u)});
  }

  // ── OAUTH: GitHub + Google ────────────────────────────────────────
  // Reports which OAuth providers have credentials configured via env vars.
  if(route==='/api/auth/providers'&&req.method==='GET'){
    return sendJson(res,{
      github:!!(process.env.GITHUB_CLIENT_ID&&process.env.GITHUB_CLIENT_SECRET),
      google:!!(process.env.GOOGLE_CLIENT_ID&&process.env.GOOGLE_CLIENT_SECRET)
    });
  }
  // Kick off GitHub OAuth authorization flow.
  if(route==='/api/auth/github/start'&&req.method==='GET'){
    if(!process.env.GITHUB_CLIENT_ID||!process.env.GITHUB_CLIENT_SECRET)
      return sendJson(res,{error:'GitHub OAuth not configured. Set GITHUB_CLIENT_ID and GITHUB_CLIENT_SECRET.'},501);
    const state=OAuth.makeState('github');
    const redirect=OAuth.redirectUri('github',req);
    const url='https://github.com/login/oauth/authorize?'+urlMod.format({query:{
      client_id:process.env.GITHUB_CLIENT_ID,redirect_uri:redirect,scope:'read:user user:email',state,allow_signup:'true'
    }}).slice(1);
    res.writeHead(302,{Location:url});res.end();return;
  }
  // GitHub OAuth callback: exchange code → fetch profile → upsert user → redirect to /.
  if(route==='/api/auth/github/callback'&&req.method==='GET'){
    try{
      if(!OAuth.checkState('github',q.state))throw new Error('Invalid OAuth state');
      if(!q.code)throw new Error('Missing authorization code');
      const tok=await OAuth.exchangeGithub(q.code,OAuth.redirectUri('github',req));
      const profile=await OAuth.fetchGithubProfile(tok);
      const r=UsersDB.upsertOAuth('github',profile);
      return OAuth.respondSuccess(res,r);
    }catch(e){return OAuth.respondError(res,e.message);}
  }
  // Kick off Google OAuth authorization flow.
  if(route==='/api/auth/google/start'&&req.method==='GET'){
    if(!process.env.GOOGLE_CLIENT_ID||!process.env.GOOGLE_CLIENT_SECRET)
      return sendJson(res,{error:'Google OAuth not configured. Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET.'},501);
    const state=OAuth.makeState('google');
    const redirect=OAuth.redirectUri('google',req);
    const url='https://accounts.google.com/o/oauth2/v2/auth?'+urlMod.format({query:{
      client_id:process.env.GOOGLE_CLIENT_ID,redirect_uri:redirect,response_type:'code',
      scope:'openid email profile',state,access_type:'online',prompt:'select_account'
    }}).slice(1);
    res.writeHead(302,{Location:url});res.end();return;
  }
  // Google OAuth callback.
  if(route==='/api/auth/google/callback'&&req.method==='GET'){
    try{
      if(!OAuth.checkState('google',q.state))throw new Error('Invalid OAuth state');
      if(!q.code)throw new Error('Missing authorization code');
      const tok=await OAuth.exchangeGoogle(q.code,OAuth.redirectUri('google',req));
      const profile=await OAuth.fetchGoogleProfile(tok);
      const r=UsersDB.upsertOAuth('google',profile);
      return OAuth.respondSuccess(res,r);
    }catch(e){return OAuth.respondError(res,e.message);}
  }

  // ── EAST AFRICAN FEATURES ──────────────────────────────────────
  if(route==='/api/proverbs'&&req.method==='GET')return sendJson(res,{proverb:randomProverb(),all:EA_PROVERBS});
  if(route==='/api/proverb/random'&&req.method==='GET')return sendJson(res,{proverb:randomProverb()});

  // Git file timeline
  if(route==='/api/git/timeline'&&req.method==='GET'){
    const fp=q.file,dir=q.dir||os.homedir();
    if(!fp)return sendJson(res,{error:'No file specified'},400);
    const r=await git(dir,'log','--oneline','--follow','-20','--',fp);
    if(!r.ok)return sendJson(res,{entries:[],error:r.err});
    const entries=r.out.split('\n').filter(Boolean).map(l=>{const[hash,...rest]=l.split(' ');return{hash,msg:rest.join(' ')};});
    return sendJson(res,{entries});
  }
  if(route==='/api/git/file-at'&&req.method==='GET'){
    const hash=q.hash,fp=q.file,dir=q.dir||os.homedir();
    if(!hash||!fp)return sendJson(res,{error:'hash and file required'},400);
    const r=await git(dir,'show',hash+':'+fp);
    return sendJson(res,{content:r.ok?r.out:'',error:r.ok?null:r.err});
  }

  // M-Pesa STK Push (Safaricom Daraja API integration)
  const MPESA_FILE=path.join(DATA,'mpesa.json');
  if(route==='/api/billing/mpesa/config'&&req.method==='GET'){
    try{const c=JSON.parse(fs.readFileSync(MPESA_FILE,'utf8'));return sendJson(res,{configured:true,env:c.env||'sandbox'});}
    catch(e){return sendJson(res,{configured:false});}
  }
  if(route==='/api/billing/mpesa/config'&&req.method==='POST'){
    const c={consumer_key:data.consumer_key,consumer_secret:data.consumer_secret,shortcode:data.shortcode||'174379',passkey:data.passkey,callback_url:data.callback_url||`http://localhost:${PORT}/api/billing/mpesa/callback`,env:data.env||'sandbox',updated:new Date().toISOString()};
    fs.writeFileSync(MPESA_FILE,JSON.stringify(c,null,2),{mode:0o600});
    return sendJson(res,{ok:true});
  }
  if(route==='/api/billing/mpesa/stk-push'&&req.method==='POST'){
    let mpCfg;try{mpCfg=JSON.parse(fs.readFileSync(MPESA_FILE,'utf8'));}catch(e){return sendJson(res,{error:'M-Pesa not configured. Add credentials in Settings.'},400);}
    const phone=(data.phone||'').replace(/^0/,'254').replace(/^\+/,'');
    const amount=Math.round(+data.amount||0);
    if(!phone||phone.length<10)return sendJson(res,{error:'Invalid phone number'},400);
    if(!amount||amount<1)return sendJson(res,{error:'Amount must be at least 1 KES'},400);
    const baseUrl=mpCfg.env==='production'?'https://api.safaricom.co.ke':'https://sandbox.safaricom.co.ke';
    try{
      const authStr=Buffer.from(mpCfg.consumer_key+':'+mpCfg.consumer_secret).toString('base64');
      const authRes=await new Promise((resolve,reject)=>{const r=https.request(baseUrl+'/oauth/v1/generate?grant_type=client_credentials',{method:'GET',headers:{Authorization:'Basic '+authStr}},(res)=>{let d='';res.on('data',c=>d+=c);res.on('end',()=>{try{resolve(JSON.parse(d));}catch(e){reject(e);}});});r.on('error',reject);r.end();});
      if(!authRes.access_token)return sendJson(res,{error:'M-Pesa auth failed: '+(authRes.errorMessage||'check credentials')},400);
      const ts=new Date().toISOString().replace(/[-T:.Z]/g,'').slice(0,14);
      const pw=Buffer.from(mpCfg.shortcode+mpCfg.passkey+ts).toString('base64');
      const stkBody=JSON.stringify({BusinessShortCode:mpCfg.shortcode,Password:pw,Timestamp:ts,TransactionType:'CustomerPayBillOnline',Amount:amount,PartyA:phone,PartyB:mpCfg.shortcode,PhoneNumber:phone,CallBackURL:mpCfg.callback_url,AccountReference:'AXIOM-'+Date.now(),TransactionDesc:'AXIOM IDE subscription'});
      const stkRes=await new Promise((resolve,reject)=>{const r=https.request(baseUrl+'/mpesa/stkpush/v1/processrequest',{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+authRes.access_token,'Content-Length':Buffer.byteLength(stkBody)}},(res)=>{let d='';res.on('data',c=>d+=c);res.on('end',()=>{try{resolve(JSON.parse(d));}catch(e){reject(e);}});});r.on('error',reject);r.write(stkBody);r.end();});
      if(stkRes.ResponseCode==='0')return sendJson(res,{ok:true,checkoutRequestID:stkRes.CheckoutRequestID,msg:'Check your phone for M-Pesa prompt'});
      return sendJson(res,{error:stkRes.errorMessage||stkRes.ResponseDescription||'STK push failed'},400);
    }catch(e){return sendJson(res,{error:'M-Pesa request failed: '+e.message},500);}
  }
  if(route==='/api/billing/mpesa/callback'&&req.method==='POST'){
    const cb=data.Body?.stkCallback;
    if(cb){const items=cb.CallbackMetadata?.Item||[];const txn={CheckoutRequestID:cb.CheckoutRequestID,ResultCode:cb.ResultCode,ResultDesc:cb.ResultDesc};items.forEach(i=>{txn[i.Name]=i.Value;});const mpLog=path.join(DATA,'mpesa_transactions.json');let txns=[];try{txns=JSON.parse(fs.readFileSync(mpLog,'utf8'));}catch(e){}txns.unshift({...txn,received:new Date().toISOString()});fs.writeFileSync(mpLog,JSON.stringify(txns.slice(0,500),null,2),{mode:0o600});
    if(cb.ResultCode===0&&txn.Amount){await DB.recordPayment({user_id:'mpesa',email:txn.PhoneNumber||'',name:'M-Pesa',plan:'pro',amount:txn.Amount/130,status:'succeeded',type:'mpesa',mpesa_receipt:txn.MpesaReceiptNumber});}
    }return sendJson(res,{ok:true});
  }
  if(route==='/api/billing/mpesa/transactions'&&req.method==='GET'){
    const mpLog=path.join(DATA,'mpesa_transactions.json');
    try{return sendJson(res,{transactions:JSON.parse(fs.readFileSync(mpLog,'utf8'))});}
    catch(e){return sendJson(res,{transactions:[]});}
  }

  // Currency conversion (approximate rates)
  if(route==='/api/currency'&&req.method==='GET'){
    return sendJson(res,{rates:{KES:130,TZS:2650,UGX:3800,RWF:1300,ETB:57},base:'USD'});
  }

  // Format code
  if(route==='/api/format'&&req.method==='POST'){
    const code=data.code||'',lang=data.lang||'';
    let formatted=code;
    if(lang==='json'){try{formatted=JSON.stringify(JSON.parse(code),null,2);}catch(e){return sendJson(res,{error:'Invalid JSON: '+e.message},400);}}
    else if(lang==='python'){formatted=code.replace(/\t/g,'    ').replace(/[ \t]+$/gm,'').replace(/\n{3,}/g,'\n\n');}
    else if(['javascript','typescript'].includes(lang)){formatted=code.replace(/\t/g,'  ').replace(/[ \t]+$/gm,'').replace(/\n{3,}/g,'\n\n').replace(/\{(\S)/g,'{ $1').replace(/(\S)\}/g,'$1 }');}
    else{formatted=code.replace(/[ \t]+$/gm,'').replace(/\n{3,}/g,'\n\n');}
    return sendJson(res,{formatted});
  }

  // Project analysis for AI brain
  if(route==='/api/project/analyze'&&req.method==='POST'){
    const dir=safe(data.dir);if(!dir)return sendJson(res,{error:'Not allowed'},403);
    const files=[],imports=[];
    const CONFIG_NAMES=['package.json','requirements.txt','Cargo.toml','go.mod','pyproject.toml','tsconfig.json','Makefile','Dockerfile','docker-compose.yml','docker-compose.yaml','.env.example','README.md','setup.py','setup.cfg','pom.xml','build.gradle','pubspec.yaml','Gemfile','composer.json'];
    const configFiles={};
    (function walk(d,depth){if(depth>4||files.length>200)return;try{fs.readdirSync(d,{withFileTypes:true}).forEach(e=>{if(SKIP.includes(e.name)||e.name.startsWith('.'))return;const fp=path.join(d,e.name);if(e.isDirectory()){walk(fp,depth+1);return;}const rel=fp.replace(dir+'/','');files.push({name:e.name,path:rel,ext:path.extname(e.name).slice(1),size:fs.statSync(fp).size});if(CONFIG_NAMES.includes(e.name)&&depth<=1){try{configFiles[rel]=fs.readFileSync(fp,'utf8').slice(0,3000);}catch(x){}}try{const content=fs.readFileSync(fp,'utf8').slice(0,2000);const imps=[...content.matchAll(/(?:import|require|from)\s+['"]([^'"]+)['"]/g)].map(m=>m[1]);if(imps.length)imports.push({file:rel,imports:imps});}catch(e){}});}catch(e){}})(dir,0);
    const langs={};files.forEach(f=>{const ext=f.ext||'unknown';langs[ext]=(langs[ext]||0)+1;});
    return sendJson(res,{files:files.length,structure:files.slice(0,100),imports:imports.slice(0,50),languages:langs,configFiles});
  }

  // Related files for AI context (reads imports of a given file, budget-limited)
  if(route==='/api/project/related'&&req.method==='POST'){
    const dir=safe(data.dir);const filePath=safe(data.file);
    if(!dir||!filePath)return sendJson(res,{error:'Not allowed'},403);
    const budget=4000;let used=0;const related=[];
    try{
      const content=fs.readFileSync(filePath,'utf8').slice(0,5000);
      const imps=[...content.matchAll(/(?:import\s+.*?from\s+|require\s*\(\s*)['"]([^'"]+)['"]/g)].map(m=>m[1]);
      for(const imp of imps){
        if(used>=budget)break;
        if(imp.startsWith('.')){
          const exts=['','.js','.ts','.jsx','.tsx','.py','.go','.rs','/index.js','/index.ts'];
          for(const ext of exts){
            const candidate=path.resolve(path.dirname(filePath),imp+ext);
            if(candidate.startsWith(dir)&&fs.existsSync(candidate)&&fs.statSync(candidate).isFile()){
              const slice=fs.readFileSync(candidate,'utf8').slice(0,Math.min(2000,budget-used));
              if(slice){related.push({path:candidate.replace(dir+'/',''),content:slice});used+=slice.length;}
              break;
            }
          }
        }
      }
    }catch(e){}
    return sendJson(res,{related});
  }

  // Git blame
  if(route==='/api/git/blame'&&req.method==='POST'){
    const dir=safe(data.dir);const file=safe(data.file);
    if(!dir||!file)return sendJson(res,{error:'Not allowed'},403);
    return new Promise(resolve=>{
      exec(`cd "${dir}" && git blame --porcelain "${file.replace(dir+'/','')}" 2>/dev/null`,{maxBuffer:1024*1024},(err,stdout)=>{
        if(err)return resolve(sendJson(res,{error:'Not a git file',lines:[]}));
        const lines=[],raw=stdout.split('\n');let cur={};
        for(const line of raw){
          const hm=line.match(/^([0-9a-f]{40})\s+(\d+)\s+(\d+)/);
          if(hm){cur={hash:hm[1].slice(0,8),origLine:+hm[2],finalLine:+hm[3]};continue;}
          if(line.startsWith('author ')){cur.author=line.slice(7);continue;}
          if(line.startsWith('author-time ')){cur.time=+line.slice(12);continue;}
          if(line.startsWith('summary ')){cur.summary=line.slice(8);continue;}
          if(line.startsWith('\t')){lines.push({ln:cur.finalLine||lines.length+1,hash:cur.hash||'',author:(cur.author||'').slice(0,12),time:cur.time?new Date(cur.time*1000).toISOString().slice(0,10):'',summary:(cur.summary||'').slice(0,40)});cur={};}
        }
        resolve(sendJson(res,{lines}));
      });
    });
  }

  // Git line status (inline gutters: which lines are added/modified/deleted)
  if(route==='/api/git/line-status'&&req.method==='POST'){
    const dir=safe(data.dir);const file=safe(data.file);
    if(!dir||!file)return sendJson(res,{error:'Not allowed'},403);
    return new Promise(resolve=>{
      exec(`cd "${dir}" && git diff --unified=0 "${file.replace(dir+'/','')}" 2>/dev/null`,{maxBuffer:512*1024},(err,stdout)=>{
        if(err)return resolve(sendJson(res,{changes:[]}));
        const changes=[];
        for(const line of stdout.split('\n')){
          const m=line.match(/^@@\s+-(\d+)(?:,(\d+))?\s+\+(\d+)(?:,(\d+))?\s+@@/);
          if(m){
            const oldStart=+m[1],oldCount=+(m[2]||1),newStart=+m[3],newCount=+(m[4]||1);
            if(oldCount===0){for(let i=0;i<newCount;i++)changes.push({ln:newStart+i,type:'add'});}
            else if(newCount===0){changes.push({ln:newStart,type:'del'});}
            else{for(let i=0;i<newCount;i++)changes.push({ln:newStart+i,type:'mod'});}
          }
        }
        resolve(sendJson(res,{changes}));
      });
    });
  }

  // AI inline edit (Ctrl+K) — returns edited code
  if(route==='/api/ai/edit'&&req.method==='POST'){
    const apiKey=getKey(data.apiKey);if(!apiKey)return sendJson(res,{error:'No API key'},401);
    const code=data.code||'',instruction=data.instruction||'',lang=data.lang||'code',context=data.context||'';
    const sys=`You are a precise code editor. Given code and an instruction, return ONLY the modified code. No markdown, no backticks, no explanation. Just the raw code.`;
    const userMsg=`Language: ${lang}\n${context?'File context (surrounding code):\n'+context.slice(0,2000)+'\n\n':''}Code to edit:\n${code}\n\nInstruction: ${instruction}`;
    const rb=JSON.stringify({model:'claude-sonnet-4-20250514',max_tokens:4096,system:sys,messages:[{role:'user',content:userMsg}]});
    try{const result=await new Promise((resolve,reject)=>{const r=https.request({hostname:'api.anthropic.com',path:'/v1/messages',method:'POST',headers:{'Content-Type':'application/json','x-api-key':apiKey,'anthropic-version':'2023-06-01','Content-Length':Buffer.byteLength(rb)}},(res)=>{let d='';res.on('data',c=>d+=c);res.on('end',()=>{try{resolve(JSON.parse(d));}catch(e){reject(e);}});});r.on('error',reject);r.write(rb);r.end();});
    let edited=result.content?.[0]?.text||'';
    edited=edited.replace(/^```\w*\n?/,'').replace(/\n?```$/,'');
    return sendJson(res,{edited});}
    catch(e){return sendJson(res,{error:e.message},500);}
  }

  // AI Agent — multi-file editing with tool use
  if(route==='/api/agent'&&req.method==='POST'){
    const apiKey=getKey(data.apiKey);if(!apiKey)return sendJson(res,{error:'No API key'},401);
    const instruction=data.instruction||'';
    const dir=safe(data.dir);if(!dir)return sendJson(res,{error:'No project open'},400);
    const fileCtx=data.fileContext||'';
    const projCtx=data.projectContext?JSON.stringify(data.projectContext).slice(0,3000):'';
    const sys=`You are AXIOM Agent, an AI coding assistant that can read and edit files. You are given a project directory and an instruction.
Respond with a JSON array of steps. Each step is an object with:
- "action": one of "read", "write", "edit", "run"
- "path": relative file path (for read/write/edit)
- "content": new content (for write)
- "find": text to find (for edit)
- "replace": replacement text (for edit)
- "command": shell command (for run)
- "explanation": brief explanation of what this step does

Example: [{"action":"edit","path":"src/app.js","find":"console.log","replace":"logger.info","explanation":"Replace console.log with logger"}]
Return ONLY valid JSON array. No markdown.`;
    const userMsg=`Project: ${dir}\n${projCtx?'Project info: '+projCtx+'\n':''}${fileCtx?'Current file:\n'+fileCtx.slice(0,4000)+'\n':''}Instruction: ${instruction}`;
    const rb=JSON.stringify({model:'claude-sonnet-4-20250514',max_tokens:8192,system:sys,messages:[{role:'user',content:userMsg}]});
    try{
      const result=await new Promise((resolve,reject)=>{const r=https.request({hostname:'api.anthropic.com',path:'/v1/messages',method:'POST',headers:{'Content-Type':'application/json','x-api-key':apiKey,'anthropic-version':'2023-06-01','Content-Length':Buffer.byteLength(rb)}},(res)=>{let d='';res.on('data',c=>d+=c);res.on('end',()=>{try{resolve(JSON.parse(d));}catch(e){reject(e);}});});r.on('error',reject);r.write(rb);r.end();});
      let text=result.content?.[0]?.text||'[]';
      text=text.replace(/^```\w*\n?/,'').replace(/\n?```$/,'');
      let steps;try{steps=JSON.parse(text);}catch(e){return sendJson(res,{error:'AI returned invalid JSON',raw:text.slice(0,500)});}
      // Execute steps
      const results=[];
      for(const step of steps.slice(0,20)){
        try{
          if(step.action==='read'){
            const fp=path.resolve(dir,step.path);if(!fp.startsWith(dir)){results.push({...step,status:'denied'});continue;}
            const content=fs.readFileSync(fp,'utf8').slice(0,10000);
            results.push({...step,status:'ok',content:content.slice(0,200)+'...'});
          }else if(step.action==='write'){
            const fp=path.resolve(dir,step.path);if(!fp.startsWith(dir)){results.push({...step,status:'denied'});continue;}
            fs.mkdirSync(path.dirname(fp),{recursive:true});
            fs.writeFileSync(fp,step.content||'');
            results.push({...step,status:'ok',content:undefined});
          }else if(step.action==='edit'){
            const fp=path.resolve(dir,step.path);if(!fp.startsWith(dir)){results.push({...step,status:'denied'});continue;}
            let content=fs.readFileSync(fp,'utf8');
            if(content.includes(step.find)){content=content.replace(step.find,step.replace||'');fs.writeFileSync(fp,content);results.push({...step,status:'ok'});}
            else results.push({...step,status:'not_found'});
          }else if(step.action==='run'){
            const out=await new Promise(resolve=>{exec(step.command,{cwd:dir,timeout:15000,maxBuffer:512*1024},(err,stdout,stderr)=>{resolve({stdout:(stdout||'').slice(0,500),stderr:(stderr||'').slice(0,500),code:err?err.code:0});});});
            results.push({...step,status:'ok',output:out});
          }
        }catch(e){results.push({...step,status:'error',error:e.message});}
      }
      return sendJson(res,{steps:results});
    }catch(e){return sendJson(res,{error:e.message},500);}
  }

  // Test discovery
  if(route==='/api/tests/discover'&&req.method==='POST'){
    const dir=safe(data.dir);if(!dir)return sendJson(res,{error:'Not allowed'},403);
    const tests=[];
    const testPatterns=[/test_.*\.py$/,/.*_test\.py$/,/.*\.test\.[jt]sx?$/,/.*\.spec\.[jt]sx?$/,/.*_test\.go$/,/.*_test\.rs$/];
    (function walk(d,depth){if(depth>4||tests.length>100)return;try{fs.readdirSync(d,{withFileTypes:true}).forEach(e=>{if(SKIP.includes(e.name)||e.name.startsWith('.'))return;const fp=path.join(d,e.name);if(e.isDirectory()){walk(fp,depth+1);return;}if(testPatterns.some(p=>p.test(e.name))){const rel=fp.replace(dir+'/','');tests.push({file:rel,name:e.name,lang:path.extname(e.name).slice(1)});}});}catch(e){}})(dir,0);
    return sendJson(res,{tests});
  }

  // Test runner
  if(route==='/api/tests/run'&&req.method==='POST'){
    const dir=safe(data.dir);if(!dir)return sendJson(res,{error:'Not allowed'},403);
    const file=data.file||'';const lang=data.lang||'';
    let cmd='';
    if(lang==='py'||file.endsWith('.py'))cmd=`cd "${dir}" && python3 -m pytest "${file}" -v --tb=short 2>&1 || python3 -m unittest "${file.replace(/\//g,'.').replace(/\.py$/,'')}" -v 2>&1`;
    else if(file.match(/\.(test|spec)\.[jt]sx?$/))cmd=`cd "${dir}" && npx jest "${file}" --no-coverage 2>&1 || npx vitest run "${file}" 2>&1`;
    else if(file.endsWith('_test.go'))cmd=`cd "${dir}" && go test -v -run . "./${path.dirname(file)}" 2>&1`;
    else cmd=`cd "${dir}" && echo "No test runner configured for ${file}"`;
    return new Promise(resolve=>{
      exec(cmd,{timeout:30000,maxBuffer:1024*1024},(err,stdout,stderr)=>{
        resolve(sendJson(res,{output:(stdout||'')+(stderr?'\n'+stderr:''),exitCode:err?err.code:0}));
      });
    });
  }

  // ══════════════ LSP ENDPOINTS ══════════════
  // Start/check LSP for a language
  if(route==='/api/lsp/start'&&req.method==='POST'){
    const dir=safe(data.dir);const lang=data.lang||'';
    if(!dir||!lang)return sendJson(res,{error:'dir and lang required'},400);
    const srv=await startLsp(lang,dir);
    if(!srv)return sendJson(res,{error:'No language server found for '+lang+'. Install one: pyright, typescript-language-server, gopls, rust-analyzer, clangd',available:false});
    return sendJson(res,{ok:true,lang,available:true,initialized:srv.initialized});
  }
  // LSP: open document
  if(route==='/api/lsp/didOpen'&&req.method==='POST'){
    const dir=safe(data.dir);const lang=data.lang||'';const filePath=data.file||'';const content=data.content||'';
    if(!dir||!lang||!filePath)return sendJson(res,{error:'Missing params'},400);
    const srv=await startLsp(lang,dir);if(!srv)return sendJson(res,{error:'No LSP'});
    await lspOpen(srv,filePath,content,lang);
    return sendJson(res,{ok:true});
  }
  // LSP: document changed
  if(route==='/api/lsp/didChange'&&req.method==='POST'){
    const dir=safe(data.dir);const lang=data.lang||'';const filePath=data.file||'';const content=data.content||'';const version=data.version||1;
    if(!dir||!lang||!filePath)return sendJson(res,{error:'Missing params'},400);
    const srv=await startLsp(lang,dir);if(!srv)return sendJson(res,{error:'No LSP'});
    await lspChange(srv,filePath,content,version);
    // Return diagnostics
    const uri=fileToUri(filePath);
    await new Promise(r=>setTimeout(r,300)); // Brief wait for diagnostics
    return sendJson(res,{ok:true,diagnostics:srv.diagnostics[uri]||[]});
  }
  // LSP: completion
  if(route==='/api/lsp/completion'&&req.method==='POST'){
    const dir=safe(data.dir);const lang=data.lang||'';const filePath=data.file||'';const line=data.line||0;const character=data.character||0;
    if(!dir||!lang||!filePath)return sendJson(res,{error:'Missing params'},400);
    const srv=await startLsp(lang,dir);if(!srv)return sendJson(res,{items:[]});
    if(data.content)await lspOpen(srv,filePath,data.content,lang);
    try{
      const result=await lspSend(srv,'textDocument/completion',{textDocument:{uri:fileToUri(filePath)},position:{line,character}});
      const items=(result?.items||result||[]).slice(0,50).map(i=>({label:i.label,kind:i.kind,detail:i.detail||'',documentation:typeof i.documentation==='string'?i.documentation:i.documentation?.value||'',insertText:i.insertText||i.textEdit?.newText||i.label,sortText:i.sortText||''}));
      return sendJson(res,{items});
    }catch(e){return sendJson(res,{items:[],error:e.message});}
  }
  // LSP: hover
  if(route==='/api/lsp/hover'&&req.method==='POST'){
    const dir=safe(data.dir);const lang=data.lang||'';const filePath=data.file||'';const line=data.line||0;const character=data.character||0;
    if(!dir||!lang||!filePath)return sendJson(res,{error:'Missing params'},400);
    const srv=await startLsp(lang,dir);if(!srv)return sendJson(res,{contents:''});
    try{
      const result=await lspSend(srv,'textDocument/hover',{textDocument:{uri:fileToUri(filePath)},position:{line,character}});
      const contents=result?.contents;
      let text='';
      if(typeof contents==='string')text=contents;
      else if(contents?.value)text=contents.value;
      else if(Array.isArray(contents))text=contents.map(c=>typeof c==='string'?c:c.value||'').join('\n');
      return sendJson(res,{contents:text,range:result?.range||null});
    }catch(e){return sendJson(res,{contents:'',error:e.message});}
  }
  // LSP: go to definition
  if(route==='/api/lsp/definition'&&req.method==='POST'){
    const dir=safe(data.dir);const lang=data.lang||'';const filePath=data.file||'';const line=data.line||0;const character=data.character||0;
    if(!dir||!lang||!filePath)return sendJson(res,{error:'Missing params'},400);
    const srv=await startLsp(lang,dir);if(!srv)return sendJson(res,{locations:[]});
    try{
      const result=await lspSend(srv,'textDocument/definition',{textDocument:{uri:fileToUri(filePath)},position:{line,character}});
      const locs=Array.isArray(result)?result:result?[result]:[];
      return sendJson(res,{locations:locs.map(l=>({uri:l.uri||l.targetUri||'',range:l.range||l.targetSelectionRange||{start:{line:0,character:0},end:{line:0,character:0}}}))});
    }catch(e){return sendJson(res,{locations:[],error:e.message});}
  }
  // LSP: find references
  if(route==='/api/lsp/references'&&req.method==='POST'){
    const dir=safe(data.dir);const lang=data.lang||'';const filePath=data.file||'';const line=data.line||0;const character=data.character||0;
    if(!dir||!lang||!filePath)return sendJson(res,{error:'Missing params'},400);
    const srv=await startLsp(lang,dir);if(!srv)return sendJson(res,{locations:[]});
    try{
      const result=await lspSend(srv,'textDocument/references',{textDocument:{uri:fileToUri(filePath)},position:{line,character},context:{includeDeclaration:true}});
      return sendJson(res,{locations:(result||[]).slice(0,100).map(l=>({uri:l.uri||'',range:l.range||{start:{line:0,character:0},end:{line:0,character:0}}}))});
    }catch(e){return sendJson(res,{locations:[],error:e.message});}
  }
  // LSP: rename
  if(route==='/api/lsp/rename'&&req.method==='POST'){
    const dir=safe(data.dir);const lang=data.lang||'';const filePath=data.file||'';const line=data.line||0;const character=data.character||0;const newName=data.newName||'';
    if(!dir||!lang||!filePath||!newName)return sendJson(res,{error:'Missing params'},400);
    const srv=await startLsp(lang,dir);if(!srv)return sendJson(res,{error:'No LSP'});
    try{
      const result=await lspSend(srv,'textDocument/rename',{textDocument:{uri:fileToUri(filePath)},position:{line,character},newName});
      if(result?.message)return sendJson(res,{error:result.message});
      const changes={};
      if(result?.changes){Object.entries(result.changes).forEach(([uri,edits])=>{changes[uri.replace('file://','')]=edits;});}
      if(result?.documentChanges){result.documentChanges.forEach(dc=>{if(dc.textDocument)changes[dc.textDocument.uri.replace('file://','')]=dc.edits;});}
      return sendJson(res,{changes});
    }catch(e){return sendJson(res,{error:e.message});}
  }
  // LSP: signature help
  if(route==='/api/lsp/signature'&&req.method==='POST'){
    const dir=safe(data.dir);const lang=data.lang||'';const filePath=data.file||'';const line=data.line||0;const character=data.character||0;
    if(!dir||!lang||!filePath)return sendJson(res,{error:'Missing params'},400);
    const srv=await startLsp(lang,dir);if(!srv)return sendJson(res,{signatures:[]});
    try{
      const result=await lspSend(srv,'textDocument/signatureHelp',{textDocument:{uri:fileToUri(filePath)},position:{line,character}});
      return sendJson(res,{signatures:result?.signatures||[],activeSignature:result?.activeSignature||0,activeParameter:result?.activeParameter||0});
    }catch(e){return sendJson(res,{signatures:[]});}
  }
  // LSP: formatting
  if(route==='/api/lsp/format'&&req.method==='POST'){
    const dir=safe(data.dir);const lang=data.lang||'';const filePath=data.file||'';
    if(!dir||!lang||!filePath)return sendJson(res,{error:'Missing params'},400);
    const srv=await startLsp(lang,dir);if(!srv)return sendJson(res,{edits:[]});
    try{
      const result=await lspSend(srv,'textDocument/formatting',{textDocument:{uri:fileToUri(filePath)},options:{tabSize:data.tabSize||2,insertSpaces:true}});
      return sendJson(res,{edits:result||[]});
    }catch(e){return sendJson(res,{edits:[]});}
  }
  // LSP: code actions
  if(route==='/api/lsp/codeAction'&&req.method==='POST'){
    const dir=safe(data.dir);const lang=data.lang||'';const filePath=data.file||'';
    const range=data.range||{start:{line:0,character:0},end:{line:0,character:0}};
    if(!dir||!lang||!filePath)return sendJson(res,{error:'Missing params'},400);
    const srv=await startLsp(lang,dir);if(!srv)return sendJson(res,{actions:[]});
    try{
      const uri=fileToUri(filePath);
      const result=await lspSend(srv,'textDocument/codeAction',{textDocument:{uri},range,context:{diagnostics:srv.diagnostics[uri]||[]}});
      return sendJson(res,{actions:(result||[]).slice(0,20).map(a=>({title:a.title,kind:a.kind||'',edit:a.edit||null,command:a.command||null}))});
    }catch(e){return sendJson(res,{actions:[]});}
  }
  // LSP: semantic tokens
  if(route==='/api/lsp/semanticTokens'&&req.method==='POST'){
    const dir=safe(data.dir);const lang=data.lang||'';const filePath=data.file||'';
    if(!dir||!lang||!filePath)return sendJson(res,{error:'Missing params'},400);
    const srv=await startLsp(lang,dir);if(!srv)return sendJson(res,{data:[]});
    try{
      const result=await lspSend(srv,'textDocument/semanticTokens/full',{textDocument:{uri:fileToUri(filePath)}});
      return sendJson(res,{data:result?.data||[]});
    }catch(e){return sendJson(res,{data:[]});}
  }
  // LSP: diagnostics (poll)
  if(route==='/api/lsp/diagnostics'&&req.method==='POST'){
    const dir=safe(data.dir);const lang=data.lang||'';const filePath=data.file||'';
    if(!dir||!lang||!filePath)return sendJson(res,{diagnostics:[]});
    const key=lang+'::'+dir;const srv=lspServers[key];
    if(!srv)return sendJson(res,{diagnostics:[]});
    return sendJson(res,{diagnostics:srv.diagnostics[fileToUri(filePath)]||[]});
  }
  // LSP: available servers
  if(route==='/api/lsp/available'&&req.method==='GET'){
    const avail={};
    Object.keys(LSP_CMDS).forEach(l=>{avail[l]=!!getLspBin(l);});
    return sendJson(res,{servers:avail});
  }

  // ══════════════ DEBUGGER ENDPOINTS ══════════════
  if(route==='/api/debug/start'&&req.method==='POST'){
    const dir=safe(data.dir);const lang=data.lang||'';const file=data.file||'';
    if(!dir||!lang||!file)return sendJson(res,{error:'Missing params'},400);
    const result=startDapSession(lang,file,dir);
    return sendJson(res,result);
  }
  if(route==='/api/debug/status'&&req.method==='POST'){
    const id=data.id||'';const sess=debugSessions[id];
    if(!sess)return sendJson(res,{error:'No session'});
    return sendJson(res,{id,lang:sess.lang,file:sess.file,port:sess.port,exited:sess.exited,output:(sess.proc?'':'')+(sess.output||'').slice(-2000)});
  }
  if(route==='/api/debug/stop'&&req.method==='POST'){
    const id=data.id||'';const sess=debugSessions[id];
    if(!sess)return sendJson(res,{error:'No session'});
    try{sess.proc.kill();}catch(e){}
    delete debugSessions[id];
    return sendJson(res,{ok:true});
  }
  if(route==='/api/debug/list'&&req.method==='GET'){
    const sessions=Object.entries(debugSessions).map(([id,s])=>({id,lang:s.lang,file:s.file,port:s.port,exited:s.exited}));
    return sendJson(res,{sessions});
  }

  // ══════════════ TASK RUNNER ENDPOINTS ══════════════
  if(route==='/api/tasks/detect'&&req.method==='POST'){
    const dir=safe(data.dir);if(!dir)return sendJson(res,{error:'Not allowed'},403);
    return sendJson(res,{tasks:detectTasks(dir)});
  }
  if(route==='/api/tasks/run'&&req.method==='POST'){
    const dir=safe(data.dir);const cmd=data.cmd||'';
    if(!dir||!cmd)return sendJson(res,{error:'Missing params'},400);
    return new Promise(resolve=>{
      exec(cmd,{cwd:dir,timeout:60000,maxBuffer:2*1024*1024},(err,stdout,stderr)=>{
        resolve(sendJson(res,{output:(stdout||'')+(stderr?'\n'+stderr:''),exitCode:err?err.code||1:0}));
      });
    });
  }

  // ══════════════ FORMAT ENDPOINTS ══════════════
  if(route==='/api/format'&&req.method==='POST'){
    const dir=safe(data.dir);const lang=data.lang||'';const content=data.content||'';const filePath=data.file||'';
    if(!dir)return sendJson(res,{error:'Not allowed'},403);
    // Try LSP formatting first
    const srv=lspServers[lang+'::'+dir];
    if(srv&&srv.initialized&&filePath){
      try{
        const edits=await lspSend(srv,'textDocument/formatting',{textDocument:{uri:fileToUri(filePath)},options:{tabSize:data.tabSize||2,insertSpaces:true}});
        if(edits&&edits.length)return sendJson(res,{formatted:applyTextEdits(content,edits),source:'lsp'});
      }catch(e){}
    }
    // Fallback to CLI formatters
    let cmd='';
    if(lang==='python'&&findBin('black'))cmd='black --quiet -';
    else if(lang==='python'&&findBin('autopep8'))cmd='autopep8 -';
    else if((lang==='javascript'||lang==='typescript'||lang==='json'||lang==='css'||lang==='html')&&findBin('prettier'))cmd=`prettier --parser ${lang==='javascript'?'babel':lang} --stdin-filepath dummy.${lang==='javascript'?'js':lang==='typescript'?'ts':lang}`;
    else if(lang==='go'&&findBin('gofmt'))cmd='gofmt';
    else if(lang==='rust'&&findBin('rustfmt'))cmd='rustfmt --edition 2021';
    else if(lang==='c'||lang==='cpp'){if(findBin('clang-format'))cmd='clang-format';}
    if(!cmd)return sendJson(res,{formatted:content,source:'none'});
    return new Promise(resolve=>{
      const p=exec(cmd,{cwd:dir,timeout:10000,maxBuffer:1024*1024},(err,stdout,stderr)=>{
        if(err||!stdout.trim())return resolve(sendJson(res,{formatted:content,source:'error',error:stderr||err?.message}));
        resolve(sendJson(res,{formatted:stdout,source:'cli'}));
      });
      p.stdin.write(content);p.stdin.end();
    });
  }

  // ══════════════ ADVANCED GIT ENDPOINTS ══════════════
  if(route==='/api/git/cherry-pick'&&req.method==='POST'){
    const dir=safe(data.dir);const hash=data.hash||'';
    if(!dir||!hash)return sendJson(res,{error:'Missing params'},400);
    return new Promise(resolve=>{exec(`cd "${dir}" && git cherry-pick ${hash} 2>&1`,{maxBuffer:512*1024},(err,out)=>{resolve(sendJson(res,{output:out||'',ok:!err}));});});
  }
  if(route==='/api/git/tags'&&req.method==='GET'){
    const dir=safe(q.dir);if(!dir)return sendJson(res,{error:'Not allowed'},403);
    return new Promise(resolve=>{exec(`cd "${dir}" && git tag -l --sort=-version:refname 2>/dev/null`,{maxBuffer:256*1024},(err,out)=>{resolve(sendJson(res,{tags:(out||'').trim().split('\n').filter(Boolean)}));});});
  }
  if(route==='/api/git/tag'&&req.method==='POST'){
    const dir=safe(data.dir);const name=data.name||'';const msg=data.message||'';
    if(!dir||!name)return sendJson(res,{error:'Missing params'},400);
    const cmd=msg?`cd "${dir}" && git tag -a "${name}" -m "${msg.replace(/"/g,'\\"')}" 2>&1`:`cd "${dir}" && git tag "${name}" 2>&1`;
    return new Promise(resolve=>{exec(cmd,{maxBuffer:256*1024},(err,out)=>{resolve(sendJson(res,{output:out||'',ok:!err}));});});
  }
  if(route==='/api/git/stash'&&req.method==='POST'){
    const dir=safe(data.dir);const action=data.action||'push';
    if(!dir)return sendJson(res,{error:'Not allowed'},403);
    let cmd;
    if(action==='push')cmd=`cd "${dir}" && git stash push -m "${(data.message||'AXIOM stash').replace(/"/g,'\\"')}" 2>&1`;
    else if(action==='pop')cmd=`cd "${dir}" && git stash pop 2>&1`;
    else if(action==='list')cmd=`cd "${dir}" && git stash list 2>&1`;
    else if(action==='drop')cmd=`cd "${dir}" && git stash drop ${data.index||0} 2>&1`;
    else cmd=`cd "${dir}" && git stash ${action} 2>&1`;
    return new Promise(resolve=>{exec(cmd,{maxBuffer:256*1024},(err,out)=>{resolve(sendJson(res,{output:out||'',ok:!err}));});});
  }
  if(route==='/api/git/submodules'&&req.method==='GET'){
    const dir=safe(q.dir);if(!dir)return sendJson(res,{error:'Not allowed'},403);
    return new Promise(resolve=>{exec(`cd "${dir}" && git submodule status 2>/dev/null`,{maxBuffer:256*1024},(err,out)=>{
      const subs=(out||'').trim().split('\n').filter(Boolean).map(l=>{const m=l.trim().match(/^([+-U ]?)([0-9a-f]+)\s+(\S+)/);return m?{status:m[1],hash:m[2].slice(0,8),path:m[3]}:null;}).filter(Boolean);
      resolve(sendJson(res,{submodules:subs}));
    });});
  }
  if(route==='/api/git/rebase'&&req.method==='POST'){
    const dir=safe(data.dir);const action=data.action||'';const onto=data.onto||'';
    if(!dir)return sendJson(res,{error:'Not allowed'},403);
    let cmd;
    if(action==='continue')cmd=`cd "${dir}" && git rebase --continue 2>&1`;
    else if(action==='abort')cmd=`cd "${dir}" && git rebase --abort 2>&1`;
    else if(action==='skip')cmd=`cd "${dir}" && git rebase --skip 2>&1`;
    else if(onto)cmd=`cd "${dir}" && git rebase ${onto} 2>&1`;
    else return sendJson(res,{error:'Specify onto branch or action'},400);
    return new Promise(resolve=>{exec(cmd,{maxBuffer:512*1024},(err,out)=>{resolve(sendJson(res,{output:out||'',ok:!err}));});});
  }

  // Chat history persistence
  if(route==='/api/chats'&&req.method==='GET'){const chats=Chats.load();return sendJson(res,{chats:chats.map(c=>({id:c.id,title:c.title,lang:c.lang,messageCount:c.messages?.length||0,created:c.created,updated:c.updated}))});}
  if(route==='/api/chats'&&req.method==='POST'){const chat=Chats.add(data.title||'New Chat',data.messages||[],data.lang||'');return sendJson(res,{chat});}
  if(route.match(/^\/api\/chats\/[^/]+$/)&&req.method==='GET'){const chat=Chats.get(route.split('/')[3]);if(!chat)return sendJson(res,{error:'Not found'},404);return sendJson(res,{chat});}
  if(route.match(/^\/api\/chats\/[^/]+$/)&&req.method==='PUT'){const chat=Chats.update(route.split('/')[3],data.messages,data.title);if(!chat)return sendJson(res,{error:'Not found'},404);return sendJson(res,{chat});}
  if(route.match(/^\/api\/chats\/[^/]+$/)&&req.method==='DELETE'){Chats.remove(route.split('/')[3]);return sendJson(res,{ok:true});}

  sendJson(res,{error:'Not found'},404);
});

// ── WebSocket upgrade handler ────────────────────────────────────
server.on('upgrade',(req,socket,head)=>{
  const u=urlMod.parse(req.url,true);
  if(u.pathname.startsWith('/ws/')){
    socket.on('error',()=>{});
    handleWsUpgrade(req,socket,u.pathname);
  } else {
    socket.destroy();
  }
});

// ── Start ────────────────────────────────────────────────────────
server.listen(PORT,'127.0.0.1',async ()=>{
  await DB.seedDemo();const mem=Mem.startSession();const hasKey=!!getKey();
  console.clear();
  console.log('\n  ╔══════════════════════════════════════════════════════════════╗');
  console.log('  ║              A X I O M  v6 — East Africa Edition            ║');
  console.log('  ║   Real Terminal · CodeMirror Editor · Full IDE Features      ║');
  console.log('  ║   Proudly Built for East African Developers                  ║');
  console.log('  ╚══════════════════════════════════════════════════════════════╝');
  console.log(`\n  ✦  Karibu!  →  http://localhost:${PORT}`);
  console.log(`  ✦  Admin    →  http://localhost:${PORT}/admin`);
  console.log(`  ✦  Terminal →  WebSocket (ws://localhost:${PORT}/ws/terminal)`);
  console.log(`  ✦  Session  →  #${mem.sessions}`);
  console.log(`  ✦  API Key  →  ${hasKey?'✅ Ready':'⚠️  Add in Settings'}`);
  console.log(`\n  Token: ${CFG.token}\n`);
  const open=process.platform==='darwin'?'open':process.platform==='win32'?'start':'xdg-open';
  require('child_process').exec(`${open} http://localhost:${PORT}`);
});

// ════ USER AUTH — Sign in like Cursor/Windsurf/Zed ════
const USERS_FILE = path.join(os.homedir(),'.axiom','users.json');

function hashPw(pw,salt){return crypto.createHmac('sha256',salt).update(pw).digest('hex');}
function makeSalt(){return crypto.randomBytes(16).toString('hex');}
function makeJWT(payload){
  const h=Buffer.from(JSON.stringify({alg:'HS256',typ:'JWT'})).toString('base64url');
  const p=Buffer.from(JSON.stringify({...payload,iat:Date.now()})).toString('base64url');
  const sig=crypto.createHmac('sha256',CFG.token).update(h+'.'+p).digest('base64url');
  return h+'.'+p+'.'+sig;
}
function verifyJWT(tok){
  try{
    const[h,p,sig]=tok.split('.');
    const expected=crypto.createHmac('sha256',CFG.token).update(h+'.'+p).digest('base64url');
    if(sig!==expected)return null;
    const payload=JSON.parse(Buffer.from(p,'base64url').toString());
    if(Date.now()-payload.iat > 30*24*60*60*1000)return null; // 30 day expiry
    return payload;
  }catch(e){return null;}
}

const UsersDB={
  load(){try{return JSON.parse(fs.readFileSync(USERS_FILE,'utf8'));}catch(e){return{users:[]}}},
  save(d){fs.mkdirSync(path.dirname(USERS_FILE),{recursive:true});fs.writeFileSync(USERS_FILE,JSON.stringify(d,null,2));},
  register(name,email,pw,plan='free'){
    const d=this.load();
    if(d.users.find(u=>u.email.toLowerCase()===email.toLowerCase()))return{error:'Email already registered'};
    const salt=makeSalt(),hash=hashPw(pw,salt);
    const u={id:crypto.randomUUID(),name,email:email.toLowerCase(),plan,role:'user',
      hash,salt,avatar:null,created_at:new Date().toISOString(),last_seen:null,
      api_key:null,total_cost:0,chat_count:0,settings:{}};
    d.users.push(u);this.save(d);
    const{hash:_h,salt:_s,...safe}=u;
    return{user:safe,token:makeJWT({id:u.id,email:u.email,plan:u.plan})};
  },
  login(email,pw){
    const d=this.load();
    const u=d.users.find(x=>x.email.toLowerCase()===email.toLowerCase());
    if(!u)return{error:'No account with that email'};
    if(hashPw(pw,u.salt)!==u.hash)return{error:'Wrong password'};
    u.last_seen=new Date().toISOString();this.save(d);
    const{hash:_h,salt:_s,...safe}=u;
    return{user:safe,token:makeJWT({id:u.id,email:u.email,plan:u.plan})};
  },
  getByToken(tok){
    const p=verifyJWT(tok);if(!p)return null;
    const d=this.load();const u=d.users.find(x=>x.id===p.id);
    if(!u)return null;
    const{hash:_h,salt:_s,...safe}=u;return safe;
  },
  updateProfile(id,patch){
    const d=this.load();const u=d.users.find(x=>x.id===id);
    if(!u)return{error:'Not found'};
    if(patch.name)u.name=patch.name;
    if(patch.avatar)u.avatar=patch.avatar;
    if(patch.newPassword&&patch.currentPassword){
      if(hashPw(patch.currentPassword,u.salt)!==u.hash)return{error:'Wrong current password'};
      u.salt=makeSalt();u.hash=hashPw(patch.newPassword,u.salt);
    }
    this.save(d);
    const{hash:_h,salt:_s,...safe}=u;return{user:safe};
  },
  // Find-or-create a user from an OAuth provider profile. Matches first by
  // provider+provider_id, then falls back to email so pre-existing accounts
  // get linked instead of duplicated.
  upsertOAuth(provider,profile){
    if(!profile||!profile.id)return{error:'OAuth profile missing id'};
    const d=this.load();
    const pid=String(profile.id);
    const email=(profile.email||'').toLowerCase();
    let u=d.users.find(x=>x.oauth&&x.oauth[provider]&&x.oauth[provider].id===pid);
    if(!u&&email)u=d.users.find(x=>x.email.toLowerCase()===email);
    if(u){
      u.oauth=u.oauth||{};
      u.oauth[provider]={id:pid,username:profile.username||'',linked_at:new Date().toISOString()};
      if(!u.avatar&&profile.avatar)u.avatar=profile.avatar;
      u.last_seen=new Date().toISOString();
    }else{
      u={id:crypto.randomUUID(),name:profile.name||profile.username||'User',
        email:email||(pid+'@'+provider+'.oauth'),plan:'free',role:'user',
        hash:null,salt:null,avatar:profile.avatar||null,
        created_at:new Date().toISOString(),last_seen:new Date().toISOString(),
        api_key:null,total_cost:0,chat_count:0,settings:{},
        oauth:{[provider]:{id:pid,username:profile.username||'',linked_at:new Date().toISOString()}}};
      d.users.push(u);
    }
    this.save(d);
    const{hash:_h,salt:_s,...safe}=u;
    return{user:safe,token:makeJWT({id:u.id,email:u.email,plan:u.plan})};
  },
};

// ════ OAUTH HELPERS ═══════════════════════════════════════════════
// Thin wrappers around the GitHub and Google OAuth 2.0 authorization-code
// flows. State is signed with CFG.token so callbacks can be verified without
// any server-side session state.
const OAuth={
  makeState(provider){
    const nonce=crypto.randomBytes(12).toString('hex');
    const payload=provider+'.'+Date.now()+'.'+nonce;
    const sig=crypto.createHmac('sha256',CFG.token).update(payload).digest('hex').slice(0,32);
    return Buffer.from(payload+'.'+sig).toString('base64url');
  },
  checkState(provider,state){
    try{
      const raw=Buffer.from(state||'','base64url').toString();
      const parts=raw.split('.');if(parts.length!==4)return false;
      const[prov,ts,nonce,sig]=parts;
      if(prov!==provider)return false;
      const expected=crypto.createHmac('sha256',CFG.token).update(prov+'.'+ts+'.'+nonce).digest('hex').slice(0,32);
      if(sig!==expected)return false;
      if(Date.now()-parseInt(ts,10)>10*60*1000)return false;  // 10 min TTL
      return true;
    }catch(e){return false;}
  },
  redirectUri(provider,req){
    const envKey=provider==='github'?'GITHUB_REDIRECT_URI':'GOOGLE_REDIRECT_URI';
    if(process.env[envKey])return process.env[envKey];
    const host=req.headers.host||('localhost:'+PORT);
    const proto=(req.headers['x-forwarded-proto']||'http').split(',')[0].trim();
    return proto+'://'+host+'/api/auth/'+provider+'/callback';
  },
  _postForm(url,form,headers={}){
    return new Promise((resolve,reject)=>{
      const body=Object.entries(form).map(([k,v])=>encodeURIComponent(k)+'='+encodeURIComponent(v)).join('&');
      const u=urlMod.parse(url);
      const req=https.request({method:'POST',host:u.host,path:u.path,headers:{
        'Content-Type':'application/x-www-form-urlencoded','Accept':'application/json',
        'Content-Length':Buffer.byteLength(body),'User-Agent':'AXIOM-IDE',...headers
      }},r=>{let d='';r.on('data',c=>d+=c);r.on('end',()=>{try{resolve(JSON.parse(d));}catch(e){reject(new Error('Bad OAuth response: '+d.slice(0,200)));}});});
      req.on('error',reject);req.write(body);req.end();
    });
  },
  _getJson(url,token){
    return new Promise((resolve,reject)=>{
      const u=urlMod.parse(url);
      const req=https.request({method:'GET',host:u.host,path:u.path,headers:{
        'Authorization':'Bearer '+token,'Accept':'application/json','User-Agent':'AXIOM-IDE'
      }},r=>{let d='';r.on('data',c=>d+=c);r.on('end',()=>{try{resolve(JSON.parse(d));}catch(e){reject(new Error('Bad API response: '+d.slice(0,200)));}});});
      req.on('error',reject);req.end();
    });
  },
  async exchangeGithub(code,redirect_uri){
    const r=await this._postForm('https://github.com/login/oauth/access_token',{
      client_id:process.env.GITHUB_CLIENT_ID,client_secret:process.env.GITHUB_CLIENT_SECRET,
      code,redirect_uri
    });
    if(!r.access_token)throw new Error(r.error_description||r.error||'GitHub token exchange failed');
    return r.access_token;
  },
  async fetchGithubProfile(tok){
    const u=await this._getJson('https://api.github.com/user',tok);
    let email=u.email;
    if(!email){
      try{
        const emails=await this._getJson('https://api.github.com/user/emails',tok);
        const primary=(emails||[]).find(e=>e.primary&&e.verified)||(emails||[])[0];
        if(primary)email=primary.email;
      }catch(e){}
    }
    return{id:u.id,username:u.login,name:u.name||u.login,email:email||'',avatar:u.avatar_url||''};
  },
  async exchangeGoogle(code,redirect_uri){
    const r=await this._postForm('https://oauth2.googleapis.com/token',{
      client_id:process.env.GOOGLE_CLIENT_ID,client_secret:process.env.GOOGLE_CLIENT_SECRET,
      code,redirect_uri,grant_type:'authorization_code'
    });
    if(!r.access_token)throw new Error(r.error_description||r.error||'Google token exchange failed');
    return r.access_token;
  },
  async fetchGoogleProfile(tok){
    const u=await this._getJson('https://openidconnect.googleapis.com/v1/userinfo',tok);
    return{id:u.sub,username:(u.email||'').split('@')[0],name:u.name||'',email:u.email||'',avatar:u.picture||''};
  },
  // Redirect the browser back to `/` with the JWT + user profile in the URL
  // hash so the frontend can pick it up and finish signing in.
  respondSuccess(res,result){
    if(result.error){return this.respondError(res,result.error);}
    const b64=Buffer.from(JSON.stringify(result.user)).toString('base64url');
    const target='/#oauth='+encodeURIComponent(result.token)+'&user='+encodeURIComponent(b64);
    res.writeHead(302,{Location:target});res.end();return;
  },
  respondError(res,msg){
    const target='/#oauth_error='+encodeURIComponent(msg||'OAuth failed');
    res.writeHead(302,{Location:target});res.end();return;
  }
};

// Seed demo user if empty
(()=>{const d=UsersDB.load();if(!d.users.length){UsersDB.register('Demo User','demo@axiom.dev','axiom123','pro');console.log('  Demo user: demo@axiom.dev / axiom123');}})();

