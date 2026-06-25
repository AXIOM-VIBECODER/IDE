#!/usr/bin/env node
'use strict';
/**
 * AXIOM v5 — Complete IDE Backend
 * Real WebSocket terminal · Admin Dashboard · Memory Engine · Zero npm deps
 */
// Load .env from project root into process.env (no external deps)
(function loadEnv(){try{const p=require('path').join(__dirname,'../.env');const lines=require('fs').readFileSync(p,'utf8').split('\n');for(const l of lines){const t=l.trim();if(!t||t.startsWith('#'))continue;const i=t.indexOf('=');if(i<1)continue;const k=t.slice(0,i).trim(),v=t.slice(i+1).trim();if(!(k in process.env))process.env[k]=v;}}catch(e){}})();
const http=require('http'),https=require('https'),fs=require('fs'),path=require('path');
const os=require('os'),urlMod=require('url'),crypto=require('crypto'),net=require('net');
const {exec,spawn,execSync}=require('child_process');
let pty;try{pty=require('node-pty');}catch(e){console.warn('node-pty not available, falling back to spawn');}
const mysql=require('mysql2/promise');

// ── Security Headers ────────────────────────────────────────────
function setSecurityHeaders(res){
  res.setHeader('X-Content-Type-Options','nosniff');
  res.setHeader('X-Frame-Options','DENY');
  res.setHeader('X-XSS-Protection','1; mode=block');
  res.setHeader('Referrer-Policy','strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy','camera=(), microphone=(), geolocation=()');
  res.setHeader('X-DNS-Prefetch-Control','off');
  if(process.env.NODE_ENV==='production'){
    res.setHeader('Strict-Transport-Security','max-age=63072000; includeSubDomains; preload');
    res.setHeader('Content-Security-Policy',"default-src 'self'; script-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net https://js.paystack.co; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com https://cdn.jsdelivr.net; connect-src 'self' ws: wss: https://api.anthropic.com https://api.paystack.co https://standard.paystack.co https://api.github.com https://oauth2.googleapis.com http://localhost:* http://127.0.0.1:*; img-src 'self' data: https:; font-src 'self' https://fonts.gstatic.com https://cdn.jsdelivr.net; frame-src https://checkout.paystack.com https://standard.paystack.co blob: http://localhost:* http://127.0.0.1:*; object-src 'none'; base-uri 'self'");
  }
}

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
// DAP CLIENT — Real Debug Adapter Protocol over TCP/stdio
// ══════════════════════════════════════════════════════════════
const debugSessions={};
const DAP_CONFIGS={
  python:{cmd:'python3',args:['-m','debugpy.adapter'],mode:'stdio',
    launchArgs:(f,d)=>({type:'python',request:'launch',program:f,cwd:d,console:'integratedTerminal',justMyCode:true})},
  javascript:{cmd:'node',args:data=>{
      const p=5678+Object.keys(debugSessions).length;
      return['--inspect-brk='+p,data.file];},
    mode:'inspect',
    launchArgs:(f,d,p)=>({type:'node',request:'attach',port:p,localRoot:d,remoteRoot:d})},
  go:{cmd:'dlv',args:data=>{
      const p=38697+Object.keys(debugSessions).length;
      return['dap','--listen','127.0.0.1:'+p];},
    mode:'tcp',
    launchArgs:(f,d)=>({type:'go',request:'launch',mode:'debug',program:f,cwd:d})},
};
// DAP message framing (same Content-Length header as LSP)
function dapEncode(msg){const body=JSON.stringify(msg);return`Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`;}
function createDapParser(onMessage){
  let buf='',contentLen=-1;
  return function(chunk){
    buf+=chunk;
    while(true){
      if(contentLen<0){
        const hdrEnd=buf.indexOf('\r\n\r\n');
        if(hdrEnd<0)break;
        const hdr=buf.slice(0,hdrEnd);
        const m=hdr.match(/Content-Length:\s*(\d+)/i);
        if(!m)break;
        contentLen=parseInt(m[1],10);
        buf=buf.slice(hdrEnd+4);
      }
      if(buf.length<contentLen)break;
      const body=buf.slice(0,contentLen);
      buf=buf.slice(contentLen);contentLen=-1;
      try{onMessage(JSON.parse(body));}catch(e){}
    }
  };
}

function startDapSession(lang,filePath,rootDir){
  const id=crypto.randomUUID();
  const cfg=DAP_CONFIGS[lang];if(!cfg)return{error:'No debugger for '+lang};
  const sess={id,lang,file:filePath,dir:rootDir,proc:null,dapSocket:null,
    seq:1,pending:{},breakpoints:{},threads:[],stackFrames:[],scopes:{},
    variables:{},output:[],state:'starting',exited:false,started:Date.now(),
    stoppedThread:null,stoppedReason:null,capabilities:{}};

  const onDapMsg=(msg)=>{
    // Handle DAP responses
    if(msg.type==='response'&&sess.pending[msg.request_seq]){
      const{resolve}=sess.pending[msg.request_seq];delete sess.pending[msg.request_seq];
      resolve(msg);
    }
    // Handle DAP events
    if(msg.type==='event'){
      if(msg.event==='initialized'){
        sess.state='initialized';
        // Send breakpoints then configurationDone
        sendAllBreakpoints(sess).then(()=>dapRequest(sess,'configurationDone',{}));
      }
      if(msg.event==='stopped'){
        sess.state='stopped';
        sess.stoppedThread=msg.body?.threadId||1;
        sess.stoppedReason=msg.body?.reason||'breakpoint';
      }
      if(msg.event==='continued'){sess.state='running';}
      if(msg.event==='terminated'||msg.event==='exited'){sess.state='terminated';sess.exited=true;}
      if(msg.event==='output'){
        const text=msg.body?.output||'';
        sess.output.push({category:msg.body?.category||'console',text});
        if(sess.output.length>500)sess.output=sess.output.slice(-250);
      }
      if(msg.event==='thread'){
        if(msg.body?.reason==='started')sess.threads.push({id:msg.body.threadId,name:'Thread '+msg.body.threadId});
        if(msg.body?.reason==='exited')sess.threads=sess.threads.filter(t=>t.id!==msg.body.threadId);
      }
    }
  };

  const setupDap=(writable,readable)=>{
    const parser=createDapParser(onDapMsg);
    readable.on('data',d=>parser(d.toString()));
    sess._write=(data)=>{writable.write(dapEncode(data));};
    // Send initialize
    dapRequest(sess,'initialize',{
      clientID:'axiom',clientName:'AXIOM IDE',adapterID:lang,
      linesStartAt1:true,columnsStartAt1:true,
      pathFormat:'path',
      supportsVariableType:true,supportsRunInTerminalRequest:false,
      supportsVariablePaging:true,
      locale:'en'
    }).then(r=>{
      sess.capabilities=r.body||{};
      // Send launch
      const launchArgs=cfg.launchArgs(filePath,rootDir,sess._port);
      return dapRequest(sess,'launch',launchArgs);
    }).then(()=>{sess.state='running';}).catch(e=>{
      sess.output.push({category:'stderr',text:'DAP init error: '+e.message});
      sess.state='error';
    });
  };

  if(cfg.mode==='stdio'){
    // debugpy adapter mode: communicate via stdin/stdout
    const proc=spawn(cfg.cmd,cfg.args,{cwd:rootDir,stdio:['pipe','pipe','pipe']});
    sess.proc=proc;
    proc.stderr.on('data',d=>{sess.output.push({category:'stderr',text:d.toString()});});
    proc.on('exit',()=>{sess.exited=true;sess.state='terminated';});
    setupDap(proc.stdin,proc.stdout);
  } else if(cfg.mode==='tcp'){
    // dlv dap mode: connect TCP after spawning
    const args=typeof cfg.args==='function'?cfg.args({file:filePath}):cfg.args;
    const portMatch=args.join(' ').match(/127\.0\.0\.1:(\d+)/);
    const port=portMatch?parseInt(portMatch[1],10):38697;
    sess._port=port;
    const proc=spawn(cfg.cmd,args,{cwd:rootDir,stdio:['pipe','pipe','pipe']});
    sess.proc=proc;
    let procOutput='';
    proc.stdout.on('data',d=>{procOutput+=d.toString();});
    proc.stderr.on('data',d=>{procOutput+=d.toString();sess.output.push({category:'stderr',text:d.toString()});});
    proc.on('exit',()=>{sess.exited=true;sess.state='terminated';});
    // Wait for server to be ready then connect
    setTimeout(()=>{
      const sock=net.connect(port,'127.0.0.1',()=>{sess.dapSocket=sock;setupDap(sock,sock);});
      sock.on('error',e=>{sess.output.push({category:'stderr',text:'TCP connect error: '+e.message});sess.state='error';});
    },800);
  } else if(cfg.mode==='inspect'){
    // Node.js inspect mode: spawn node, connect Chrome DevTools Protocol via DAP wrapper
    const args=typeof cfg.args==='function'?cfg.args({file:filePath}):cfg.args;
    const portMatch=args.join(' ').match(/--inspect-brk=(\d+)/);
    const port=portMatch?parseInt(portMatch[1],10):9229;
    sess._port=port;
    const proc=spawn(cfg.cmd,args,{cwd:rootDir,stdio:['pipe','pipe','pipe']});
    sess.proc=proc;
    proc.stdout.on('data',d=>{sess.output.push({category:'stdout',text:d.toString()});});
    proc.stderr.on('data',d=>{sess.output.push({category:'stderr',text:d.toString()});});
    proc.on('exit',()=>{sess.exited=true;sess.state='terminated';});
    // For Node inspect we emulate DAP by bridging to the inspect protocol
    sess.state='running';
    sess._inspectPort=port;
  }

  debugSessions[id]=sess;
  return{id,lang,state:sess.state};
}

function dapRequest(sess,command,args){
  return new Promise((resolve,reject)=>{
    if(!sess._write){return reject(new Error('DAP not connected'));}
    const seq=sess.seq++;
    const msg={type:'request',seq,command,arguments:args||{}};
    sess.pending[seq]={resolve,reject,ts:Date.now()};
    sess._write(msg);
    setTimeout(()=>{if(sess.pending[seq]){delete sess.pending[seq];reject(new Error('DAP timeout: '+command));}},15000);
  });
}

async function sendAllBreakpoints(sess){
  const grouped={};
  Object.entries(sess.breakpoints).forEach(([file,lines])=>{
    grouped[file]=lines.map(ln=>({line:ln}));
  });
  for(const[file,bps]of Object.entries(grouped)){
    try{await dapRequest(sess,'setBreakpoints',{
      source:{path:file},breakpoints:bps
    });}catch(e){}
  }
}

async function dapGetThreads(sess){
  try{const r=await dapRequest(sess,'threads',{});sess.threads=r.body?.threads||[];return sess.threads;}
  catch(e){return sess.threads;}
}

async function dapGetStackTrace(sess,threadId){
  try{const r=await dapRequest(sess,'stackTrace',{threadId,startFrame:0,levels:50});
    sess.stackFrames=r.body?.stackFrames||[];return sess.stackFrames;}
  catch(e){return[];}
}

async function dapGetScopes(sess,frameId){
  try{const r=await dapRequest(sess,'scopes',{frameId});return r.body?.scopes||[];}
  catch(e){return[];}
}

async function dapGetVariables(sess,ref){
  try{const r=await dapRequest(sess,'variables',{variablesReference:ref,count:200});return r.body?.variables||[];}
  catch(e){return[];}
}

async function dapEvaluate(sess,expression,frameId){
  try{const r=await dapRequest(sess,'evaluate',{expression,frameId,context:'watch'});return r.body||{result:'<error>'};}
  catch(e){return{result:e.message};}
}

// ══════════════════════════════════════════════════════════════
// COLLABORATION — WebSocket rooms for real-time editing
// ══════════════════════════════════════════════════════════════
const collabRooms={};  // roomId -> { doc, users: [{socket,name,color,cursor}], version, owner, token, created, file }
let COLLAB_FILE; // set after DATA is defined

function getRoom(roomId){
  if(!collabRooms[roomId])collabRooms[roomId]={doc:'',users:[],version:0,history:[],created:Date.now(),owner:null,token:null,file:null,typing:new Set()};
  return collabRooms[roomId];
}

function broadcastRoom(roomId,msg,excludeSocket){
  const room=collabRooms[roomId];if(!room)return;
  const data=JSON.stringify(msg);
  room.users.forEach(u=>{
    if(u.socket!==excludeSocket){try{u.socket.write(encodeWsFrame(data));}catch(e){}}
  });
}

function saveCollabSessions(){
  const sessions=Object.entries(collabRooms).map(([id,r])=>({id,userCount:r.users.length,version:r.version,created:r.created,owner:r.owner,file:r.file,docLen:r.doc.length}));
  try{atomicWriteSync(COLLAB_FILE,JSON.stringify(sessions,null,2));}catch(e){}
}

function listCollabRooms(){
  return Object.entries(collabRooms).map(([id,r])=>({id,users:r.users.map(u=>({id:u.id,name:u.name,color:u.color})),version:r.version,created:r.created,owner:r.owner,file:r.file}));
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

const PORT=+(process.env.PORT||5000),DATA=process.env.AXIOM_DATA||path.join(os.homedir(),'.axiom');
COLLAB_FILE=path.join(DATA,'collab_sessions.json');
const MAX_BODY_SIZE=5*1024*1024;
const KEY_FILE=path.join(DATA,'key'),MEM_FILE=path.join(DATA,'memory.json');
const CFG_FILE=path.join(DATA,'config.json'),DB_FILE=path.join(DATA,'axiom.db');
const SNIP_FILE=path.join(DATA,'snippets.json');
const CHATS_FILE=path.join(DATA,'chats.json');
const SETTINGS_FILE=path.join(DATA,'settings.json');
const AI_PROVIDER_FILE=path.join(DATA,'ai_provider.json');
fs.mkdirSync(DATA,{recursive:true,mode:0o700});

// ── Logging ─────────────────────────────────────────────────────
const LOG_FILE=path.join(DATA,'axiom.log');
function logEntry(level,msg,meta={}){
  const entry=JSON.stringify({ts:new Date().toISOString(),level,msg,...meta});
  try{fs.appendFileSync(LOG_FILE,entry+'\n');}catch(e){}
  if(level==='error')console.error(`[${level}] ${msg}`);
}
function logError(msg,err,meta={}){logEntry('error',msg,{...meta,error:err?.message||String(err),stack:err?.stack?.split('\n').slice(0,3).join(' | ')});}
function logInfo(msg,meta={}){logEntry('info',msg,meta);}
function logWarn(msg,meta={}){logEntry('warn',msg,meta);}

function auditLog(action,details,req){
  const entry=JSON.stringify({ts:new Date().toISOString(),action,details,ip:req?.socket?.remoteAddress,user:req?.headers?.['x-user-email']||'system'});
  try{fs.appendFileSync(path.join(DATA,'audit.log'),entry+'\n');}catch(e){}
  // Also write to DB audit_log table
  if(dbPool){
  const now=new Date().toISOString().slice(0,19).replace('T',' ');
  dbPool.query('INSERT INTO audit_log (user_id,action,resource,details,ip_address,created_at) VALUES (?,?,?,?,?,?)',
    [null,action,details?.route||details?.path||'',JSON.stringify(details),req?.socket?.remoteAddress||'',now]).catch(()=>{});
  }
}

// ── Atomic File Writes ──────────────────────────────────────────
function atomicWriteSync(filePath,data,options={}){
  const tmpPath=filePath+'.tmp.'+Date.now();
  try{
    fs.writeFileSync(tmpPath,data,{mode:options.mode||0o600,...options});
    fs.renameSync(tmpPath,filePath);
  }catch(e){
    try{fs.unlinkSync(tmpPath);}catch(x){}
    throw e;
  }
}

// ── File Watching ───────────────────────────────────────────────
const fileWatchers={};
function watchDirectory(dir){
  if(fileWatchers[dir])return;
  try{
    fileWatchers[dir]=fs.watch(dir,{recursive:true},(event,filename)=>{
      if(!filename)return;
      const room=collabRooms[dir+'/'+filename];
      if(room){
        const fullPath=path.join(dir,filename);
        try{
          const content=fs.readFileSync(fullPath,'utf8');
          room.users.forEach(u=>{try{u.socket.write(encodeWsFrame(JSON.stringify({type:'external_change',file:filename,content})));}catch(e){}});
        }catch(e){}
      }
    });
  }catch(e){logWarn('Cannot watch directory: '+dir,{error:e.message});}
}
function unwatchDirectory(dir){
  if(fileWatchers[dir]){try{fileWatchers[dir].close();}catch(e){}delete fileWatchers[dir];}
}

// ── Config ──────────────────────────────────────────────────────
function loadCfg(){try{return JSON.parse(fs.readFileSync(CFG_FILE,'utf8'));}catch(e){}
  const c={token:crypto.randomBytes(32).toString('hex'),created:new Date().toISOString()};
  atomicWriteSync(CFG_FILE,JSON.stringify(c,null,2),{mode:0o600});return c;}
const CFG=loadCfg();

// ── Rate limiter ─────────────────────────────────────────────────
const rl=new Map();
function rateOk(ip,req){const n=Date.now();const realIp=(req?.headers?.['x-forwarded-for']||'').split(',')[0].trim()||ip;const b=rl.get(realIp)||{c:0,r:n+60000};if(n>b.r){b.c=0;b.r=n+60000;}b.c++;rl.set(realIp,b);return b.c<=200;}
let currencyCache=null;

// ── Path sandbox ─────────────────────────────────────────────────
function safe(p){if(!p)return null;const r=path.resolve((p+'').replace(/^~/,os.homedir()));return[os.homedir(),'/tmp'].some(b=>r.startsWith(path.resolve(b)))?r:null;}

function isAdmin(req,data){
  if(req._adminUser&&req._adminUser.admin)return true;
  const token=req.headers['x-token']||req.headers.authorization?.replace('Bearer ','');
  if(token===CFG.token)return true;
  const email=data?.email||req.headers['x-user-email'];
  if(!email)return false;
  try{const ud=JSON.parse(fs.readFileSync(path.join(os.homedir(),'.axiom','users.json'),'utf8'));return !!ud.users?.find(u=>u.email===email&&u.role==='admin');}catch(e){return false;}
}

// Resolve current user from X-User-Token header
function getReqUser(req){
  const tok=req.headers['x-user-token'];
  if(!tok)return null;
  return UsersDB.getByToken(tok);
}

// ── Credential Encryption (AES-256-GCM) ─────────────────────────
// All stored API keys / secrets are encrypted at rest.
const CRED_KEY_FILE=path.join(DATA,'cred.key');
function getCredKey(){
  try{return Buffer.from(fs.readFileSync(CRED_KEY_FILE,'utf8').trim(),'hex');}
  catch(e){const k=crypto.randomBytes(32);atomicWriteSync(CRED_KEY_FILE,k.toString('hex'),{mode:0o600});return k;}
}
const CRED_KEY=getCredKey();
function encryptCred(text){
  const iv=crypto.randomBytes(12);
  const cipher=crypto.createCipheriv('aes-256-gcm',CRED_KEY,iv);
  let enc=cipher.update(text,'utf8','hex');enc+=cipher.final('hex');
  const tag=cipher.getAuthTag().toString('hex');
  return iv.toString('hex')+':'+tag+':'+enc;
}
function decryptCred(blob){
  try{
    const[ivH,tagH,enc]=blob.split(':');
    const decipher=crypto.createDecipheriv('aes-256-gcm',CRED_KEY,Buffer.from(ivH,'hex'));
    decipher.setAuthTag(Buffer.from(tagH,'hex'));
    let dec=decipher.update(enc,'hex','utf8');dec+=decipher.final('utf8');
    return dec;
  }catch(e){return blob;} // Fallback for unencrypted legacy values
}

// ── Token Budget Enforcement ─────────────────────────────────────
// Returns {allowed,used,limit,remaining,plan} for a user this month.
function getTokenBudget(user){
  if(!user)return{allowed:false,used:0,limit:0,remaining:0,plan:'free'};
  const plan=user.plan||'free';
  const limit=PLANS[plan]?.tokens_month||0;
  // tokens_in + tokens_out from DB track cumulative; we need monthly
  // For file-based users, use in-memory tracking
  const used=(user.tokens_used_month||0);
  const bonus=(user.bonus_tokens||0);
  const total=limit+bonus;
  const remaining=Math.max(0,total-used);
  return{allowed:remaining>0,used,limit,bonus,remaining,plan,total};
}

// Reset monthly token usage (called on plan cycle or start of month)
function resetMonthlyTokens(userId){
  if(dbPool){
    const now=new Date().toISOString().slice(0,19).replace('T',' ');
    dbPool.query('UPDATE users SET tokens_used_month=0, month_reset_at=? WHERE id=?',[now,userId]).catch(()=>{});
  }
  // File-based users
  try{
    const ud=JSON.parse(fs.readFileSync(USERS_FILE,'utf8'));
    const u=ud.users?.find(x=>x.id===userId);
    if(u){u.tokens_used_month=0;u.month_reset_at=new Date().toISOString();atomicWriteSync(USERS_FILE,JSON.stringify(ud,null,2),{mode:0o600});}
  }catch(e){}
}

// ── Auth Rate Limiter (stricter for login/register) ──────────────
const authRL=new Map();
function authRateOk(ip){
  const n=Date.now();
  const b=authRL.get(ip)||{c:0,r:n+300000}; // 5 minute window
  if(n>b.r){b.c=0;b.r=n+300000;}
  b.c++;authRL.set(ip,b);
  return b.c<=10; // max 10 auth attempts per 5 minutes
}

// ── Security Event Logger ────────────────────────────────────────
function securityLog(event,details,req){
  const entry={ts:new Date().toISOString(),event,details,ip:req?.socket?.remoteAddress||'',ua:req?.headers?.['user-agent']||''};
  try{fs.appendFileSync(path.join(DATA,'security.log'),JSON.stringify(entry)+'\n');}catch(e){}
  if(dbPool){
    const now=new Date().toISOString().slice(0,19).replace('T',' ');
    dbPool.query('INSERT INTO audit_log (user_id,action,resource,details,ip_address,created_at) VALUES (?,?,?,?,?,?)',
      [null,'security:'+event,details?.route||'',JSON.stringify(entry),entry.ip,now]).catch(()=>{});
  }
}

// Check if free trial has expired (2-day trial)
const FREE_TRIAL_DAYS=2;
function isTrialExpired(user){
  if(!user)return false;
  if(user.role==='admin')return false;
  if(user.plan&&user.plan!=='free')return false;
  const created=new Date(user.created_at);
  const now=new Date();
  const diffMs=now-created;
  const diffDays=diffMs/(1000*60*60*24);
  return diffDays>FREE_TRIAL_DAYS;
}

function sanitizeGitArg(arg){return (arg||'').replace(/[;&|`$(){}!#\n\r]/g,'');}

function git(cwd,...args){return new Promise(resolve=>{const s=safe(cwd);if(!s)return resolve({ok:false,out:'Path not allowed'});const sanitized=args.map(a=>sanitizeGitArg(a));exec(`git -C "${s}" ${sanitized.join(' ')}`,{timeout:15000,env:{...process.env,GIT_TERMINAL_PROMPT:'0'}},(err,out,se)=>resolve({ok:!err,out:(out||'')+(se&&!out?se:''),err:err?.message||''}));});}

// ── Plans ────────────────────────────────────────────────────────
// Cheapest AI-powered IDE on the market. Monthly token budgets strictly enforced.
// tokens_month = total input+output tokens allowed per calendar month.
// Extra tokens can be purchased via /api/billing/tokens/buy.
const PLANS={
  free:{
    name:'Free Trial',price:0,kes:0,tagline:'2-day trial — explore AXIOM',trial_days:2,
    tokens_month:5000,
    features:['Basic IDE + editor','5K AI tokens (trial)','Community support','1 workspace']
  },
  starter:{
    name:'Starter',price:4,kes:520,tagline:'Cheapest AI IDE — for students & hobbyists',
    tokens_month:50000,
    features:['Everything in Free','50K AI tokens/month','GitHub + Google login','Email support','3 workspaces']
  },
  pro:{
    name:'Pro',price:9,kes:1170,tagline:'For professional developers',
    tokens_month:500000,
    features:['Everything in Starter','500K AI tokens/month','Priority support','Advanced debugging + LSP','Unlimited workspaces']
  },
  team:{
    name:'Team',price:19,kes:2470,tagline:'For teams that ship fast',
    tokens_month:2000000,
    features:['Everything in Pro','2M AI tokens/month','5 seats included','Admin dashboard + analytics','Shared workspaces & billing']
  }
};
const TOKEN_TOPUP_PRICES=[
  {tokens:10000,  price:1, kes:130, label:'10K tokens'},
  {tokens:50000,  price:3, kes:390, label:'50K tokens'},
  {tokens:200000, price:10,kes:1300,label:'200K tokens'},
  {tokens:1000000,price:40,kes:5200,label:'1M tokens'},
];

// ── MySQL Database ───────────────────────────────────────────────
const DB_PASS=process.env.DB_PASS||'';
// DB is optional — AXIOM falls back to JSON file storage if no DB is configured
const DB_CONFIG_FILE=path.join(DATA,'db_config.json');

function loadDbConfig(){
  // Priority: env vars → ~/.axiom/db_config.json → defaults
  try{
    const saved=JSON.parse(fs.readFileSync(DB_CONFIG_FILE,'utf8'));
    return{
      host:process.env.DB_HOST||saved.host||'localhost',
      user:process.env.DB_USER||saved.user||'root',
      password:process.env.DB_PASS||saved.password||'',
      database:process.env.DB_NAME||saved.database||'axiom',
      port:+(process.env.DB_PORT||saved.port||3306)
    };
  }catch(e){
    return{host:process.env.DB_HOST||'localhost',user:process.env.DB_USER||'root',password:process.env.DB_PASS||DB_PASS||'',database:process.env.DB_NAME||'axiom',port:+(process.env.DB_PORT||3306)};
  }
}

let dbPool=null;
let dbAvailable=false;
let dbLastError='';

function initDbPool(cfg){
  try{
    if(dbPool){try{dbPool.end();}catch(e){}}
    const c=cfg||loadDbConfig();
    dbPool=mysql.createPool({host:c.host,user:c.user,password:c.password,database:c.database,port:c.port||3306,waitForConnections:true,connectionLimit:5,queueLimit:0,timezone:'+00:00',decimalNumbers:true,connectTimeout:5000});
    // Prevent unhandled 'error' events from crashing the process when MySQL is unavailable
    dbPool.on('error',e=>{dbAvailable=false;dbLastError=e.message;console.warn('[DB] Pool error (MySQL offline):',e.message);});
    dbPool.getConnection().then(conn=>{
      dbAvailable=true;dbLastError='';
      console.log('[DB] Connected to MySQL at '+c.host+':'+(c.port||3306)+'/'+c.database);
      initDbSchema().catch(e=>console.warn('[DB] Schema init:',e.message));
      conn.release();
    }).catch(e=>{dbAvailable=false;dbLastError=e.message;console.warn('[DB] MySQL not available:',e.message);});
  }catch(e){dbAvailable=false;dbLastError=e.message;console.warn('[DB] MySQL pool creation failed:',e.message);}
}

async function initDbSchema(){
  if(!dbPool||!dbAvailable)return;
  const ddl=[
    `CREATE TABLE IF NOT EXISTS users (id VARCHAR(36) PRIMARY KEY, name VARCHAR(255), email VARCHAR(255) UNIQUE, plan VARCHAR(50) DEFAULT 'free', role VARCHAR(50) DEFAULT 'user', status VARCHAR(50) DEFAULT 'active', total_paid DECIMAL(10,2) DEFAULT 0, total_cost DECIMAL(10,4) DEFAULT 0, chat_count INT DEFAULT 0, tokens_in BIGINT DEFAULT 0, tokens_out BIGINT DEFAULT 0, tokens_used_month BIGINT DEFAULT 0, bonus_tokens BIGINT DEFAULT 0, month_reset_at DATETIME, last_seen DATETIME, avatar_url VARCHAR(500), github_id VARCHAR(100), google_id VARCHAR(100), created_at DATETIME DEFAULT CURRENT_TIMESTAMP)`,
    `CREATE TABLE IF NOT EXISTS payments (id VARCHAR(36) PRIMARY KEY, user_id VARCHAR(36), email VARCHAR(255), name VARCHAR(255), plan VARCHAR(50), amount DECIMAL(10,2), status VARCHAR(50), type VARCHAR(50), stripe_id VARCHAR(255), created_at DATETIME DEFAULT CURRENT_TIMESTAMP)`,
    `CREATE TABLE IF NOT EXISTS usage_log (id VARCHAR(36) PRIMARY KEY, user_id VARCHAR(36), action VARCHAR(100), tokens_in INT DEFAULT 0, tokens_out INT DEFAULT 0, cost DECIMAL(10,6) DEFAULT 0, created_at DATETIME DEFAULT CURRENT_TIMESTAMP)`,
    `CREATE TABLE IF NOT EXISTS audit_log (id INT AUTO_INCREMENT PRIMARY KEY, user_id VARCHAR(36), action VARCHAR(100), resource VARCHAR(255), details TEXT, ip_address VARCHAR(50), created_at DATETIME DEFAULT CURRENT_TIMESTAMP)`
  ];
  for(const sql of ddl){try{await dbPool.query(sql);}catch(e){console.warn('[DB] DDL:',e.message);}}
}

initDbPool();

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
      const ALLOWED_COLS=['name','email','plan','role','status','avatar_url','github_id','google_id','total_paid','total_cost','chat_count','tokens_in','tokens_out','tokens_used_month','bonus_tokens','month_reset_at','last_seen'];
      const sets=[];const vals=[];
      for(const [k,v] of Object.entries(p)){if(!ALLOWED_COLS.includes(k))continue;sets.push(k+'=?');vals.push(v);}
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
    if(!dbPool)return;
    try{
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
    }catch(e){console.warn('[DB] seedDemo failed (MySQL may be unavailable):',e.message);}
  },
  // Keep backward-compat stubs for any code that calls load()/save()
  load(){return this;},
  save(){}
};

// ── Memory engine ────────────────────────────────────────────────
const Mem={
  _d:null,
  load(){if(this._d)return this._d;try{this._d=JSON.parse(fs.readFileSync(MEM_FILE,'utf8'));}catch(e){this._d={v:5,sessions:0,chats:0,lastSeen:null,identity:{},langs:[],bugs:[],insights:[],decisions:[],todos:[],facts:[],sessionNotes:[],bookmarks:[]};}return this._d;},
  save(){if(this._d)atomicWriteSync(MEM_FILE,JSON.stringify(this._d,null,2),{mode:0o600});},
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
  save(s){atomicWriteSync(SNIP_FILE,JSON.stringify(s,null,2),{mode:0o600});},
  add(name,code,lang,desc){const s=this.load();s.unshift({id:crypto.randomUUID(),name,code,lang,desc,created:new Date().toISOString()});this.save(s.slice(0,200));},
  remove(id){this.save(this.load().filter(s=>s.id!==id));}
};

// ── Chats ────────────────────────────────────────────────────────
const Chats={
  load(){try{return JSON.parse(fs.readFileSync(CHATS_FILE,'utf8'));}catch(e){return[];}},
  save(c){atomicWriteSync(CHATS_FILE,JSON.stringify(c,null,2),{mode:0o600});},
  add(title,messages,lang,userId){const c=this.load();const chat={id:crypto.randomUUID(),user_id:userId||null,title:title.slice(0,120),messages,lang:lang||'',created:new Date().toISOString(),updated:new Date().toISOString()};c.unshift(chat);this.save(c.slice(0,500));return chat;},
  update(id,messages,title,userId){const c=this.load();const i=c.findIndex(x=>x.id===id&&(!userId||x.user_id===userId));if(i===-1)return null;if(messages)c[i].messages=messages;if(title)c[i].title=title;c[i].updated=new Date().toISOString();this.save(c);return c[i];},
  remove(id,userId){const c=this.load().filter(x=>!(x.id===id&&(!userId||x.user_id===userId)));this.save(c);},
  get(id,userId){const c=this.load().find(x=>x.id===id);if(!c)return null;if(userId&&c.user_id&&c.user_id!==userId)return null;return c;},
  listForUser(userId){return this.load().filter(c=>c.user_id===userId);}
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
function getAIProvider(){try{return JSON.parse(fs.readFileSync(AI_PROVIDER_FILE,'utf8'));}catch(e){return{provider:'anthropic',model:'claude-sonnet-4-20250514',baseUrl:''};}}
function saveAIProvider(cfg){atomicWriteSync(AI_PROVIDER_FILE,JSON.stringify(cfg,null,2));}

// ══════════════════════════════════════════════════════════════
// AI ORCHESTRA — multi-agent role system
// Roles: architect (design/structure), coder (implementation), documenter (docs)
// Each role can use a different provider/model independently.
// ══════════════════════════════════════════════════════════════
const ORCHESTRA_FILE=path.join(DATA,'ai_orchestra.json');
const ORCHESTRA_DEFAULTS={
  architect:{provider:'anthropic',model:'claude-opus-4-8',baseUrl:'',
    systemPrompt:'You are a senior software architect. Analyze requirements and produce a clear, structured implementation plan. Output only the plan — numbered steps, component names, data flow, edge cases. No code yet.'},
  coder:{provider:'anthropic',model:'claude-sonnet-4-20250514',baseUrl:'',
    systemPrompt:'You are an expert software engineer. Given an architecture plan, implement clean, production-ready code. Output only the code with minimal inline comments. No explanations.'},
  documenter:{provider:'anthropic',model:'claude-haiku-4-5-20251001',baseUrl:'',
    systemPrompt:'You are a technical writer. Given code, produce concise, clear documentation: a JSDoc/docstring header, a short usage example, and a brief API table if relevant. Output markdown.'}
};

function getOrchestra(){
  try{return {...ORCHESTRA_DEFAULTS,...JSON.parse(fs.readFileSync(ORCHESTRA_FILE,'utf8'))};}
  catch(e){return {...ORCHESTRA_DEFAULTS};}
}
function saveOrchestra(cfg){atomicWriteSync(ORCHESTRA_FILE,JSON.stringify(cfg,null,2));}

// Call AI for a specific orchestra role, using that role's provider config
async function aiCallRole(role,system,messages,{max_tokens=4096}={}){
  const orch=getOrchestra();
  const roleCfg=orch[role]||ORCHESTRA_DEFAULTS[role]||getAIProvider();
  const prov={...getAIProvider(),...roleCfg};
  if(prov.provider==='anthropic'){
    const key=getKey();if(!key)throw new Error('No Anthropic key — add in Settings ⚙');
    const model=prov.model||'claude-sonnet-4-20250514';
    const rb=JSON.stringify({model,max_tokens,system:system||roleCfg.systemPrompt,messages});
    const result=await new Promise((resolve,reject)=>{
      const r=https.request({hostname:'api.anthropic.com',path:'/v1/messages',method:'POST',headers:{'Content-Type':'application/json','x-api-key':key,'anthropic-version':'2023-06-01','Content-Length':Buffer.byteLength(rb)}},(resp)=>{let d='';resp.on('data',c=>d+=c);resp.on('end',()=>{try{resolve(JSON.parse(d));}catch(e){reject(e);}});});
      r.on('error',reject);r.write(rb);r.end();
    });
    if(result.error)throw new Error(result.error.message||JSON.stringify(result.error));
    return result.content?.[0]?.text||'';
  } else {
    const baseUrl=prov.baseUrl||(prov.provider==='lmstudio'?'http://localhost:1234':'http://localhost:11434');
    const model=prov.model||(prov.provider==='lmstudio'?'local-model':'qwen2.5-coder:7b');
    const rb=JSON.stringify({model,messages:[{role:'system',content:system||roleCfg.systemPrompt},...messages],stream:false,max_tokens,temperature:0.2});
    const u=new urlMod.URL(baseUrl+'/v1/chat/completions');
    const mod=u.protocol==='https:'?https:http;
    const result=await new Promise((resolve,reject)=>{
      const r=mod.request({hostname:u.hostname,port:u.port||(u.protocol==='https:'?443:80),path:u.pathname,method:'POST',headers:{'Content-Type':'application/json','Content-Length':Buffer.byteLength(rb),...(prov.apiKey?{'Authorization':'Bearer '+prov.apiKey}:{})}},(resp)=>{let d='';resp.on('data',c=>d+=c);resp.on('end',()=>{try{resolve(JSON.parse(d));}catch(e){reject(e);}});});
      r.on('error',reject);r.write(rb);r.end();
    });
    if(result.error)throw new Error(result.error.message||JSON.stringify(result.error));
    return result.choices?.[0]?.message?.content||'';
  }
}

// Unified non-streaming AI call — works with Anthropic, Ollama, and LM Studio
async function aiCall(system,messages,{apiKey,max_tokens=4096}={}){
  const prov=getAIProvider();
  if(prov.provider==='anthropic'){
    const key=apiKey||getKey();if(!key)throw new Error('No API key — add in Settings ⚙');
    const model=prov.model||'claude-sonnet-4-20250514';
    const rb=JSON.stringify({model,max_tokens,system,messages});
    const result=await new Promise((resolve,reject)=>{
      const r=https.request({hostname:'api.anthropic.com',path:'/v1/messages',method:'POST',headers:{'Content-Type':'application/json','x-api-key':key,'anthropic-version':'2023-06-01','Content-Length':Buffer.byteLength(rb)}},(resp)=>{let d='';resp.on('data',c=>d+=c);resp.on('end',()=>{try{resolve(JSON.parse(d));}catch(e){reject(e);}});});
      r.on('error',reject);r.write(rb);r.end();
    });
    if(result.error)throw new Error(result.error.message||JSON.stringify(result.error));
    return result.content?.[0]?.text||'';
  } else {
    // Ollama or LM Studio — OpenAI-compatible chat completions
    const baseUrl=prov.baseUrl||(prov.provider==='lmstudio'?'http://localhost:1234':'http://localhost:11434');
    const model=prov.model||(prov.provider==='lmstudio'?'local-model':'qwen2.5-coder:7b');
    const rb=JSON.stringify({model,messages:[{role:'system',content:system},...messages],stream:false,max_tokens,temperature:0.2});
    const u=new urlMod.URL(baseUrl+'/v1/chat/completions');
    const mod=u.protocol==='https:'?https:http;
    const result=await new Promise((resolve,reject)=>{
      const r=mod.request({hostname:u.hostname,port:u.port||(u.protocol==='https:'?443:80),path:u.pathname,method:'POST',headers:{'Content-Type':'application/json','Content-Length':Buffer.byteLength(rb),...(prov.apiKey?{'Authorization':'Bearer '+prov.apiKey}:{})}},(resp)=>{let d='';resp.on('data',c=>d+=c);resp.on('end',()=>{try{resolve(JSON.parse(d));}catch(e){reject(e);}});});
      r.on('error',reject);r.write(rb);r.end();
    });
    if(result.error)throw new Error(result.error.message||JSON.stringify(result.error));
    return result.choices?.[0]?.message?.content||'';
  }
}

// Streaming AI call — emits Anthropic-format SSE regardless of provider
// so the frontend works unchanged whether using Claude, Ollama, or LM Studio
function aiStream(system,messages,{apiKey,max_tokens=8192}={},httpRes){
  const prov=getAIProvider();
  if(prov.provider==='anthropic'){
    const key=apiKey||getKey();
    if(!key){httpRes.end('data: {"type":"error","error":{"message":"No API key — add in Settings"}}\n\n');return;}
    const model=prov.model||'claude-sonnet-4-20250514';
    const rb=JSON.stringify({model,max_tokens,stream:true,system,messages});
    const apiReq=https.request({hostname:'api.anthropic.com',path:'/v1/messages',method:'POST',headers:{'Content-Type':'application/json','x-api-key':key,'anthropic-version':'2023-06-01','Content-Length':Buffer.byteLength(rb)}},(apiRes)=>{apiRes.on('data',chunk=>httpRes.write(chunk));apiRes.on('end',()=>httpRes.end());});
    apiReq.on('error',e=>{httpRes.end('data: {"type":"error","error":{"message":"'+e.message+'"}}\n\n');});
    apiReq.end(rb);
  } else {
    // Local model: collect full response, emit as single Anthropic-format SSE chunk
    aiCall(system,messages,{apiKey,max_tokens}).then(text=>{
      const provider=prov.provider==='lmstudio'?'LM Studio':'Ollama';
      const model=prov.model||'local';
      httpRes.write('data: {"type":"message_start","message":{"model":"'+model+' ('+provider+')","usage":{"input_tokens":0,"output_tokens":0}}}\n\n');
      httpRes.write('data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n');
      // Stream in chunks of 200 chars so frontend renders progressively
      const chunks=text.match(/.{1,200}/gs)||[text];
      for(const chunk of chunks){
        httpRes.write('data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":'+JSON.stringify(chunk)+'}}\n\n');
      }
      httpRes.write('data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":'+Math.ceil(text.length/4)+'}}\n\n');
      httpRes.end();
    }).catch(e=>{
      httpRes.write('data: {"type":"error","error":{"message":'+JSON.stringify(e.message)+'}}\n\n');
      httpRes.end();
    });
  }
}
function parseBody(req){return new Promise(r=>{let b='';let size=0;req.on('data',c=>{size+=c.length;if(size>MAX_BODY_SIZE){req.destroy();return r({text:'',json:{},error:'Body too large'});}b+=c;});req.on('end',()=>{try{r({text:b,json:JSON.parse(b)});}catch(e){r({text:b,json:{}});}});});}
function sendJson(res,data,status=200){const j=JSON.stringify(data);res.writeHead(status,{'Content-Type':'application/json'});res.end(j);}
const CORS_ORIGIN=process.env.CORS_ORIGIN||'*';
function cors(res){res.setHeader('Access-Control-Allow-Origin',process.env.NODE_ENV==='production'?CORS_ORIGIN:'*');res.setHeader('Access-Control-Allow-Headers','Content-Type,X-Axiom-Token,X-Token,X-User-Token,Authorization');res.setHeader('Access-Control-Allow-Methods','GET,POST,PUT,DELETE,PATCH,OPTIONS');res.setHeader('X-Content-Type-Options','nosniff');}
const SKIP=['node_modules','.git','__pycache__','.axiom','dist','build','.next','.nuxt','coverage','.cache'];
function listDir(dir){const s=safe(dir);if(!s)return[];try{return fs.readdirSync(s,{withFileTypes:true}).filter(e=>!SKIP.includes(e.name)).map(e=>{try{const fp=path.join(s,e.name),st=fs.statSync(fp);return{name:e.name,type:e.isDirectory()?'dir':'file',path:fp,size:st.size,mtime:st.mtime.toISOString(),ext:path.extname(e.name).slice(1)};}catch(e){return null;}}).filter(Boolean).sort((a,b)=>a.type===b.type?a.name.localeCompare(b.name):a.type==='dir'?-1:1);}catch(e){return[];}}
function runCode(code,lang,stdin=''){return new Promise(resolve=>{const R={python:'python3',javascript:'node',bash:'bash',sh:'bash',ruby:'ruby'};const E={python:'.py',javascript:'.js',bash:'.sh',ruby:'.rb'};const runner=R[lang?.toLowerCase()];if(!runner)return resolve({output:`Language '${lang}' not supported`,error:true});const tmp=path.join(os.tmpdir(),`ax_${Date.now()}${E[lang.toLowerCase()]||'.py'}`);fs.writeFileSync(tmp,code,{mode:0o600});const p=spawn(runner,[tmp],{timeout:30000});let out='',err='';if(stdin){p.stdin.write(stdin);p.stdin.end();}p.stdout.on('data',d=>out+=d);p.stderr.on('data',d=>err+=d);p.on('close',code=>{try{fs.unlinkSync(tmp);}catch(e){}resolve({output:(out+(err?'\n'+err:'')).trim()||'(no output)',exitCode:code,error:code!==0});});p.on('error',e=>{try{fs.unlinkSync(tmp);}catch(x){}resolve({output:'Error: '+e.message,error:true});});});}

// ── TOTP helpers (RFC 6238) ─────────────────────────────────────
function base32Decode(s){const A='ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';s=s.toUpperCase().replace(/=+$/,'');let bits=0,val=0;const out=[];for(const c of s){const i=A.indexOf(c);if(i===-1)continue;val=(val<<5)|i;bits+=5;if(bits>=8){bits-=8;out.push((val>>>bits)&0xFF);}}return Buffer.from(out);}
function totpNow(secret,window=0){const key=base32Decode(secret);const step=Math.floor(Date.now()/30000)+window;const buf=Buffer.allocUnsafe(8);buf.writeUInt32BE(0,0);buf.writeUInt32BE(step>>>0,4);const h=crypto.createHmac('sha1',key).update(buf).digest();const off=h[h.length-1]&0xf;const code=((h[off]&0x7f)<<24)|(h[off+1]<<16)|(h[off+2]<<8)|h[off+3];return String(code%1000000).padStart(6,'0');}
function verifyTotp(secret,token){for(let w=-1;w<=1;w++){if(totpNow(secret,w)===String(token))return true;}return false;}
function isInternalUrl(u){try{const h=new URL(u).hostname.toLowerCase();return h==='localhost'||h==='127.0.0.1'||h==='::1'||h.startsWith('192.168.')||h.startsWith('10.')||/^172\.(1[6-9]|2\d|3[01])\./.test(h)||h.endsWith('.local')||h==='0.0.0.0'||h==='169.254.169.254'||h==='metadata.google.internal';}catch(e){return true;}}

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
      const send=d=>{try{socket.write(encodeWsFrame(typeof d==='string'?d:d.toString()));}catch(e){}};
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
              if(room.typing.has(user.id))room.typing.delete(user.id);
              broadcastRoom(roomId,{type:'edit',content:msg.content,version:room.version,userId:user.id},socket);
              saveCollabSessions();
            }else if(msg.type==='cursor'){
              user.cursor=msg.cursor||{line:0,character:0};
              user.selection=msg.selection||null;
              broadcastRoom(roomId,{type:'cursor',userId:user.id,cursor:user.cursor,selection:user.selection,name:user.name,color:user.color},socket);
            }else if(msg.type==='typing'){
              room.typing.add(user.id);
              broadcastRoom(roomId,{type:'typing',userId:user.id,name:user.name},socket);
              setTimeout(()=>{room.typing.delete(user.id);},3000);
            }else if(msg.type==='chat'){
              broadcastRoom(roomId,{type:'chat',userId:user.id,name:user.name,text:msg.text,ts:Date.now()});
            }else if(msg.type==='file_info'){
              room.file=msg.file||null;
              broadcastRoom(roomId,{type:'file_info',file:room.file,userId:user.id},socket);
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
  setSecurityHeaders(res);
  const ip=req.socket.remoteAddress||'';
  if(req.method==='OPTIONS'){res.writeHead(204);res.end();return;}
  if(!rateOk(ip,req)){res.writeHead(429);res.end(JSON.stringify({error:'Rate limited'}));return;}
  const parsed=urlMod.parse(req.url,true),route=parsed.pathname,q=parsed.query;
  const{text:rawBody,json:data}=['POST','PUT','PATCH','DELETE'].includes(req.method)?await parseBody(req):{text:'',json:{}};

  const PUBLIC=['/api/ping','/api/token','/api/billing/webhook','/api/plans',
    '/api/auth/register','/api/auth/login','/api/auth/providers',
    '/api/auth/github/start','/api/auth/github/callback',
    '/api/auth/google/start','/api/auth/google/callback',
    '/api/admin/login','/api/billing/paystack/webhook',
    '/api/db/status','/api/db/config','/api/db/init-schema'];
  if(route.startsWith('/api/')&&!PUBLIC.includes(route)){
    const tok=req.headers['x-axiom-token']||q.token||'';
    if(tok!==CFG.token){
      // Also accept admin JWT for /api/admin routes
      const jwt=req.headers['x-admin-token']||req.headers.authorization?.replace('Bearer ','');
      const payload=jwt?verifyJWT(jwt):null;
      if(!payload||!payload.admin){res.writeHead(401);res.end(JSON.stringify({error:'Invalid token'}));return;}
      req._adminUser=payload;
    }
    // Trial enforcement — block expired free users from main API (except auth/billing)
    if(!route.startsWith('/api/auth')&&!route.startsWith('/api/billing')&&!route.startsWith('/api/plans')&&!route.startsWith('/api/admin')){
      const u=getReqUser(req);
      if(u&&isTrialExpired(u)){return sendJson(res,{error:'trial_expired',message:'Your 2-day free trial has ended. Please subscribe to continue using AXIOM.'},403);}
    }
  }

  if(!route.startsWith('/api/')){
    const pub=path.join(__dirname,'..','public');
    // Block /admin for non-admin users
    if(route==='/admin'||route==='/admin/'){
      const adminTok=q.token||'';
      const jwt=q.jwt||'';
      const payload=jwt?verifyJWT(jwt):null;
      const isAdm=adminTok===CFG.token||(payload&&payload.admin);
      // Admin page itself handles login — serve it, the JS will require credentials
    }
    // Serve landing page at / for browser visitors; Electron sends X-Electron-App header
    const isElectron=req.headers['x-electron-app']==='1';
    const wantsIDE=route==='/app'||route==='/app/'||isElectron;
    const landingExists=fs.existsSync(path.join(pub,'landing.html'));
    let fp=route==='/'&&!wantsIDE&&landingExists?path.join(pub,'landing.html'):route==='/'||wantsIDE?path.join(pub,'index.html'):route==='/admin'||route==='/admin/'?path.join(pub,'admin.html'):path.join(pub,route.slice(1));
    const rfp=path.resolve(fp);
    if(!rfp.startsWith(path.resolve(pub))){res.writeHead(403);res.end('Forbidden');return;}
    if(fs.existsSync(rfp)&&fs.statSync(rfp).isFile()){const mime={'.html':'text/html','.js':'application/javascript','.mjs':'application/javascript','.css':'text/css','.svg':'image/svg+xml','.png':'image/png','.jpg':'image/jpeg','.jpeg':'image/jpeg','.ico':'image/x-icon','.json':'application/json','.webmanifest':'application/manifest+json','.woff2':'font/woff2','.woff':'font/woff','.ttf':'font/ttf'};const isSW=route==='/sw.js';res.writeHead(200,{'Content-Type':mime[path.extname(rfp)]||'text/plain','Cache-Control':isSW?'no-store':'public, max-age=3600'});res.end(fs.readFileSync(rfp));return;}
    const idx=path.join(pub,route.startsWith('/admin')?'admin.html':'index.html');
    res.writeHead(200,{'Content-Type':'text/html','Cache-Control':'no-store'});
    res.end(fs.existsSync(idx)?fs.readFileSync(idx):Buffer.from('AXIOM'));return;
  }

  // System
  if(route==='/api/ping'){const tok=req.headers['x-axiom-token'];return sendJson(res,{ok:true,v:'6.0',ws_terminal:true,auth:tok===CFG.token});}
  if(route==='/api/token'&&req.method==='POST')return sendJson(res,{ok:data.token===CFG.token});
  if(route==='/api/plans')return sendJson(res,{plans:PLANS});

  // API key
  if(route==='/api/key'&&req.method==='GET'){const k=getKey();return sendJson(res,{hasKey:!!k,masked:k?k.slice(0,14)+'••••':''});}
  if(route==='/api/key'&&req.method==='POST'){if(!(data.key||'').startsWith('sk-ant-'))return sendJson(res,{error:'Invalid key'},400);atomicWriteSync(KEY_FILE,data.key,{mode:0o600});return sendJson(res,{ok:true});}

  // ── AI Provider config (Anthropic / Ollama / LM Studio) ──────────
  if(route==='/api/ai/provider'&&req.method==='GET'){return sendJson(res,getAIProvider());}
  if(route==='/api/ai/provider'&&req.method==='POST'){
    const {provider='anthropic',model='',baseUrl='',apiKey:provKey=''}=data;
    if(!['anthropic','ollama','lmstudio'].includes(provider))return sendJson(res,{error:'Unknown provider'},400);
    const cfg={provider,model:model||undefined,baseUrl:baseUrl||undefined,apiKey:provKey||undefined,updated:new Date().toISOString()};
    Object.keys(cfg).forEach(k=>{if(cfg[k]===undefined)delete cfg[k];});
    saveAIProvider(cfg);return sendJson(res,{ok:true,provider:cfg});
  }
  if(route==='/api/ai/models'&&req.method==='GET'){
    const prov=getAIProvider();
    if(prov.provider==='anthropic'){
      return sendJson(res,{models:['claude-opus-4-8','claude-sonnet-4-6','claude-sonnet-4-20250514','claude-haiku-4-5-20251001'],provider:'anthropic'});
    }
    const baseUrl=prov.baseUrl||(prov.provider==='lmstudio'?'http://localhost:1234':'http://localhost:11434');
    try{
      const result=await new Promise((resolve,reject)=>{
        const u=new urlMod.URL(baseUrl+'/v1/models');
        const mod2=u.protocol==='https:'?https:http;
        const r=mod2.get({hostname:u.hostname,port:u.port,path:u.pathname,timeout:4000},resp=>{let d='';resp.on('data',c=>d+=c);resp.on('end',()=>{try{resolve(JSON.parse(d));}catch(e){reject(e);}});});
        r.on('error',reject);r.on('timeout',()=>{r.destroy();reject(new Error('timeout'));});
      });
      const models=(result.data||result.models||[]).map(m=>m.id||m.name||m).filter(Boolean);
      return sendJson(res,{models,provider:prov.provider});
    }catch(e){return sendJson(res,{models:[],error:e.message,provider:prov.provider});}
  }

  // ── AI Orchestra ─────────────────────────────────────────────────
  if(route==='/api/ai/orchestra'&&req.method==='GET'){return sendJson(res,getOrchestra());}
  if(route==='/api/ai/orchestra'&&req.method==='POST'){
    const orch=getOrchestra();
    const {role,provider,model,baseUrl,apiKey:rKey,systemPrompt}=data;
    if(!['architect','coder','documenter'].includes(role))return sendJson(res,{error:'Unknown role'},400);
    orch[role]={...orch[role],...(provider&&{provider}),...(model&&{model}),...(baseUrl!==undefined&&{baseUrl}),...(rKey!==undefined&&{apiKey:rKey}),...(systemPrompt&&{systemPrompt})};
    saveOrchestra(orch);return sendJson(res,{ok:true,orchestra:orch});
  }
  // Orchestrated pipeline: task → architect plan → coder implementation → documenter docs
  if(route==='/api/ai/orchestra/run'&&req.method==='POST'){
    const {task,code,mode='full',lang='javascript'}=data;
    if(!task&&!code)return sendJson(res,{error:'task or code required'},400);
    res.writeHead(200,{'Content-Type':'text/event-stream','Cache-Control':'no-cache','Access-Control-Allow-Origin':'*'});
    const emit=(role,content,done=false)=>{
      try{res.write('data: '+JSON.stringify({role,content,done})+'\n\n');}catch(e){}
    };
    try{
      let plan='',impl='',docs='';
      if(mode==='full'||mode==='architect'){
        emit('architect','Analyzing and structuring your request…');
        const sys=getOrchestra().architect.systemPrompt;
        plan=await aiCallRole('architect',sys,[{role:'user',content:`Language: ${lang}\n\nTask: ${task||'Analyze and plan this code:\n'+code}`}],{max_tokens:2048});
        emit('architect',plan,mode==='architect');
      }
      if(mode==='full'||mode==='coder'){
        emit('coder','Writing implementation…');
        const codeTask=mode==='full'?`Architecture plan:\n${plan}\n\nOriginal task: ${task||''}`:task||code;
        const sys2=getOrchestra().coder.systemPrompt;
        impl=await aiCallRole('coder',sys2,[{role:'user',content:`Language: ${lang}\n\n${codeTask}`}],{max_tokens:4096});
        emit('coder',impl,mode==='coder');
      }
      if(mode==='full'||mode==='documenter'){
        emit('documenter','Generating documentation…');
        const docSrc=impl||code||task;
        const sys3=getOrchestra().documenter.systemPrompt;
        docs=await aiCallRole('documenter',sys3,[{role:'user',content:`Language: ${lang}\n\nDocument this:\n\`\`\`${lang}\n${docSrc}\n\`\`\``}],{max_tokens:2048});
        emit('documenter',docs,true);
      }
      if(mode==='full'){
        emit('summary',JSON.stringify({plan,implementation:impl,documentation:docs}),true);
      }
    }catch(e){emit('error',e.message,true);}
    res.end();return;
  }

  // Memory
  if(route==='/api/memory'){if(req.method==='GET')return sendJson(res,Mem.load());if(req.method==='PUT'){Mem.patch(data);return sendJson(res,{ok:true,memory:Mem.load()});}if(req.method==='DELETE'){Mem.clear();return sendJson(res,{ok:true});}}
  if(route==='/api/memory/fact'&&req.method==='POST'){Mem.addFact(data.f||data.fact||'');return sendJson(res,{ok:true});}
  if(route==='/api/memory/insight'&&req.method==='POST'){Mem.addInsight(data.t||'');return sendJson(res,{ok:true});}
  if(route==='/api/memory/todo'&&req.method==='POST'){Mem.addTodo(data.t||'');return sendJson(res,{ok:true});}
  if(route==='/api/memory/todo/done'&&req.method==='POST'){const m=Mem.load();const t=m.todos.find(x=>x.t===data.t);if(t)t.done=true;Mem.save();return sendJson(res,{ok:true});}
  if(route==='/api/memory/export'&&req.method==='GET'){res.writeHead(200,{'Content-Type':'application/json','Content-Disposition':'attachment; filename="axiom_memory.json"','Access-Control-Allow-Origin':'*'});res.end(JSON.stringify(Mem.load(),null,2));return;}
  if(route==='/api/session/start'&&req.method==='POST'){const m=Mem.startSession();return sendJson(res,{memory:m,sessions:m.sessions});}
  if(route==='/api/session/end'&&req.method==='POST'){if(data.s){const m=Mem.load();m.sessionNotes.unshift({s:data.s,d:new Date().toISOString()});m.sessionNotes=m.sessionNotes.slice(0,50);Mem.save();}return sendJson(res,{ok:true});}

  // Settings persistence
  if(route==='/api/settings'&&req.method==='GET'){
    try{return sendJson(res,JSON.parse(fs.readFileSync(SETTINGS_FILE,'utf8')));}
    catch(e){return sendJson(res,{theme:'dark',fontSize:14,tabSize:2,wordWrap:true,minimap:true,autoSave:false,formatOnSave:false,bracketPairColorization:true});}
  }
  if(route==='/api/settings'&&req.method==='PUT'){
    const allowed=['theme','fontSize','tabSize','wordWrap','minimap','autoSave','formatOnSave','bracketPairColorization','fontFamily','lineHeight','cursorStyle','renderWhitespace','scrollBeyondLastLine'];
    const settings={};allowed.forEach(k=>{if(data[k]!==undefined)settings[k]=data[k];});
    settings.updated=new Date().toISOString();
    atomicWriteSync(SETTINGS_FILE,JSON.stringify(settings,null,2));
    return sendJson(res,{ok:true,settings});
  }

  // Extensions management
  const EXT_FILE=path.join(DATA,'extensions.json');
  if(route==='/api/extensions'&&req.method==='GET'){
    try{return sendJson(res,JSON.parse(fs.readFileSync(EXT_FILE,'utf8')));}
    catch(e){return sendJson(res,{installed:[],marketplace:[]});}
  }
  if(route==='/api/extensions'&&req.method==='POST'){
    const ext={id:data.id||crypto.randomUUID(),name:data.name||'Extension',version:data.version||'1.0.0',enabled:true,installed:new Date().toISOString()};
    let exts;try{exts=JSON.parse(fs.readFileSync(EXT_FILE,'utf8'));}catch(e){exts={installed:[]};}
    if(!exts.installed)exts.installed=[];
    if(exts.installed.find(e=>e.id===ext.id))return sendJson(res,{error:'Already installed'},409);
    exts.installed.push(ext);
    atomicWriteSync(EXT_FILE,JSON.stringify(exts,null,2));
    return sendJson(res,{ok:true,extension:ext});
  }
  if(route.match(/^\/api\/extensions\/[^/]+$/)&&req.method==='PUT'){
    const extId=route.split('/')[3];
    let exts;try{exts=JSON.parse(fs.readFileSync(EXT_FILE,'utf8'));}catch(e){return sendJson(res,{error:'No extensions'},404);}
    const idx=exts.installed?.findIndex(e=>e.id===extId);
    if(idx===-1||idx===undefined)return sendJson(res,{error:'Not found'},404);
    if(data.enabled!==undefined)exts.installed[idx].enabled=data.enabled;
    atomicWriteSync(EXT_FILE,JSON.stringify(exts,null,2));
    return sendJson(res,{ok:true,extension:exts.installed[idx]});
  }
  if(route.match(/^\/api\/extensions\/[^/]+$/)&&req.method==='DELETE'){
    const extId=route.split('/')[3];
    let exts;try{exts=JSON.parse(fs.readFileSync(EXT_FILE,'utf8'));}catch(e){return sendJson(res,{error:'No extensions'},404);}
    exts.installed=(exts.installed||[]).filter(e=>e.id!==extId);
    atomicWriteSync(EXT_FILE,JSON.stringify(exts,null,2));
    return sendJson(res,{ok:true});
  }

  // Extension marketplace — curated list + install/uninstall by ID
  if(route==='/api/extensions/marketplace'&&req.method==='GET'){
    const MARKETPLACE=[
      {id:'prettier',name:'Prettier',description:'Opinionated code formatter',category:'Formatters',icon:'🎨',version:'3.2.5',publisher:'Prettier',downloads:'30M+',rating:4.6},
      {id:'eslint',name:'ESLint',description:'JavaScript/TypeScript linting. Detects common bugs.',category:'Linters',icon:'🟨',version:'8.57.0',publisher:'Microsoft',downloads:'35M+',rating:4.7},
      {id:'pylint',name:'Pylint',description:'Python static code analysis',category:'Linters',icon:'🐍',version:'3.1.0',publisher:'PyCQA',downloads:'12M+',rating:4.6},
      {id:'black',name:'Black',description:'Python code formatter — uncompromising',category:'Formatters',icon:'⬛',version:'24.3.0',publisher:'PSF',downloads:'15M+',rating:4.7},
      {id:'gofmt',name:'gofmt',description:'Go code formatter (built-in)',category:'Formatters',icon:'🐹',version:'1.22.0',publisher:'Google',downloads:'8M+',rating:4.8},
      {id:'rustfmt',name:'rustfmt',description:'Rust code formatter',category:'Formatters',icon:'🦀',version:'1.7.0',publisher:'Rust',downloads:'5M+',rating:4.8},
      {id:'clangformat',name:'clang-format',description:'C/C++ code formatter',category:'Formatters',icon:'⚙️',version:'17.0.0',publisher:'LLVM',downloads:'4M+',rating:4.5},
      {id:'pyright',name:'Pyright',description:'Python type checker & LSP',category:'Language Servers',icon:'✔️',version:'1.1.355',publisher:'Microsoft',downloads:'20M+',rating:4.8},
      {id:'tsserver',name:'TypeScript LS',description:'JS/TS IntelliSense & type checking',category:'Language Servers',icon:'🟦',version:'5.4.5',publisher:'Microsoft',downloads:'40M+',rating:4.9},
      {id:'gopls',name:'gopls',description:'Go language server',category:'Language Servers',icon:'🐹',version:'0.15.3',publisher:'Google',downloads:'10M+',rating:4.8},
      {id:'rust-analyzer',name:'rust-analyzer',description:'Rust language server',category:'Language Servers',icon:'🦀',version:'2024.3.0',publisher:'Rust',downloads:'8M+',rating:4.9},
      {id:'html-lsp',name:'HTML Language Server',description:'HTML IntelliSense & validation',category:'Language Servers',icon:'🌐',version:'1.4.13',publisher:'Microsoft',downloads:'25M+',rating:4.7},
      {id:'css-lsp',name:'CSS Language Server',description:'CSS/SCSS IntelliSense',category:'Language Servers',icon:'🎨',version:'1.4.13',publisher:'Microsoft',downloads:'22M+',rating:4.7},
      {id:'json-lsp',name:'JSON Language Server',description:'JSON schema validation & IntelliSense',category:'Language Servers',icon:'{}',version:'1.3.4',publisher:'Microsoft',downloads:'30M+',rating:4.8},
      {id:'gitlens',name:'GitLens',description:'Enhanced Git: blame, history, visualization',category:'SCM',icon:'⎇',version:'15.0.0',publisher:'GitKraken',downloads:'25M+',rating:4.8},
      {id:'docker',name:'Docker',description:'Dockerfile syntax and container support',category:'Other',icon:'🐳',version:'1.29.0',publisher:'Microsoft',downloads:'20M+',rating:4.7},
      {id:'indent',name:'Indent Rainbow',description:'Colorful indent guides',category:'Other',icon:'🌈',version:'8.3.1',publisher:'oderwat',downloads:'10M+',rating:4.8},
      {id:'errorlens',name:'Error Lens',description:'Show errors inline next to the code',category:'Linters',icon:'🔴',version:'3.16.0',publisher:'usernamehw',downloads:'5M+',rating:4.8},
      {id:'rest',name:'REST Client',description:'Send HTTP requests from .http files',category:'Other',icon:'🔌',version:'0.25.1',publisher:'Huachao Mao',downloads:'7M+',rating:4.8},
    ];
    let exts;try{exts=JSON.parse(fs.readFileSync(EXT_FILE,'utf8'));}catch(e){exts={installed:[]};}
    const installedIds=new Set((exts.installed||[]).map(e=>e.id));
    const extensions=MARKETPLACE.map(e=>({...e,installed:installedIds.has(e.id)}));
    return sendJson(res,{extensions});
  }

  if(route==='/api/extensions/installed'&&req.method==='GET'){
    let exts;try{exts=JSON.parse(fs.readFileSync(EXT_FILE,'utf8'));}catch(e){exts={installed:[]};}
    return sendJson(res,{extensions:exts.installed||[]});
  }

  if(route==='/api/extensions/install'&&req.method==='POST'){
    const {id,name,version,publisher}=data;
    if(!id)return sendJson(res,{error:'Missing extension id'},400);
    let exts;try{exts=JSON.parse(fs.readFileSync(EXT_FILE,'utf8'));}catch(e){exts={installed:[]};}
    if(!exts.installed)exts.installed=[];
    if(exts.installed.find(e=>e.id===id))return sendJson(res,{ok:true,name:name||id,already:true,extension:exts.installed.find(e=>e.id===id)});
    const ext={id,name:name||id,version:version||'latest',publisher:publisher||'',enabled:true,installed:new Date().toISOString()};
    exts.installed.push(ext);
    atomicWriteSync(EXT_FILE,JSON.stringify(exts,null,2));
    return sendJson(res,{ok:true,name:ext.name,extension:ext});
  }

  if(route==='/api/extensions/uninstall'&&req.method==='POST'){
    const {id}=data;
    if(!id)return sendJson(res,{error:'Missing id'},400);
    let exts;try{exts=JSON.parse(fs.readFileSync(EXT_FILE,'utf8'));}catch(e){return sendJson(res,{error:'No extensions'},404);}
    exts.installed=(exts.installed||[]).filter(e=>e.id!==id);
    atomicWriteSync(EXT_FILE,JSON.stringify(exts,null,2));
    return sendJson(res,{ok:true});
  }

  // Port scanner — detect processes listening on local TCP ports
  if(route==='/api/ports'&&req.method==='GET'){
    const{exec}=require('child_process');
    const cmd=process.platform==='win32'
      ?'netstat -ano -p TCP'
      :'ss -tlnp 2>/dev/null || netstat -tlnp 2>/dev/null';
    exec(cmd,{timeout:5000},(err,stdout)=>{
      if(err&&!stdout)return sendJson(res,{ports:[]});
      const ports=[];const seen=new Set();
      const lines=stdout.split('\n');
      for(const line of lines){
        // Match port from ss output: Local Address:Port
        const m=line.match(/:(\d{2,5})\s/);
        if(!m)continue;
        const port=parseInt(m[1]);
        if(port<1024||port>65535||seen.has(port))continue;
        if([3306,5432,6379,27017,9200].includes(port))continue; // skip db/cache ports from listing
        seen.add(port);
        const pidM=line.match(/pid=(\d+)/)||line.match(/(\d+)\//);
        const pid=pidM?parseInt(pidM[1]):null;
        // Guess process name from common dev ports
        const names={3000:'Node/React',3001:'Node',4000:'Node/Ember',4200:'Angular',5000:'Python/Flask',5001:'Node',5173:'Vite',5174:'Vite',8000:'Python',8080:'HTTP',8081:'HTTP',8888:'Jupyter',9000:'PHP/Node',9229:'Node Debugger'};
        ports.push({port,pid,name:names[port]||null});
      }
      return sendJson(res,{ports:ports.slice(0,20)});
    });
    return; // async response
  }

  // Static file server — serve arbitrary files by path (for image preview etc.)
  if(route==='/api/static'&&req.method==='GET'){
    const filePath=params.get('path')||params.get('file');
    if(!filePath)return sendJson(res,{error:'Missing path'},400);
    const abs=path.resolve(filePath);
    if(!fs.existsSync(abs)||!fs.statSync(abs).isFile())return sendJson(res,{error:'Not found'},404);
    const ext2=path.extname(abs).toLowerCase();
    const mimeMap={'.png':'image/png','.jpg':'image/jpeg','.jpeg':'image/jpeg','.gif':'image/gif','.svg':'image/svg+xml','.webp':'image/webp','.ico':'image/x-icon','.bmp':'image/bmp','.pdf':'application/pdf','.mp4':'video/mp4','.webm':'video/webm'};
    const ct=mimeMap[ext2]||'application/octet-stream';
    res.writeHead(200,{'Content-Type':ct,'Cache-Control':'public, max-age=60'});
    fs.createReadStream(abs).pipe(res);
    return;
  }

  // Theme management
  const THEMES_FILE=path.join(DATA,'themes.json');
  if(route==='/api/themes'&&req.method==='GET'){
    try{return sendJson(res,JSON.parse(fs.readFileSync(THEMES_FILE,'utf8')));}
    catch(e){return sendJson(res,{custom:[],active:'dark'});}
  }
  if(route==='/api/themes'&&req.method==='POST'){
    let themes;try{themes=JSON.parse(fs.readFileSync(THEMES_FILE,'utf8'));}catch(e){themes={custom:[],active:'dark'};}
    if(!themes.custom)themes.custom=[];
    const theme={id:data.id||crypto.randomUUID(),name:data.name||'Custom Theme',colors:data.colors||{},created:new Date().toISOString()};
    themes.custom.push(theme);
    atomicWriteSync(THEMES_FILE,JSON.stringify(themes,null,2));
    return sendJson(res,{ok:true,theme});
  }
  if(route==='/api/themes/active'&&req.method==='GET'){
    try{const t=JSON.parse(fs.readFileSync(THEMES_FILE,'utf8'));return sendJson(res,{active:t.active||'dark'});}
    catch(e){return sendJson(res,{active:'dark'});}
  }
  if(route==='/api/themes/active'&&req.method==='PUT'){
    let themes;try{themes=JSON.parse(fs.readFileSync(THEMES_FILE,'utf8'));}catch(e){themes={custom:[],active:'dark'};}
    themes.active=data.theme||'dark';themes.updated=new Date().toISOString();
    atomicWriteSync(THEMES_FILE,JSON.stringify(themes,null,2));
    return sendJson(res,{ok:true,active:themes.active});
  }

  // Snippets
  if(route==='/api/snippets'&&req.method==='GET')return sendJson(res,Snippets.load());
  if(route==='/api/snippets'&&req.method==='POST'){Snippets.add(data.name||'Untitled',data.code||'',data.lang||'',data.desc||'');return sendJson(res,{ok:true,snippets:Snippets.load()});}
  if(route.match(/^\/api\/snippets\/[^/]+$/)&&req.method==='DELETE'){Snippets.remove(route.split('/')[3]);return sendJson(res,{ok:true});}

  // Settings — persistent IDE preferences (per user when logged in, else global)
  if(route==='/api/settings'){
    const u=getReqUser(req);
    const userId=u?.id||'_global';
    const settingsFile=path.join(DATA,'settings.'+userId.replace(/[^a-zA-Z0-9_-]/g,'_')+'.json');
    if(req.method==='GET'){
      try{const s=JSON.parse(fs.readFileSync(settingsFile,'utf8'));return sendJson(res,{settings:s,userId});}
      catch(e){return sendJson(res,{settings:{},userId});}
    }
    if(req.method==='POST'){
      if(!data||typeof data!=='object')return sendJson(res,{error:'Invalid body'},400);
      // Whitelist allowed keys to avoid storing arbitrary data
      const ALLOWED=['fontSize','fontFamily','tabSize','wordWrap','minimap','lineNumbers','lineHeight','indentGuides','bracketMatch','lintOnType','stickyScroll','renderWhitespace','theme','vimMode','zenMode','autosave','autosaveDelay','codeFolding','ghostCompletion','ghostDelay','aiModel','aiMaxTokens','aiSystemExtra','telemetry','keymapOverrides'];
      const merged={};
      for(const k of Object.keys(data)){if(ALLOWED.includes(k))merged[k]=data[k];}
      try{
        let existing={};try{existing=JSON.parse(fs.readFileSync(settingsFile,'utf8'));}catch(e){}
        const out={...existing,...merged,_updated:Date.now()};
        atomicWriteSync(settingsFile,JSON.stringify(out,null,2),{mode:0o600});
        return sendJson(res,{ok:true,settings:out});
      }catch(e){return sendJson(res,{error:e.message},500);}
    }
    if(req.method==='DELETE'){try{fs.unlinkSync(settingsFile);}catch(e){}return sendJson(res,{ok:true});}
  }

  // Files
  if(route==='/api/files'&&req.method==='GET'){const d=safe(q.path||os.homedir());if(!d)return sendJson(res,{error:'Not allowed'},403);return sendJson(res,{entries:listDir(d),current:d,home:os.homedir()});}
  if(route==='/api/file'&&req.method==='GET'){const s=safe(q.path);if(!s)return sendJson(res,{error:'Not allowed'},403);try{const st=fs.statSync(s);if(st.size>5*1024*1024)return sendJson(res,{error:'File too large'},400);return sendJson(res,{content:fs.readFileSync(s,'utf8'),path:s});}catch(e){return sendJson(res,{error:e.message},400);}}
  if(route==='/api/file'&&req.method==='POST'){const s=safe(data.path);if(!s)return sendJson(res,{error:'Not allowed'},403);try{fs.mkdirSync(path.dirname(s),{recursive:true});fs.writeFileSync(s,data.content??'');auditLog('file_write',{path:data.path},req);return sendJson(res,{ok:true});}catch(e){return sendJson(res,{error:e.message},400);}}
  if(route==='/api/file'&&req.method==='DELETE'){const s=safe(data.path);if(!s)return sendJson(res,{error:'Not allowed'},403);try{fs.unlinkSync(s);auditLog('file_delete',{path:data.path},req);return sendJson(res,{ok:true});}catch(e){return sendJson(res,{error:e.message},400);}}
  if(route==='/api/mkdir'&&req.method==='POST'){const s=safe(data.path);if(!s)return sendJson(res,{error:'Not allowed'},403);try{fs.mkdirSync(s,{recursive:true});return sendJson(res,{ok:true});}catch(e){return sendJson(res,{error:e.message},400);}}
  if(route==='/api/rename'&&req.method==='POST'){const a=safe(data.from),b=safe(data.to);if(!a||!b)return sendJson(res,{error:'Not allowed'},403);try{fs.renameSync(a,b);return sendJson(res,{ok:true});}catch(e){return sendJson(res,{error:e.message},400);}}

  // Search
  if(route==='/api/search'&&req.method==='POST'){
    const dir=safe(data.dir||os.homedir());if(!dir)return sendJson(res,{error:'Not allowed'},403);
    const results=[];
    (function walk(d,depth){if(depth>6||results.length>120)return;try{fs.readdirSync(d,{withFileTypes:true}).forEach(e=>{if(SKIP.includes(e.name)||e.name.startsWith('.'))return;const fp=path.join(d,e.name);if(e.isDirectory()){walk(fp,depth+1);return;}if(data.filename&&e.name.toLowerCase().includes(data.filename.toLowerCase())){results.push({file:fp,name:e.name,type:'file'});return;}if(data.query){try{const lines=fs.readFileSync(fp,'utf8').split('\n');lines.forEach((line,i)=>{if(results.length>120)return;if(line.toLowerCase().includes(data.query.toLowerCase()))results.push({file:fp,line:i+1,text:line.trim().slice(0,140),name:e.name});});}catch(e){}}});}catch(e){}  })(dir,0);
    return sendJson(res,{results:results.slice(0,120)});
  }

  // Global search — case / whole-word / regex / glob include & exclude
  if((route==='/api/search/global'||route==='/api/search/replace')&&(req.method==='GET'||req.method==='POST')){
    const isReplace = route==='/api/search/replace';
    const src = req.method==='POST' ? data : q;
    const dir = safe(src.dir||os.homedir()); if(!dir) return sendJson(res,{error:'Not allowed'},403);
    const query = src.query||'';
    if(!query) return sendJson(res,{error:'query required'},400);
    const caseSensitive = src.caseSensitive==='true' || src.caseSensitive===true;
    const wholeWord     = src.wholeWord==='true'     || src.wholeWord===true;
    const useRegex      = src.regex==='true'         || src.regex===true;
    const include = (src.filePattern||src.include||'').split(',').map(s=>s.trim()).filter(Boolean);
    const exclude = (src.exclude||'').split(',').map(s=>s.trim()).filter(Boolean);
    const replaceWith = isReplace ? (src.replace||'') : null;
    // Build regex
    let rx;
    try{
      let pat = useRegex ? query : query.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
      if(wholeWord) pat = '\\b'+pat+'\\b';
      rx = new RegExp(pat, caseSensitive?'g':'gi');
    }catch(e){return sendJson(res,{error:'Invalid regex: '+e.message},400);}
    const minimatch = (name, patterns)=>{
      if(!patterns.length) return false;
      return patterns.some(p=>{
        const re = new RegExp('^'+p.replace(/[.+^${}()|[\]\\]/g,'\\$&').replace(/\*/g,'.*').replace(/\?/g,'.')+'$');
        return re.test(name);
      });
    };
    const results = []; let filesChanged = 0, replaceCount = 0; let truncated = false;
    const MAX = isReplace ? 500 : 500;
    (function walk(d,depth){
      if(depth>10||results.length>=MAX) return;
      let entries; try{entries=fs.readdirSync(d,{withFileTypes:true});}catch(e){return;}
      for(const e of entries){
        if(SKIP.includes(e.name)) continue;
        if(!isReplace && e.name.startsWith('.') && !include.length) continue;
        const fp=path.join(d,e.name);
        if(e.isDirectory()){walk(fp,depth+1);if(results.length>=MAX){truncated=true;return;}continue;}
        if(include.length && !minimatch(e.name, include)) continue;
        if(exclude.length && minimatch(e.name, exclude)) continue;
        let txt; try{
          const st=fs.statSync(fp); if(st.size>2*1024*1024) continue;
          txt = fs.readFileSync(fp,'utf8');
        }catch(e){continue;}
        // Skip likely binary files
        if(txt.indexOf('\0')!==-1) continue;
        if(isReplace){
          rx.lastIndex = 0;
          if(!rx.test(txt)) continue;
          rx.lastIndex = 0;
          const newTxt = txt.replace(rx, ()=>{ replaceCount++; return replaceWith; });
          if(newTxt!==txt){
            try{fs.writeFileSync(fp,newTxt);filesChanged++;auditLog('search_replace',{path:fp,query,replace:replaceWith},req);}catch(e){}
          }
          continue;
        }
        const lines = txt.split('\n');
        for(let i=0;i<lines.length;i++){
          rx.lastIndex = 0;
          const m = rx.exec(lines[i]);
          if(!m) continue;
          results.push({
            file: fp,
            line: i+1,
            column: m.index+1,
            context: lines[i].slice(Math.max(0,m.index-40), m.index+m[0].length+80),
            match: m[0]
          });
          if(results.length>=MAX){truncated=true;return;}
        }
      }
    })(dir,0);
    if(isReplace) return sendJson(res,{ok:true,filesChanged,replaceCount});
    return sendJson(res,{results,truncated});
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
    try{const text=await aiCall('Code completion engine. Return ONLY the completion text. No markdown, no explanation, no backticks.',[{role:'user',content:`Language: ${data.lang||'code'}\nCode before cursor:\n${data.prefix}\nComplete naturally from exactly where the code left off:`}],{max_tokens:400});return sendJson(res,{completion:text});}
    catch(e){return sendJson(res,{error:e.message},500);}
  }

  // AI chat streaming
  if(route==='/api/chat'&&req.method==='POST'){
    const apiKey=getKey(data.apiKey);if(!apiKey)return sendJson(res,{error:'No API key — add in Settings ⚙'},401);
    // ── Token budget enforcement ──
    const chatUser=getReqUser(req);
    if(chatUser){
      const budget=getTokenBudget(chatUser);
      if(!budget.allowed){
        return sendJson(res,{error:'tokens_exhausted',message:`You've used all ${budget.limit.toLocaleString()} tokens for this month. Buy extra tokens or upgrade your plan.`,used:budget.used,limit:budget.limit,plan:budget.plan},429);
      }
    }
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
    const prov=getAIProvider();
    if(prov.provider==='anthropic'){
      const rb=JSON.stringify({model:prov.model||'claude-sonnet-4-20250514',max_tokens:8192,stream:true,system:sysPrompt(projCtx+fileCtx+relCtx),messages:msgs});
      const inputTokens=Math.ceil(Buffer.byteLength(rb)/4);
      const apiReq=https.request({hostname:'api.anthropic.com',path:'/v1/messages',method:'POST',headers:{'Content-Type':'application/json','x-api-key':apiKey,'anthropic-version':'2023-06-01','Content-Length':Buffer.byteLength(rb)}},apiRes=>{
        let full='';let outputTokens=0;
        apiRes.on('data',chunk=>{res.write(chunk);const s=chunk.toString();const m=s.match(/"text":"((?:[^"\\]|\\.)*)"/);if(m){const t=m[1].replace(/\\n/g,'\n').replace(/\\"/g,'"').replace(/\\\\/g,'\\');full+=t;outputTokens+=Math.ceil(t.length/4);}
          const um=s.match(/"usage"\s*:\s*\{[^}]*"output_tokens"\s*:\s*(\d+)/);if(um)outputTokens=parseInt(um[1]);
        });
        apiRes.on('end',()=>{res.end();const lastUser=msgs.length?msgs[msgs.length-1].content:'';if(lastUser&&typeof lastUser==='string')Mem.extract(lastUser,full);if(chatUser){const totalUsed=inputTokens+outputTokens;if(dbPool)dbPool.query('UPDATE users SET tokens_used_month=tokens_used_month+? WHERE id=?',[totalUsed,chatUser.id]).catch(()=>{});try{const ud=JSON.parse(fs.readFileSync(USERS_FILE,'utf8'));const u=ud.users?.find(x=>x.id===chatUser.id);if(u){u.tokens_used_month=(u.tokens_used_month||0)+totalUsed;atomicWriteSync(USERS_FILE,JSON.stringify(ud,null,2),{mode:0o600});}}catch(e){}DB.recordUsage({user_id:chatUser.id,action:'chat',tokens_in:inputTokens,tokens_out:outputTokens,cost:totalUsed*0.000003});}});
      });
      apiReq.on('error',()=>{try{res.end();}catch(x){}});apiReq.write(rb);apiReq.end();
    } else {
      // Local model (Ollama / LM Studio) — non-streaming, emitted as Anthropic-format SSE
      aiCall(sysPrompt(projCtx+fileCtx+relCtx),msgs,{apiKey,max_tokens:8192}).then(text=>{
        const model=prov.model||'local';const provider=prov.provider==='lmstudio'?'LM Studio':'Ollama';
        res.write('data: {"type":"message_start","message":{"model":"'+model+' ('+provider+')","usage":{"input_tokens":0,"output_tokens":0}}}\n\n');
        res.write('data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n');
        const chunks=text.match(/.{1,200}/gs)||[text];for(const chunk of chunks)res.write('data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":'+JSON.stringify(chunk)+'}}\n\n');
        res.write('data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":'+Math.ceil(text.length/4)+'}}\n\n');
        res.end();const lastUser=msgs.length?msgs[msgs.length-1].content:'';if(lastUser&&typeof lastUser==='string')Mem.extract(lastUser,text);
        if(chatUser)DB.recordUsage({user_id:chatUser.id,action:'chat',tokens_in:0,tokens_out:Math.ceil(text.length/4),cost:0});
      }).catch(e=>{res.write('data: {"type":"error","error":{"message":'+JSON.stringify(e.message)+'}}\n\n');res.end();});
    }
    return;
  }

  // Admin login — password-based authentication for admin dashboard
  if(route==='/api/admin/login'&&req.method==='POST'){
    if(!data.email||!data.password)return sendJson(res,{error:'Email and password required'},400);
    const r=UsersDB.login(data.email,data.password);
    if(r.error)return sendJson(res,{error:r.error},401);
    if(r.user.role!=='admin')return sendJson(res,{error:'Access denied: admin role required'},403);
    const adminToken=makeJWT({id:r.user.id,email:r.user.email,plan:r.user.plan,admin:true});
    auditLog('admin_login',{email:data.email},req);
    return sendJson(res,{ok:true,token:adminToken,user:{name:r.user.name,email:r.user.email,plan:r.user.plan,avatar:r.user.avatar}});
  }

  // Admin routes — RBAC check
  if(route.startsWith('/api/admin')&&!isAdmin(req,data))return sendJson(res,{error:'Forbidden: admin role required'},403);
  if(route.startsWith('/api/admin'))auditLog('admin_access',{route},req);
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
    try{const aiText=await aiCall(sys,[{role:'user',content:question}],{apiKey,max_tokens:800});return sendJson(res,{...local,ai_answer:aiText||local.answer,ai_enhanced:true});}
    catch(e){return sendJson(res,{...local,ai_enhanced:false});}
  }
  if(route==='/api/admin/chat'&&req.method==='POST'){
    const apiKey=getKey();if(!apiKey)return sendJson(res,{error:'No API key'},401);
    const a=await DB.getAnalytics();const msgs=(data.messages||[]).slice(-20);
    const sys=`You are AXIOM Admin for Zawadi. Live: ${a.overview.total_users} users, $${a.revenue.mrr}/mo MRR, $${a.revenue.total.toFixed(2)} total. Give specific insights and recommendations.`;
    res.writeHead(200,{'Content-Type':'text/event-stream','Cache-Control':'no-cache','Connection':'keep-alive','Access-Control-Allow-Origin':'*','X-Accel-Buffering':'no'});
    aiStream(sys,msgs,{apiKey,max_tokens:2048},res);return;
  }
  if(route==='/api/admin/users/export'&&req.method==='GET'){const users=await DB.getUsers();const csv='id,name,email,plan,status,total_paid,chat_count,tokens_in,tokens_out,tokens_used_month,created_at,last_seen\n'+users.map(u=>[u.id,u.name,u.email,u.plan,u.status,u.total_paid||0,u.chat_count||0,u.tokens_in||0,u.tokens_out||0,u.tokens_used_month||0,u.created_at,u.last_seen||''].join(',')).join('\n');res.writeHead(200,{'Content-Type':'text/csv','Content-Disposition':'attachment; filename="axiom_users.csv"','Access-Control-Allow-Origin':'*'});res.end(csv);return;}

  // ── Admin: Token usage overview ──────────────────────────────────
  if(route==='/api/admin/token-usage'&&req.method==='GET'){
    try{
      const users=await DB.getUsers();
      const summary=users.map(u=>({
        id:u.id,name:u.name,email:u.email,plan:u.plan,
        tokens_used_month:u.tokens_used_month||0,
        tokens_limit:PLANS[u.plan]?.tokens_month||0,
        bonus_tokens:u.bonus_tokens||0,
        tokens_in:u.tokens_in||0,tokens_out:u.tokens_out||0,
        pct_used:PLANS[u.plan]?.tokens_month?Math.round(((u.tokens_used_month||0)/PLANS[u.plan].tokens_month)*100):0
      }));
      const totalUsed=summary.reduce((s,u)=>s+u.tokens_used_month,0);
      const totalLimit=summary.reduce((s,u)=>s+u.tokens_limit,0);
      return sendJson(res,{users:summary,total_used:totalUsed,total_limit:totalLimit,plans:PLANS,topup_prices:TOKEN_TOPUP_PRICES});
    }catch(e){return sendJson(res,{error:e.message},500);}
  }

  // ── Admin: Security audit log ────────────────────────────────────
  if(route==='/api/admin/security-log'&&req.method==='GET'){
    try{
      const logFile=path.join(DATA,'security.log');
      if(!fs.existsSync(logFile))return sendJson(res,{events:[]});
      const lines=fs.readFileSync(logFile,'utf8').trim().split('\n').filter(Boolean);
      const events=lines.slice(-500).reverse().map(l=>{try{return JSON.parse(l);}catch(e){return null;}}).filter(Boolean);
      // Filter by type if requested
      if(q.type)return sendJson(res,{events:events.filter(e=>e.event===q.type)});
      return sendJson(res,{events,total:lines.length});
    }catch(e){return sendJson(res,{events:[],error:e.message});}
  }

  // ── Admin: Audit trail ──────────────────────────────────────────
  if(route==='/api/admin/audit-log'&&req.method==='GET'){
    try{
      const logFile=path.join(DATA,'audit.log');
      if(!fs.existsSync(logFile))return sendJson(res,{events:[]});
      const lines=fs.readFileSync(logFile,'utf8').trim().split('\n').filter(Boolean);
      const events=lines.slice(-500).reverse().map(l=>{try{return JSON.parse(l);}catch(e){return null;}}).filter(Boolean);
      return sendJson(res,{events,total:lines.length});
    }catch(e){return sendJson(res,{events:[],error:e.message});}
  }

  // ── Admin: Suspend/unsuspend user ──────────────────────────────
  if(route.match(/^\/api\/admin\/users\/[^/]+\/suspend$/)&&req.method==='POST'){
    const uid=route.split('/')[4];
    const u=await DB.updateUser(uid,{status:data.suspend?'suspended':'active'});
    auditLog('admin_user_suspend',{user_id:uid,suspended:!!data.suspend},req);
    return sendJson(res,{user:u});
  }

  // ── Admin: System health ────────────────────────────────────────
  if(route==='/api/admin/system'&&req.method==='GET'){
    const mem=process.memoryUsage();
    const up=process.uptime();
    const diskFiles=['users.json','config.json','audit.log','security.log','mpesa.json','paystack.json','mpesa_transactions.json','paystack_transactions.json'].map(f=>{
      const fp=path.join(DATA,f);
      try{const st=fs.statSync(fp);return{name:f,size:st.size,modified:st.mtime.toISOString()};}
      catch(e){return{name:f,size:0,exists:false};}
    });
    return sendJson(res,{
      uptime_seconds:Math.round(up),uptime_human:Math.floor(up/3600)+'h '+Math.floor((up%3600)/60)+'m',
      memory:{rss:Math.round(mem.rss/1024/1024),heapUsed:Math.round(mem.heapUsed/1024/1024),heapTotal:Math.round(mem.heapTotal/1024/1024)},
      node_version:process.version,platform:os.platform(),hostname:os.hostname(),
      db_connected:dbAvailable,data_dir:DATA,
      files:diskFiles,
      active_terminals:Object.keys(terminals||{}).length,
      active_lsp:Object.keys(lspServers||{}).length,
      rate_limit_entries:rl.size,
      credential_files:diskFiles.filter(f=>['mpesa.json','paystack.json','config.json'].includes(f.name)&&f.size>0).map(f=>f.name)
    });
  }

  // ── Admin: Paystack transactions ──────────────────────────────
  if(route==='/api/admin/paystack-transactions'&&req.method==='GET'){
    try{
      const f=path.join(DATA,'paystack_transactions.json');
      const txns=fs.existsSync(f)?JSON.parse(fs.readFileSync(f,'utf8')):[];
      return sendJson(res,{transactions:txns.slice(-200).reverse(),total:txns.length});
    }catch(e){return sendJson(res,{transactions:[],error:e.message});}
  }

  // ── Admin: Grant bonus tokens to user ──────────────────────────
  if(route.match(/^\/api\/admin\/users\/[^/]+\/tokens$/)&&req.method==='POST'){
    const uid=route.split('/')[4];
    const amount=parseInt(data.tokens)||0;
    if(amount<=0)return sendJson(res,{error:'Invalid token amount'},400);
    // Update in DB
    if(dbPool){await dbPool.query('UPDATE users SET bonus_tokens=COALESCE(bonus_tokens,0)+? WHERE id=?',[amount,uid]).catch(()=>{});}
    // Update in file
    try{
      const ud=JSON.parse(fs.readFileSync(USERS_FILE,'utf8'));
      const u=ud.users?.find(x=>x.id===uid);
      if(u){u.bonus_tokens=(u.bonus_tokens||0)+amount;atomicWriteSync(USERS_FILE,JSON.stringify(ud,null,2),{mode:0o600});}
    }catch(e){}
    auditLog('admin_grant_tokens',{user_id:uid,tokens:amount},req);
    return sendJson(res,{ok:true,tokens_granted:amount});
  }

  // ── Token budget endpoint (for any authenticated user) ─────────
  if(route==='/api/billing/token-budget'&&req.method==='GET'){
    const u=getReqUser(req);
    if(!u)return sendJson(res,{error:'Not authenticated'},401);
    const budget=getTokenBudget(u);
    return sendJson(res,{...budget,topup_prices:TOKEN_TOPUP_PRICES});
  }

  // ── Extra token purchase ──────────────────────────────────────
  if(route==='/api/billing/tokens/buy'&&req.method==='POST'){
    const u=getReqUser(req);
    if(!u)return sendJson(res,{error:'Not authenticated'},401);
    const pkg=TOKEN_TOPUP_PRICES.find(p=>p.tokens===parseInt(data.tokens));
    if(!pkg)return sendJson(res,{error:'Invalid token package'},400);
    // Initialize Paystack transaction for token purchase
    const ps=getPaystackKey();
    if(!ps||!ps.secret_key)return sendJson(res,{error:'Payment not configured'},400);
    const amountKobo=Math.round(pkg.kes*100);
    const payload=JSON.stringify({
      email:u.email,amount:amountKobo,currency:'KES',
      callback_url:data.callback_url||(req.headers.origin||`http://localhost:${PORT}`),
      metadata:JSON.stringify({user_id:u.id,type:'token_topup',tokens:pkg.tokens,user_email:u.email})
    });
    try{
      const result=await new Promise((resolve,reject)=>{
        const r=https.request({hostname:'api.paystack.co',path:'/transaction/initialize',method:'POST',
          headers:{'Authorization':'Bearer '+ps.secret_key,'Content-Type':'application/json','Content-Length':Buffer.byteLength(payload)}
        },(res)=>{let d='';res.on('data',c=>d+=c);res.on('end',()=>{try{resolve(JSON.parse(d));}catch(e){reject(e);}});});
        r.on('error',reject);r.write(payload);r.end();
      });
      if(result.status&&result.data){
        auditLog('token_purchase_init',{email:u.email,tokens:pkg.tokens,amount:pkg.kes},req);
        return sendJson(res,{ok:true,authorization_url:result.data.authorization_url,reference:result.data.reference,tokens:pkg.tokens,price:pkg.kes});
      }
      return sendJson(res,{error:result.message||'Payment initialization failed'},400);
    }catch(e){return sendJson(res,{error:'Payment error: '+e.message},500);}
  }

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
  if(route==='/api/auth/register'&&req.method==='POST'){
    if(!authRateOk(ip)){securityLog('register_rate_limit',{email:data.email},req);return sendJson(res,{error:'Too many attempts. Try again in 5 minutes.'},429);}
    if(!data.email||!data.password||data.password.length<8)return sendJson(res,{error:'Email and password (8+ chars) required'},400);
    // Password strength: require at least one letter and one number
    if(!/[a-zA-Z]/.test(data.password)||!/\d/.test(data.password))return sendJson(res,{error:'Password must contain letters and numbers'},400);
    const r=UsersDB.register(data.name||'User',data.email,data.password,data.plan||'free');
    if(r.error){securityLog('register_fail',{email:data.email,reason:r.error},req);return sendJson(res,r,409);}
    auditLog('user_register',{email:data.email},req);
    return sendJson(res,r);
  }
  if(route==='/api/auth/login'&&req.method==='POST'){
    if(!authRateOk(ip)){securityLog('login_rate_limit',{email:data.email},req);return sendJson(res,{error:'Too many login attempts. Try again in 5 minutes.'},429);}
    if(!data.email||!data.password)return sendJson(res,{error:'Email and password required'},400);
    const r=UsersDB.login(data.email,data.password);
    if(r.error){securityLog('login_fail',{email:data.email,reason:r.error},req);return sendJson(res,r,401);}
    securityLog('login_success',{email:data.email},req);
    return sendJson(res,r);
  }
  if(route==='/api/auth/me'&&req.method==='GET'){
    const tok=req.headers['x-user-token']||q.token;
    const u=tok?UsersDB.getByToken(tok):null;
    if(!u)return sendJson(res,{error:'Not authenticated'},401);
    const trialExpired=isTrialExpired(u);
    const created=new Date(u.created_at);
    const trialEnds=new Date(created.getTime()+FREE_TRIAL_DAYS*24*60*60*1000);
    const budget=getTokenBudget(u);
    return sendJson(res,{user:u,trial_expired:trialExpired,trial_ends:trialEnds.toISOString(),free_trial_days:FREE_TRIAL_DAYS,token_budget:budget});
  }
  if(route==='/api/auth/profile'&&req.method==='PUT'){
    const tok=req.headers['x-user-token'];
    const me=tok?UsersDB.getByToken(tok):null;
    if(!me)return sendJson(res,{error:'Not authenticated'},401);
    const r=UsersDB.updateProfile(me.id,data);
    return sendJson(res,r);
  }
  if(route==='/api/auth/password'&&req.method==='PUT'){
    const tok=req.headers['x-user-token'];
    const me=tok?UsersDB.getByToken(tok):null;
    if(!me)return sendJson(res,{error:'Not authenticated'},401);
    if(!data.currentPassword||!data.newPassword)return sendJson(res,{error:'currentPassword and newPassword required'},400);
    if(data.newPassword.length<8)return sendJson(res,{error:'New password must be 8+ characters'},400);
    if(!/[a-zA-Z]/.test(data.newPassword)||!/\d/.test(data.newPassword))return sendJson(res,{error:'New password must contain letters and numbers'},400);
    const r=UsersDB.updateProfile(me.id,{currentPassword:data.currentPassword,newPassword:data.newPassword});
    if(r.error)return sendJson(res,r,400);
    auditLog('password_change',{id:me.id},req);
    return sendJson(res,{ok:true});
  }
  if(route==='/api/auth/account'&&req.method==='DELETE'){
    const tok=req.headers['x-user-token'];
    const me=tok?UsersDB.getByToken(tok):null;
    if(!me)return sendJson(res,{error:'Not authenticated'},401);
    if(!data.password&&!me.oauth)return sendJson(res,{error:'Password required to delete account'},400);
    if(data.password&&!me.oauth){
      const check=UsersDB.login(me.email,data.password);
      if(check.error)return sendJson(res,{error:'Wrong password'},401);
    }
    const d=UsersDB.load();
    const idx=d.users.findIndex(x=>x.id===me.id);
    if(idx===-1)return sendJson(res,{error:'Not found'},404);
    d.users.splice(idx,1);UsersDB.save(d);
    auditLog('account_delete',{id:me.id,email:me.email},req);
    return sendJson(res,{ok:true});
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
    if(!process.env.GITHUB_CLIENT_ID||!process.env.GITHUB_CLIENT_SECRET){
      const html=`<!DOCTYPE html><html><head><meta charset="utf-8"><title>GitHub OAuth not configured</title>
      <style>body{font-family:system-ui;background:#050a12;color:#e2e8f0;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0}
      .box{max-width:500px;padding:32px;background:rgba(255,255,255,.04);border:1px solid rgba(255,255,255,.08);border-radius:16px;text-align:center}
      h2{color:#22d3ee;margin-top:0}code{background:rgba(34,211,238,.1);color:#22d3ee;padding:2px 8px;border-radius:4px;font-size:13px}
      a{color:#22d3ee}</style></head><body><div class="box">
      <h2>GitHub Login Not Configured</h2>
      <p>To enable GitHub login, add these variables in Railway → Variables:</p>
      <p><code>GITHUB_CLIENT_ID</code> and <code>GITHUB_CLIENT_SECRET</code></p>
      <p style="font-size:12px;color:rgba(255,255,255,.4)">Create an OAuth App at <a href="https://github.com/settings/developers" target="_blank">github.com/settings/developers</a><br>
      Set callback URL to: <code>${req.headers['x-forwarded-proto']||'https'}://${req.headers.host}/api/auth/github/callback</code></p>
      <p><a href="/app">← Back to IDE</a></p></div></body></html>`;
      res.writeHead(501,{'Content-Type':'text/html'});res.end(html);return;
    }
    const state=OAuth.makeState('github');
    const redirect=OAuth.redirectUri('github',req);
    console.log('[OAuth] GitHub redirect_uri:',redirect);
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
    const c={consumer_key:data.consumer_key,consumer_secret:data.consumer_secret,shortcode:data.shortcode||'174379',passkey:data.passkey,callback_url:data.callback_url||(process.env.NODE_ENV==='production'?`https://${req.headers.host}/api/billing/mpesa/callback`:`http://localhost:${PORT}/api/billing/mpesa/callback`),env:data.env||'sandbox',updated:new Date().toISOString()};
    atomicWriteSync(MPESA_FILE,JSON.stringify(c,null,2),{mode:0o600});
    return sendJson(res,{ok:true});
  }
  if(route==='/api/billing/mpesa/stk-push'&&req.method==='POST'){
    let mpCfg;try{mpCfg=JSON.parse(fs.readFileSync(MPESA_FILE,'utf8'));}catch(e){return sendJson(res,{error:'M-Pesa not configured — add credentials via "M-Pesa keys" in billing'},400);}
    if(!mpCfg.consumer_key||!mpCfg.consumer_secret)return sendJson(res,{error:'M-Pesa credentials incomplete — add consumer key and secret'},400);
    const u=getReqUser(req);
    const phone=(data.phone||'').replace(/\s/g,'').replace(/^\+/,'').replace(/^0/,'254');
    if(!/^254\d{9}$/.test(phone))return sendJson(res,{error:'Invalid phone number — use format 0712345678 or 254712345678'},400);
    const plan=data.plan;
    if(!plan||!PLANS[plan]||plan==='free')return sendJson(res,{error:'Invalid plan — choose Starter, Pro, or Team'},400);
    const amount=Math.round(+data.amount||PLANS[plan].kes||0);
    if(amount<1)return sendJson(res,{error:'Invalid amount'},400);
    const baseUrl=mpCfg.env==='production'?'https://api.safaricom.co.ke':'https://sandbox.safaricom.co.ke';
    try{
      const authStr=Buffer.from(mpCfg.consumer_key+':'+mpCfg.consumer_secret).toString('base64');
      const authRes=await new Promise((resolve,reject)=>{
        const r=https.request(baseUrl+'/oauth/v1/generate?grant_type=client_credentials',{method:'GET',headers:{Authorization:'Basic '+authStr}},(resp)=>{let d='';resp.on('data',c=>d+=c);resp.on('end',()=>{try{resolve(JSON.parse(d));}catch(e){reject(e);}});});
        r.on('error',reject);r.end();
      });
      if(!authRes.access_token)return sendJson(res,{error:'M-Pesa auth failed: '+(authRes.errorMessage||JSON.stringify(authRes).slice(0,100))},400);
      const ts=new Date().toISOString().replace(/[^0-9]/g,'').slice(0,14);
      const pw=Buffer.from((mpCfg.shortcode||'174379')+mpCfg.passkey+ts).toString('base64');
      const acctRef='AX-'+plan.slice(0,2).toUpperCase()+'-'+(u?.id||'anon').slice(0,8);
      const stkBody=JSON.stringify({
        BusinessShortCode:mpCfg.shortcode||'174379',Password:pw,Timestamp:ts,
        TransactionType:'CustomerPayBillOnline',Amount:amount,
        PartyA:phone,PartyB:mpCfg.shortcode||'174379',PhoneNumber:phone,
        CallBackURL:mpCfg.callback_url,AccountReference:acctRef,
        TransactionDesc:'AXIOM '+plan.charAt(0).toUpperCase()+plan.slice(1)+' Plan'
      });
      const stkRes=await new Promise((resolve,reject)=>{
        const r=https.request(baseUrl+'/mpesa/stkpush/v1/processrequest',{method:'POST',
          headers:{'Content-Type':'application/json',Authorization:'Bearer '+authRes.access_token,'Content-Length':Buffer.byteLength(stkBody)}},(resp)=>{let d='';resp.on('data',c=>d+=c);resp.on('end',()=>{try{resolve(JSON.parse(d));}catch(e){reject(e);}});});
        r.on('error',reject);r.write(stkBody);r.end();
      });
      if(stkRes.ResponseCode==='0'){
        // Store pending transaction so callback can look up plan + user
        const pendingFile=path.join(DATA,'mpesa_pending.json');
        let pending={};try{pending=JSON.parse(fs.readFileSync(pendingFile,'utf8'));}catch(e){}
        pending[stkRes.CheckoutRequestID]={plan,user_id:u?.id||null,email:u?.email||'',phone,amount,initiated:new Date().toISOString()};
        atomicWriteSync(pendingFile,JSON.stringify(pending,null,2));
        return sendJson(res,{ok:true,checkoutRequestID:stkRes.CheckoutRequestID,message:'STK push sent — check your phone for M-Pesa prompt'});
      }
      return sendJson(res,{error:stkRes.errorMessage||stkRes.ResponseDescription||'STK push failed — check shortcode and passkey'},400);
    }catch(e){return sendJson(res,{error:'M-Pesa request failed: '+e.message},500);}
  }
  if(route==='/api/billing/mpesa/callback'&&req.method==='POST'){
    const cb=data.Body?.stkCallback;
    if(cb){
      const items=cb.CallbackMetadata?.Item||[];
      const txn={CheckoutRequestID:cb.CheckoutRequestID,ResultCode:cb.ResultCode,ResultDesc:cb.ResultDesc};
      items.forEach(i=>{txn[i.Name]=i.Value;});
      // Look up pending transaction to get plan + user
      const pendingFile=path.join(DATA,'mpesa_pending.json');
      let pending={};try{pending=JSON.parse(fs.readFileSync(pendingFile,'utf8'));}catch(e){}
      const pend=pending[cb.CheckoutRequestID]||{};
      const plan=pend.plan||'starter';
      const userId=pend.user_id;
      // Log transaction
      const mpLog=path.join(DATA,'mpesa_transactions.json');
      let txns=[];try{txns=JSON.parse(fs.readFileSync(mpLog,'utf8'));}catch(e){}
      txns.unshift({...txn,plan,user_id:userId||null,received:new Date().toISOString()});
      atomicWriteSync(mpLog,JSON.stringify(txns.slice(0,500),null,2));
      // On success: upgrade user plan
      if(cb.ResultCode===0){
        if(userId){
          const d=UsersDB.load();const u=d.users.find(x=>x.id===userId);
          if(u){u.plan=plan;u.tokens_used_month=0;u.month_reset_at=new Date().toISOString();UsersDB.save(d);}
          if(dbPool)dbPool.query('UPDATE users SET plan=?,tokens_used_month=0,month_reset_at=NOW() WHERE id=?',[plan,userId]).catch(()=>{});
        }
        await DB.recordPayment({user_id:userId||'mpesa',email:pend.email||txn.PhoneNumber||'',name:'M-Pesa',plan,amount:txn.Amount||pend.amount||0,status:'succeeded',type:'mpesa',stripe_id:txn.MpesaReceiptNumber||''});
        // Clean up pending entry
        delete pending[cb.CheckoutRequestID];
        atomicWriteSync(pendingFile,JSON.stringify(pending,null,2));
      }
    }
    return sendJson(res,{ok:true});
  }
  if(route==='/api/billing/mpesa/transactions'&&req.method==='GET'){
    const mpLog=path.join(DATA,'mpesa_transactions.json');
    try{return sendJson(res,{transactions:JSON.parse(fs.readFileSync(mpLog,'utf8'))});}
    catch(e){return sendJson(res,{transactions:[]});}
  }

  // ── Paystack Integration ──────────────────────────────────────
  const PAYSTACK_FILE=path.join(DATA,'paystack.json');
  function getPaystackKey(){try{const c=JSON.parse(fs.readFileSync(PAYSTACK_FILE,'utf8'));return{public_key:c.public_key?decryptCred(c.public_key):'',secret_key:c.secret_key?decryptCred(c.secret_key):''};}catch(e){return null;}}

  // Initialize a Paystack transaction
  if(route==='/api/billing/paystack/initialize'&&req.method==='POST'){
    const ps=getPaystackKey();
    if(!ps||!ps.secret_key)return sendJson(res,{error:'Paystack not configured — add your Paystack secret key in Settings → Paystack keys'},400);
    const u=getReqUser(req);
    if(!u)return sendJson(res,{error:'You must be logged in to make a payment'},401);
    if(!u.email)return sendJson(res,{error:'Account has no email address — please update your profile'},400);
    const plan=data.plan;
    if(!plan||!PLANS[plan]||plan==='free')return sendJson(res,{error:'Invalid plan selected. Choose Starter, Pro, or Team.'},400);
    // Paystack supports: NGN, GHS, USD, ZAR, KES (for East Africa)
    // Use NGN kobo equivalent via USD if KES not accepted, but try KES first (Paystack Africa supports it)
    const amountKobo=Math.round((PLANS[plan].kes||PLANS[plan].price*130)*100);
    const callbackUrl=data.callback_url||(req.headers.origin||`http://localhost:${PORT}`)+'/?paystack_verify=1';
    const payload=JSON.stringify({
      email:u.email,
      amount:amountKobo,
      currency:'KES',
      callback_url:callbackUrl,
      channels:['card','bank','ussd','bank_transfer','mobile_money'],
      metadata:JSON.stringify({user_id:u.id,plan,user_email:u.email,product:'axiom_subscription'})
    });
    try{
      const result=await new Promise((resolve,reject)=>{
        const r=https.request({hostname:'api.paystack.co',path:'/transaction/initialize',method:'POST',
          headers:{'Authorization':'Bearer '+ps.secret_key,'Content-Type':'application/json','Content-Length':Buffer.byteLength(payload)}
        },(resp)=>{let d='';resp.on('data',c=>d+=c);resp.on('end',()=>{try{resolve(JSON.parse(d));}catch(e){reject(e);}});});
        r.on('error',reject);r.write(payload);r.end();
      });
      if(result.status&&result.data){
        auditLog('paystack_init',{email:u.email,plan,ref:result.data.reference,amount:amountKobo/100},req);
        return sendJson(res,{ok:true,authorization_url:result.data.authorization_url,reference:result.data.reference,access_code:result.data.access_code,amount_kobo:amountKobo,amount:amountKobo/100,currency:'KES'});
      }
      // Paystack returned an error — surface its message clearly
      return sendJson(res,{error:result.message||'Paystack initialization failed. Check your secret key and try again.'},400);
    }catch(e){return sendJson(res,{error:'Paystack connection error: '+e.message},500);}
  }

  // Verify a Paystack transaction
  if(route==='/api/billing/paystack/verify'&&req.method==='GET'){
    const ps=getPaystackKey();
    if(!ps||!ps.secret_key)return sendJson(res,{error:'Paystack not configured'},400);
    const ref=q.reference;if(!ref)return sendJson(res,{error:'Missing reference'},400);
    try{
      const result=await new Promise((resolve,reject)=>{
        const r=https.request({hostname:'api.paystack.co',path:'/transaction/verify/'+encodeURIComponent(ref),method:'GET',
          headers:{'Authorization':'Bearer '+ps.secret_key}
        },(res)=>{let d='';res.on('data',c=>d+=c);res.on('end',()=>{try{resolve(JSON.parse(d));}catch(e){reject(e);}});});
        r.on('error',reject);r.end();
      });
      if(result.status&&result.data&&result.data.status==='success'){
        const meta=typeof result.data.metadata==='string'?JSON.parse(result.data.metadata):result.data.metadata||{};
        const userId=meta.user_id;const plan=meta.plan||'pro';
        // Update user plan
        if(userId){
          const d=UsersDB.load();const u=d.users.find(x=>x.id===userId);
          if(u){u.plan=plan;u.last_seen=new Date().toISOString();UsersDB.save(d);}
        }
        auditLog('paystack_success',{ref,plan,user_id:userId,amount:result.data.amount/100},req);
        return sendJson(res,{ok:true,plan,message:'Payment successful! Plan upgraded to '+plan});
      }
      return sendJson(res,{ok:false,status:result.data?.status||'unknown',message:'Payment not yet confirmed'});
    }catch(e){return sendJson(res,{error:'Verification error: '+e.message},500);}
  }

  // Paystack webhook
  if(route==='/api/billing/paystack/webhook'&&req.method==='POST'){
    const ps=getPaystackKey();
    // Verify webhook signature
    if(ps&&ps.secret_key){
      const hash=crypto.createHmac('sha512',ps.secret_key).update(rawBody).digest('hex');
      if(hash!==req.headers['x-paystack-signature']){securityLog('paystack_invalid_sig',{},req);return sendJson(res,{error:'Invalid signature'},401);}
    }
    const event=data.event;const txData=data.data||{};
    if(event==='charge.success'){
      const meta=typeof txData.metadata==='string'?JSON.parse(txData.metadata):txData.metadata||{};
      const userId=meta.user_id;const plan=meta.plan;const txType=meta.type||'subscription';
      if(txType==='token_topup'&&userId){
        // Token top-up purchase — add bonus tokens
        const bonusTokens=parseInt(meta.tokens)||0;
        if(bonusTokens>0){
          if(dbPool){dbPool.query('UPDATE users SET bonus_tokens=COALESCE(bonus_tokens,0)+? WHERE id=?',[bonusTokens,userId]).catch(()=>{});}
          try{const d=UsersDB.load();const u=d.users.find(x=>x.id===userId);if(u){u.bonus_tokens=(u.bonus_tokens||0)+bonusTokens;UsersDB.save(d);}}catch(e){}
          auditLog('token_topup_complete',{user_id:userId,tokens:bonusTokens,amount:txData.amount/100},req);
        }
      } else if(userId&&plan){
        // Plan subscription payment
        const d=UsersDB.load();const u=d.users.find(x=>x.id===userId);
        if(u){u.plan=plan;u.last_seen=new Date().toISOString();u.tokens_used_month=0;u.month_reset_at=new Date().toISOString();UsersDB.save(d);}
        if(dbPool){dbPool.query('UPDATE users SET plan=?,tokens_used_month=0,month_reset_at=NOW() WHERE id=?',[plan,userId]).catch(()=>{});}
        DB.recordPayment({user_id:userId,email:txData.customer?.email,plan,amount:txData.amount/100,status:'succeeded',type:'paystack',stripe_id:txData.reference});
      }
      // Log transaction
      const txLog=path.join(DATA,'paystack_transactions.json');
      let txns=[];try{txns=JSON.parse(fs.readFileSync(txLog,'utf8'));}catch(e){}
      txns.unshift({event,reference:txData.reference,amount:txData.amount/100,currency:txData.currency,email:txData.customer?.email,plan:plan||'',type:txType,tokens:meta.tokens||0,user_id:userId,received:new Date().toISOString()});
      atomicWriteSync(txLog,JSON.stringify(txns.slice(0,500),null,2),{mode:0o600});
      auditLog('paystack_webhook',{event,ref:txData.reference,plan:plan||'',type:txType,user_id:userId},req);
    }
    return sendJson(res,{ok:true});
  }

  // Paystack config (save/get keys) — credentials encrypted at rest
  if(route==='/api/billing/paystack/config'&&req.method==='GET'){
    try{const c=JSON.parse(fs.readFileSync(PAYSTACK_FILE,'utf8'));
      return sendJson(res,{configured:true,public_key:c.public_key?decryptCred(c.public_key):''});}
    catch(e){return sendJson(res,{configured:false});}
  }
  if(route==='/api/billing/paystack/config'&&req.method==='POST'){
    const c={public_key:encryptCred(data.public_key||''),secret_key:encryptCred(data.secret_key||''),updated:new Date().toISOString()};
    atomicWriteSync(PAYSTACK_FILE,JSON.stringify(c,null,2),{mode:0o600});
    auditLog('paystack_config_update',{},req);
    return sendJson(res,{ok:true});
  }

  // ── Database config + health ──────────────────────────────────
  if(route==='/api/db/status'&&req.method==='GET'){
    if(!dbPool)return sendJson(res,{connected:false,error:'No database pool — configure MySQL in Settings'});
    try{
      const conn=await dbPool.getConnection();
      const [[row]]=await conn.query('SELECT VERSION() AS v');
      conn.release();
      dbAvailable=true;dbLastError='';
      const cfg=loadDbConfig();
      return sendJson(res,{connected:true,version:row.v,host:cfg.host,port:cfg.port||3306,database:cfg.database,user:cfg.user});
    }catch(e){dbAvailable=false;dbLastError=e.message;return sendJson(res,{connected:false,error:e.message});}
  }
  if(route==='/api/db/config'&&req.method==='GET'){
    try{
      const c=JSON.parse(fs.readFileSync(DB_CONFIG_FILE,'utf8'));
      return sendJson(res,{configured:true,host:c.host||'',user:c.user||'',database:c.database||'',port:c.port||3306,hasPassword:!!(c.password)});
    }catch(e){
      return sendJson(res,{configured:false,host:process.env.DB_HOST||'localhost',user:process.env.DB_USER||'root',database:process.env.DB_NAME||'axiom',port:+(process.env.DB_PORT||3306),hasPassword:!!(process.env.DB_PASS||DB_PASS)});
    }
  }
  if(route==='/api/db/config'&&req.method==='POST'){
    const{host='localhost',user='root',password='',database='axiom',port=3306}=data;
    if(!host||!user||!database)return sendJson(res,{error:'host, user, and database are required'},400);
    const cfg={host,user,password,database,port:+port||3306,updated:new Date().toISOString()};
    // Test connection before saving
    try{
      const testPool=mysql.createPool({host,user,password,database,port:+port||3306,connectionLimit:1});
      const conn=await testPool.getConnection();
      const[[row]]=await conn.query('SELECT VERSION() AS v');
      conn.release();await testPool.end();
      atomicWriteSync(DB_CONFIG_FILE,JSON.stringify(cfg,null,2),{mode:0o600});
      initDbPool(cfg); // reinit live pool
      auditLog('db_config_update',{host,user,database},req);
      return sendJson(res,{ok:true,version:row.v,message:'Connected to '+database+' on '+host});
    }catch(e){return sendJson(res,{error:'Connection failed: '+e.message},400);}
  }
  if(route==='/api/db/init-schema'&&req.method==='POST'){
    if(!dbPool||!dbAvailable)return sendJson(res,{error:'Database not connected'},503);
    try{await initDbSchema();return sendJson(res,{ok:true,message:'Schema initialized'});}
    catch(e){return sendJson(res,{error:e.message},500);}
  }

  // Collaboration management API
  if(route==='/api/collab/rooms'&&req.method==='GET')return sendJson(res,{rooms:listCollabRooms()});
  if(route==='/api/collab/room'&&req.method==='POST'){
    const roomId=data.roomId||crypto.randomUUID();
    const room=getRoom(roomId);
    room.owner=data.owner||'anonymous';room.file=data.file||null;
    if(data.doc!==undefined)room.doc=data.doc;
    saveCollabSessions();
    return sendJson(res,{roomId,version:room.version,users:room.users.length});
  }

  // Currency conversion (live rates with fallback)
  if(route==='/api/currency'&&req.method==='GET'){
    if(currencyCache&&currencyCache.ts>Date.now()-3600000)return sendJson(res,currencyCache.data);
    const fallback={rates:{KES:130,TZS:2650,UGX:3800,RWF:1300,ETB:57,NGN:1550,GHS:15,ZAR:18},base:'USD',cached:true};
    try{
      const resp=await new Promise((resolve,reject)=>{
        const r=https.get('https://open.er-api.com/v6/latest/USD',{timeout:5000},res=>{let d='';res.on('data',c=>d+=c);res.on('end',()=>resolve(JSON.parse(d)));});
        r.on('error',reject);r.on('timeout',()=>{r.destroy();reject(new Error('timeout'));});
      });
      if(resp.rates){const picked={};['KES','TZS','UGX','RWF','ETB','NGN','GHS','ZAR','EUR','GBP','INR','JPY','CNY'].forEach(c=>{if(resp.rates[c])picked[c]=resp.rates[c];});
      const result={rates:picked,base:'USD',updated:resp.time_last_update_utc||new Date().toISOString()};
      currencyCache={ts:Date.now(),data:result};return sendJson(res,result);}
      return sendJson(res,fallback);
    }catch(e){return sendJson(res,fallback);}
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

  // Git: per-file side-by-side diff (HEAD vs working copy)
  if(route==='/api/git/diff/file'&&req.method==='GET'){
    const dir=safe(q.dir); const fileAbs=safe(q.file);
    if(!dir||!fileAbs)return sendJson(res,{error:'Not allowed'},403);
    const rel=fileAbs.startsWith(dir+'/')?fileAbs.slice(dir.length+1):fileAbs;
    return new Promise(resolve=>{
      exec(`git -C "${dir}" show "HEAD:${sanitizeGitArg(rel)}" 2>/dev/null`,{maxBuffer:8*1024*1024},(err,headOut)=>{
        let working='';
        try{working=fs.readFileSync(fileAbs,'utf8');}catch(e){}
        resolve(sendJson(res,{head:headOut||'',working,file:rel,inHead:!err}));
      });
    });
  }

  // Git blame
  if(route==='/api/git/blame'&&req.method==='POST'){
    const dir=safe(data.dir);const file=safe(data.file);
    if(!dir||!file)return sendJson(res,{error:'Not allowed'},403);
    return new Promise(resolve=>{
      exec(`cd "${dir}" && git blame --porcelain "${sanitizeGitArg(file.replace(dir+'/',''))}" 2>/dev/null`,{maxBuffer:1024*1024},(err,stdout)=>{
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
      exec(`cd "${dir}" && git diff --unified=0 "${sanitizeGitArg(file.replace(dir+'/',''))}" 2>/dev/null`,{maxBuffer:512*1024},(err,stdout)=>{
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
    try{const result={content:[{text:await aiCall(sys,[{role:'user',content:userMsg}],{apiKey,max_tokens:4096})}]};
    let edited=result.content?.[0]?.text||'';
    edited=edited.replace(/^```\w*\n?/,'').replace(/\n?```$/,'');
    return sendJson(res,{edited});}
    catch(e){return sendJson(res,{error:e.message},500);}
  }

  // AI: build context from codebase
  if(route==='/api/ai/context'&&req.method==='POST'){
    const dir=safe(data.dir);if(!dir)return sendJson(res,{error:'No project dir'},400);
    const maxFiles=data.maxFiles||20,maxBytes=data.maxBytes||40000;
    const exts=new Set(['js','ts','jsx','tsx','py','go','rs','java','c','cpp','rb','php','sh','md','json','yaml','yml','toml','env']);
    const files=[];
    (function walk(d,depth){
      if(depth>4||files.length>200)return;
      try{fs.readdirSync(d,{withFileTypes:true}).forEach(e=>{
        if(SKIP.includes(e.name)||e.name.startsWith('.'))return;
        const fp=path.join(d,e.name);
        if(e.isDirectory()){walk(fp,depth+1);return;}
        const ext=path.extname(e.name).slice(1);
        if(!exts.has(ext))return;
        let st;try{st=fs.statSync(fp);}catch(e){return;}
        if(st.size>100000)return;
        files.push({path:fp.replace(dir+'/',''),size:st.size,modified:st.mtimeMs});
      });}catch(e){}
    })(dir,0);
    files.sort((a,b)=>b.modified-a.modified);
    const context=[];let totalBytes=0;
    for(const f of files.slice(0,maxFiles)){
      if(totalBytes>maxBytes)break;
      try{const content=fs.readFileSync(path.join(dir,f.path),'utf8');context.push({file:f.path,content:content.slice(0,2000)});totalBytes+=content.length;}catch(e){}
    }
    return sendJson(res,{context,totalFiles:files.length,includedFiles:context.length});
  }

  // AI: refactor via Claude
  if(route==='/api/ai/refactor'&&req.method==='POST'){
    const apiKey=getKey(data.apiKey);if(!apiKey)return sendJson(res,{error:'No API key'},401);
    const {code='',lang='',instruction='',file=''}=data;
    const sys='You are an expert code refactoring assistant. Refactor the given code based on the instruction. Return ONLY the refactored code, no markdown fences, no explanations.';
    const userMsg=`File: ${file||'untitled'}\nLanguage: ${lang}\nInstruction: ${instruction}\n\nCode:\n${code}`;
    try{
      const refactored2=await aiCall(sys,[{role:'user',content:userMsg}],{apiKey,max_tokens:8192});
      let refactored=refactored2||code;
      refactored=refactored.replace(/^```\w*\n?/,'').replace(/\n?```$/,'');
      return sendJson(res,{refactored});
    }catch(e){return sendJson(res,{error:e.message},500);}
  }

  // AI: analyze code for issues, patterns, improvements
  if(route==='/api/ai/analyze'&&req.method==='POST'){
    const apiKey=getKey(data.apiKey);if(!apiKey)return sendJson(res,{error:'No API key'},401);
    const {code='',lang='',file=''}=data;
    const sys='You are an expert code reviewer. Analyze the given code and return a JSON object with: {"issues": [{"line": number, "severity": "error|warning|info", "message": string}], "summary": string, "suggestions": [string], "complexity": "low|medium|high"}';
    const userMsg=`File: ${file||'untitled'}\nLanguage: ${lang}\n\nCode:\n${code.slice(0,8000)}`;
    try{
      let text=await aiCall(sys,[{role:'user',content:userMsg}],{apiKey,max_tokens:4096})||'{}';
      text=text.replace(/^```\w*\n?/,'').replace(/\n?```$/,'');
      let analysis;try{analysis=JSON.parse(text);}catch(e){analysis={summary:text,issues:[],suggestions:[],complexity:'unknown'};}
      return sendJson(res,analysis);
    }catch(e){return sendJson(res,{error:e.message},500);}
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
    try{
      const result={content:[{text:await aiCall(sys,[{role:'user',content:userMsg}],{apiKey,max_tokens:8192})}]};
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

  // Test coverage
  if(route==='/api/tests/coverage'&&req.method==='POST'){
    const dir=safe(data.dir);if(!dir)return sendJson(res,{error:'Not allowed'},403);
    const lang=data.lang||'';
    let cmd='';
    if(lang==='py'||data.file?.endsWith('.py'))cmd=`cd "${dir}" && python3 -m pytest --cov=. --cov-report=json --cov-report=term -q 2>&1; cat coverage.json 2>/dev/null | head -c 50000 || echo '{}'`;
    else if(lang==='js'||lang==='ts'||lang==='jsx'||lang==='tsx')cmd=`cd "${dir}" && npx jest --coverage --coverageReporters=json-summary --no-cache 2>&1 | tail -100; cat coverage/coverage-summary.json 2>/dev/null || echo '{}'`;
    else if(lang==='go')cmd=`cd "${dir}" && go test -coverprofile=coverage.out ./... 2>&1 && go tool cover -func=coverage.out 2>&1 | tail -20`;
    else cmd=`cd "${dir}" && echo "Coverage not available for language: ${lang}"`;
    return new Promise(resolve=>{
      exec(cmd,{timeout:60000,maxBuffer:2*1024*1024},(err,stdout,stderr)=>{
        const output=(stdout||'')+(stderr?'\n'+stderr:'');
        // Try to parse a coverage percentage from the output
        let pct=null;
        const m=output.match(/(\d+(?:\.\d+)?)\s*%/);if(m)pct=parseFloat(m[1]);
        resolve(sendJson(res,{output:output.slice(0,8000),coverage:pct,exitCode:err?err.code:0}));
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
    const legend={tokenTypes:['namespace','type','class','enum','interface','struct','typeParameter','parameter','variable','property','enumMember','event','function','method','macro','keyword','modifier','comment','string','number','regexp','operator','decorator'],tokenModifiers:['declaration','definition','readonly','static','deprecated','abstract','async']};
    try{
      const result=await lspSend(srv,'textDocument/semanticTokens/full',{textDocument:{uri:fileToUri(filePath)}});
      return sendJson(res,{data:result?.data||[],legend});
    }catch(e){return sendJson(res,{data:[],legend});}
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

  // ══════════════ DEBUGGER ENDPOINTS (Real DAP) ══════════════
  if(route==='/api/debug/start'&&req.method==='POST'){
    const dir=safe(data.dir);const lang=data.lang||'';const file=data.file||'';
    const bps=data.breakpoints||{};  // { filePath: [lineNumbers] }
    if(!dir||!lang||!file)return sendJson(res,{error:'Missing params'},400);
    const result=startDapSession(lang,file,dir);
    if(result.error)return sendJson(res,result,400);
    const sess=debugSessions[result.id];
    if(sess&&bps)sess.breakpoints=bps;
    return sendJson(res,result);
  }
  if(route==='/api/debug/status'&&req.method==='POST'){
    const id=data.id||'';const sess=debugSessions[id];
    if(!sess)return sendJson(res,{error:'No session'});
    // If stopped, auto-fetch stack trace and variables
    let stackFrames=[],vars=[],scopes=[];
    if(sess.state==='stopped'&&sess.stoppedThread){
      try{stackFrames=await dapGetStackTrace(sess,sess.stoppedThread);
        if(stackFrames.length){
          scopes=await dapGetScopes(sess,stackFrames[0].id);
          for(const scope of scopes.slice(0,3)){
            try{const v=await dapGetVariables(sess,scope.variablesReference);
              vars.push({scope:scope.name,variables:v.map(x=>({name:x.name,value:x.value,type:x.type||'',ref:x.variablesReference}))});}catch(e){}
          }
        }
      }catch(e){}
    }
    return sendJson(res,{id,lang:sess.lang,file:sess.file,state:sess.state,
      exited:sess.exited,stoppedThread:sess.stoppedThread,stoppedReason:sess.stoppedReason,
      threads:sess.threads,stackFrames,scopes:vars,
      output:sess.output.slice(-100).map(o=>o.text).join(''),
      capabilities:sess.capabilities});
  }
  if(route==='/api/debug/continue'&&req.method==='POST'){
    const id=data.id||'';const sess=debugSessions[id];
    if(!sess)return sendJson(res,{error:'No session'});
    try{await dapRequest(sess,'continue',{threadId:sess.stoppedThread||1});sess.state='running';return sendJson(res,{ok:true});}
    catch(e){return sendJson(res,{error:e.message});}
  }
  if(route==='/api/debug/step'&&req.method==='POST'){
    const id=data.id||'';const type=data.type||'over';const sess=debugSessions[id];
    if(!sess)return sendJson(res,{error:'No session'});
    const cmd=type==='into'?'stepIn':type==='out'?'stepOut':'next';
    try{await dapRequest(sess,cmd,{threadId:sess.stoppedThread||1});sess.state='running';return sendJson(res,{ok:true});}
    catch(e){return sendJson(res,{error:e.message});}
  }
  if(route==='/api/debug/setBreakpoints'&&req.method==='POST'){
    const id=data.id||'';const sess=debugSessions[id];const file=data.file||'';const lines=data.lines||[];
    if(!sess)return sendJson(res,{error:'No session'});
    sess.breakpoints[file]=lines;
    try{const r=await dapRequest(sess,'setBreakpoints',{source:{path:file},breakpoints:lines.map(l=>({line:l}))});
      return sendJson(res,{breakpoints:r.body?.breakpoints||[]});}
    catch(e){return sendJson(res,{error:e.message});}
  }
  if(route==='/api/debug/evaluate'&&req.method==='POST'){
    const id=data.id||'';const expr=data.expression||'';const frameId=data.frameId;
    const sess=debugSessions[id];
    if(!sess)return sendJson(res,{error:'No session'});
    const result=await dapEvaluate(sess,expr,frameId);
    return sendJson(res,result);
  }
  if(route==='/api/debug/variables'&&req.method==='POST'){
    const id=data.id||'';const ref=data.variablesReference||0;
    const sess=debugSessions[id];
    if(!sess)return sendJson(res,{error:'No session'});
    const vars=await dapGetVariables(sess,ref);
    return sendJson(res,{variables:vars});
  }
  if(route==='/api/debug/stop'&&req.method==='POST'){
    const id=data.id||'';const sess=debugSessions[id];
    if(!sess)return sendJson(res,{error:'No session'});
    try{await dapRequest(sess,'disconnect',{terminateDebuggee:true}).catch(()=>{});}catch(e){}
    try{sess.proc.kill();}catch(e){}
    if(sess.dapSocket)try{sess.dapSocket.destroy();}catch(e){}
    delete debugSessions[id];
    return sendJson(res,{ok:true});
  }
  if(route==='/api/debug/list'&&req.method==='GET'){
    const sessions=Object.entries(debugSessions).map(([id,s])=>({id,lang:s.lang,file:s.file,state:s.state,exited:s.exited}));
    return sendJson(res,{sessions});
  }
  if(route==='/api/debug/stepOver'&&req.method==='POST'){
    const id=data.id||'';const sess=debugSessions[id];
    if(!sess)return sendJson(res,{error:'No session'});
    try{await dapRequest(sess,'next',{threadId:sess.stoppedThread||1});sess.state='running';return sendJson(res,{ok:true});}
    catch(e){return sendJson(res,{error:e.message});}
  }
  if(route==='/api/debug/stepInto'&&req.method==='POST'){
    const id=data.id||'';const sess=debugSessions[id];
    if(!sess)return sendJson(res,{error:'No session'});
    try{await dapRequest(sess,'stepIn',{threadId:sess.stoppedThread||1});sess.state='running';return sendJson(res,{ok:true});}
    catch(e){return sendJson(res,{error:e.message});}
  }
  if(route==='/api/debug/stepOut'&&req.method==='POST'){
    const id=data.id||'';const sess=debugSessions[id];
    if(!sess)return sendJson(res,{error:'No session'});
    try{await dapRequest(sess,'stepOut',{threadId:sess.stoppedThread||1});sess.state='running';return sendJson(res,{ok:true});}
    catch(e){return sendJson(res,{error:e.message});}
  }
  if(route==='/api/debug/pause'&&req.method==='POST'){
    const id=data.id||'';const sess=debugSessions[id];
    if(!sess)return sendJson(res,{error:'No session'});
    try{await dapRequest(sess,'pause',{threadId:sess.stoppedThread||1});sess.state='paused';return sendJson(res,{ok:true});}
    catch(e){return sendJson(res,{error:e.message});}
  }
  if(route==='/api/debug/state'&&req.method==='POST'){
    const id=data.id||'';const sess=debugSessions[id];
    if(!sess)return sendJson(res,{error:'No session'});
    try{
      const threads=await dapRequest(sess,'threads',{});
      let stackFrames=[];
      const tid=sess.stoppedThread||1;
      try{const sf=await dapRequest(sess,'stackTrace',{threadId:tid,startFrame:0,levels:20});stackFrames=sf.body?.stackFrames||[];}catch(e){}
      return sendJson(res,{state:sess.state,threads:threads.body?.threads||[],stackFrames,stoppedThread:tid});
    }catch(e){return sendJson(res,{error:e.message});}
  }
  // Parsed git diff for visual diff editor
  if(route==='/api/git/diff-parsed'&&req.method==='GET'){
    const dir=safe(q.dir||os.homedir());
    if(!dir)return sendJson(res,{error:'Not allowed'},403);
    const file=q.file||'';
    return new Promise(resolve=>{
      const cmd=file?`cd "${dir}" && git diff -- "${file}" 2>/dev/null`:`cd "${dir}" && git diff 2>/dev/null`;
      exec(cmd,{maxBuffer:2*1024*1024},(err,stdout)=>{
        if(!stdout)return resolve(sendJson(res,{hunks:[],files:[]}));
        // Parse unified diff into structured hunks
        const files=[];let curFile=null;
        stdout.split('\n').forEach(line=>{
          if(line.startsWith('diff --git')){
            curFile={path:line.replace(/^diff --git a\/(.+) b\/.*$/,'$1'),hunks:[]};files.push(curFile);
          }else if(line.startsWith('@@')&&curFile){
            const m=line.match(/@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)/);
            curFile.hunks.push({
              oldStart:parseInt(m?.[1]||1),oldCount:parseInt(m?.[2]||1),
              newStart:parseInt(m?.[3]||1),newCount:parseInt(m?.[4]||1),
              header:line,lines:[]
            });
          }else if(curFile&&curFile.hunks.length){
            const hunk=curFile.hunks[curFile.hunks.length-1];
            if(line.startsWith('+'))hunk.lines.push({type:'add',text:line.slice(1)});
            else if(line.startsWith('-'))hunk.lines.push({type:'del',text:line.slice(1)});
            else hunk.lines.push({type:'ctx',text:line.startsWith(' ')?line.slice(1):line});
          }
        });
        resolve(sendJson(res,{files,raw:stdout.slice(0,50000)}));
      });
    });
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

  // Chat history persistence — scoped to authenticated user
  if(route==='/api/chats'&&req.method==='GET'){const u=getReqUser(req);const uid=u?.id||null;const chats=uid?Chats.listForUser(uid):[];return sendJson(res,{chats:chats.map(c=>({id:c.id,title:c.title,lang:c.lang,messageCount:c.messages?.length||0,created:c.created,updated:c.updated}))});}
  if(route==='/api/chats'&&req.method==='POST'){const u=getReqUser(req);const uid=u?.id||null;const chat=Chats.add(data.title||'New Chat',data.messages||[],data.lang||'',uid);return sendJson(res,{chat});}
  if(route.match(/^\/api\/chats\/[^/]+$/)&&req.method==='GET'){const u=getReqUser(req);const uid=u?.id||null;const chat=Chats.get(route.split('/')[3],uid);if(!chat)return sendJson(res,{error:'Not found'},404);return sendJson(res,{chat});}
  if(route.match(/^\/api\/chats\/[^/]+$/)&&req.method==='PUT'){const u=getReqUser(req);const uid=u?.id||null;const chat=Chats.update(route.split('/')[3],data.messages,data.title,uid);if(!chat)return sendJson(res,{error:'Not found'},404);return sendJson(res,{chat});}
  if(route.match(/^\/api\/chats\/[^/]+$/)&&req.method==='DELETE'){const u=getReqUser(req);const uid=u?.id||null;Chats.remove(route.split('/')[3],uid);return sendJson(res,{ok:true});}

  // ── Replace in Files ──────────────────────────────────────────
  if(route==='/api/replace'&&req.method==='POST'){
    const dir=safe(data.dir);if(!dir)return sendJson(res,{error:'Not allowed'},403);
    const pattern=data.pattern||'',replacement=data.replacement||'';
    const useRegex=!!data.regex,caseSensitive=!!data.caseSensitive,dryRun=!!data.dryRun;
    if(!pattern)return sendJson(res,{error:'Pattern required'},400);
    const results=[];let totalReplaced=0;
    function walkReplace(d,depth){if(depth>5||results.length>500)return;try{fs.readdirSync(d,{withFileTypes:true}).forEach(e=>{if(SKIP.includes(e.name)||e.name.startsWith('.'))return;const fp=path.join(d,e.name);if(e.isDirectory()){walkReplace(fp,depth+1);return;}const ext=path.extname(e.name).slice(1);if(!['js','ts','jsx','tsx','py','go','rs','java','c','cpp','h','css','html','json','md','txt','yml','yaml','sh','rb','php'].includes(ext))return;try{const orig=fs.readFileSync(fp,'utf8');let regex;try{regex=useRegex?new RegExp(pattern,caseSensitive?'g':'gi'):new RegExp(pattern.replace(/[.*+?^${}()|[\]\\]/g,'\\$&'),caseSensitive?'g':'gi');}catch(e){return;}const matches=[...orig.matchAll(regex)];if(!matches.length)return;const updated=orig.replace(regex,replacement);const rel=fp.replace(dir+'/','');results.push({file:rel,matches:matches.length,preview:orig.slice(Math.max(0,(matches[0]?.index||0)-40),Math.min(orig.length,(matches[0]?.index||0)+80)).replace(/\n/g,'↵')});totalReplaced+=matches.length;if(!dryRun){fs.writeFileSync(fp,updated);};}catch(e){}});}catch(e){}}
    walkReplace(dir,0);
    auditLog('replace_in_files',{dir,pattern,dryRun,files:results.length},req);
    return sendJson(res,{ok:true,dryRun,results,totalFiles:results.length,totalReplaced});
  }

  // ── GitHub PR Review (gh CLI) ──────────────────────────────────
  if(route==='/api/github/prs'&&req.method==='GET'){
    const dir=safe(q.dir)||os.homedir();
    return new Promise(resolve=>{exec(`cd "${dir}" && gh pr list --json number,title,author,state,updatedAt,headRefName --limit 20 2>&1`,{maxBuffer:512*1024},(err,out)=>{
      if(err||out.startsWith('error')||out.includes('gh: command not found')){return resolve(sendJson(res,{error:out.trim()||'gh CLI not available',prs:[]}));}
      try{const prs=JSON.parse(out);resolve(sendJson(res,{prs}));}catch(e){resolve(sendJson(res,{error:'Parse error',prs:[]}));}
    });});
  }
  if(route==='/api/github/pr/view'&&req.method==='GET'){
    const dir=safe(q.dir)||os.homedir();const num=parseInt(q.number)||0;
    if(!num)return sendJson(res,{error:'PR number required'},400);
    return new Promise(resolve=>{exec(`cd "${dir}" && gh pr view ${num} --json number,title,body,author,state,additions,deletions,files,commits,baseRefName,headRefName 2>&1`,{maxBuffer:1024*1024},(_err,out)=>{
      try{const pr=JSON.parse(out);resolve(sendJson(res,{pr}));}catch(e){resolve(sendJson(res,{error:out.trim()||e.message}));}
    });});
  }
  if(route==='/api/github/pr/checkout'&&req.method==='POST'){
    const dir=safe(data.dir)||os.homedir();const num=parseInt(data.number)||0;
    if(!num)return sendJson(res,{error:'PR number required'},400);
    return new Promise(resolve=>{exec(`cd "${dir}" && gh pr checkout ${num} 2>&1`,{maxBuffer:256*1024},(err,out)=>{resolve(sendJson(res,{ok:!err,output:out.trim()}));});});
  }

  // ── HTTP Proxy for REST Client ─────────────────────────────────
  if(route==='/api/http'&&req.method==='POST'){
    const {url:targetUrl,method:method2='GET',headers:reqHeaders={},body:reqBody=''}=data;
    if(!targetUrl)return sendJson(res,{error:'url required'},400);
    if(isInternalUrl(targetUrl))return sendJson(res,{error:'Internal URLs not allowed'},403);
    const t0=Date.now();
    try{
      const parsed2=new URL(targetUrl);
      const isHttps=parsed2.protocol==='https:';
      const options={hostname:parsed2.hostname,port:parsed2.port||(isHttps?443:80),path:parsed2.pathname+(parsed2.search||''),method:method2.toUpperCase(),headers:{'User-Agent':'AXIOM-REST-Client/1.0',...reqHeaders},timeout:15000};
      const result=await new Promise((resolve,reject)=>{
        const mod=isHttps?https:http;
        const r=mod.request(options,resp=>{let d='';resp.on('data',c=>d+=c);resp.on('end',()=>resolve({status:resp.statusCode,statusText:resp.statusMessage||'',headers:resp.headers,body:d,time:Date.now()-t0}));});
        r.on('error',reject);r.on('timeout',()=>{r.destroy();reject(new Error('Request timed out'));});
        if(reqBody&&['POST','PUT','PATCH'].includes(method2.toUpperCase()))r.write(reqBody);
        r.end();
      });
      return sendJson(res,result);
    }catch(e){return sendJson(res,{error:e.message,time:Date.now()-t0},502);}
  }

  // ── 2FA (TOTP) Routes ──────────────────────────────────────────
  if(route==='/api/2fa/setup'&&req.method==='POST'){
    const u=getReqUser(req);if(!u)return sendJson(res,{error:'Auth required'},401);
    const gen=()=>{const chars='ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';let s='';for(let i=0;i<16;i++)s+=chars[Math.floor(Math.random()*chars.length)];return s;};
    const newSecret=gen();
    const d=UsersDB.load();const usr=d.users.find(x=>x.id===u.id);
    if(!usr)return sendJson(res,{error:'User not found'},404);
    usr.totp_pending=newSecret;UsersDB.save(d);
    const otpUrl='otpauth://totp/AXIOM:'+encodeURIComponent(u.email||usr.email||'user')+'?secret='+newSecret+'&issuer=AXIOM&digits=6&period=30';
    return sendJson(res,{secret:newSecret,otpUrl});
  }
  if(route==='/api/2fa/verify'&&req.method==='POST'){
    const u=getReqUser(req);if(!u)return sendJson(res,{error:'Auth required'},401);
    const token=String(data.token||'').replace(/\s/g,'');
    const d=UsersDB.load();const usr=d.users.find(x=>x.id===u.id);
    if(!usr)return sendJson(res,{error:'User not found'},404);
    const secret=usr.totp_pending||usr.totp_secret;
    if(!secret)return sendJson(res,{error:'No 2FA setup in progress'},400);
    if(!verifyTotp(secret,token))return sendJson(res,{error:'Invalid code'},400);
    usr.totp_secret=secret;delete usr.totp_pending;usr.totp_enabled=true;UsersDB.save(d);
    auditLog('2fa_enabled',{user_id:u.id},req);
    return sendJson(res,{ok:true,message:'2FA enabled'});
  }
  if(route==='/api/2fa/disable'&&req.method==='POST'){
    const u=getReqUser(req);if(!u)return sendJson(res,{error:'Auth required'},401);
    const token=String(data.token||'');
    const d=UsersDB.load();const usr=d.users.find(x=>x.id===u.id);
    if(!usr)return sendJson(res,{error:'User not found'},404);
    if(usr.totp_enabled&&usr.totp_secret&&!verifyTotp(usr.totp_secret,token))return sendJson(res,{error:'Invalid code — enter current TOTP to disable'},400);
    delete usr.totp_secret;delete usr.totp_pending;usr.totp_enabled=false;UsersDB.save(d);
    auditLog('2fa_disabled',{user_id:u.id},req);
    return sendJson(res,{ok:true});
  }
  if(route==='/api/2fa/status'&&req.method==='GET'){
    const u=getReqUser(req);if(!u)return sendJson(res,{error:'Auth required'},401);
    const d=UsersDB.load();const usr=d.users.find(x=>x.id===u.id);
    return sendJson(res,{enabled:!!(usr?.totp_enabled),hasPending:!!(usr?.totp_pending)});
  }

  // ── Merge Conflict Routes ──────────────────────────────────────
  if(route==='/api/git/conflicts'&&req.method==='GET'){
    const dir=safe(q.dir)||os.homedir();
    return new Promise(resolve=>{exec(`cd "${dir}" && git diff --name-only --diff-filter=U 2>&1`,{maxBuffer:256*1024},(err,out)=>{
      const files=(out||'').trim().split('\n').filter(Boolean);
      if(err&&!files.length)return resolve(sendJson(res,{files:[],error:out.trim()}));
      resolve(sendJson(res,{files}));
    });});
  }
  if(route==='/api/git/conflict-resolve'&&req.method==='POST'){
    const dir=safe(data.dir);const file=safe(data.file);const choice=data.choice||'ours';
    if(!dir||!file)return sendJson(res,{error:'dir and file required'},400);
    if(!['ours','theirs','union'].includes(choice))return sendJson(res,{error:'choice must be ours/theirs/union'},400);
    return new Promise(resolve=>{
      exec(`cd "${dir}" && git checkout --${choice==='ours'?'ours':choice==='theirs'?'theirs':'ours'} "${path.basename(file)}" 2>&1`,{maxBuffer:256*1024},(err,out1)=>{
        if(err)return resolve(sendJson(res,{ok:false,output:out1.trim()}));
        exec(`cd "${dir}" && git add "${path.basename(file)}" 2>&1`,{maxBuffer:256*1024},(err2,out2)=>{
          auditLog('conflict_resolve',{file:data.file,choice},req);
          resolve(sendJson(res,{ok:!err2,output:(out1+out2).trim()}));
        });
      });
    });
  }

  // ── Keybindings (per-user, server-backed) ─────────────────────
  const KB_DIR=path.join(DATA,'keybindings');
  if(route==='/api/keybindings'&&req.method==='GET'){
    const u=getReqUser(req);const uid=u?.id||'default';
    try{fs.mkdirSync(KB_DIR,{recursive:true});}catch(e){}
    try{return sendJson(res,{keybindings:JSON.parse(fs.readFileSync(path.join(KB_DIR,uid+'.json'),'utf8'))});}
    catch(e){return sendJson(res,{keybindings:{}});}
  }
  if(route==='/api/keybindings'&&req.method==='POST'){
    const u=getReqUser(req);const uid=u?.id||'default';
    try{fs.mkdirSync(KB_DIR,{recursive:true});}catch(e){}
    atomicWriteSync(path.join(KB_DIR,uid+'.json'),JSON.stringify(data.keybindings||{}));
    return sendJson(res,{ok:true});
  }

  // ── Multi-line ghost completion (Cursor Tab style) ────────────
  if(route==='/api/complete/multiline'&&req.method==='POST'){
    const apiKey=getKey(data.apiKey);if(!apiKey)return sendJson(res,{completion:''});
    const prefix=(data.prefix||'').slice(-600),suffix=(data.suffix||'').slice(0,200);
    const lang=data.lang||'',file=data.file||'';
    if(!prefix.trim())return sendJson(res,{completion:''});
    const sys='You are a code completion engine. Given code context, predict the next 1-5 lines. Return ONLY the code to insert — no explanation, no markdown, no backticks. If uncertain, return an empty string.';
    const msg=`Language: ${lang}\nFile: ${file||'unknown'}\nCode before cursor:\n${prefix}\nCode after cursor:\n${suffix}\n\nCompletion:`;
    try{
      let completion=await aiCall(sys,[{role:'user',content:msg}],{apiKey,max_tokens:150});
      completion=completion.replace(/^```\w*\n?/,'').replace(/\n?```$/,'');
      return sendJson(res,{completion});
    }catch(e){return sendJson(res,{completion:''});}
  }

  // ── Codebase indexing (TF-IDF) ────────────────────────────────
  const codebaseIndexes=global._axiomCbIdx=global._axiomCbIdx||new Map();
  if(route==='/api/codebase/index'&&req.method==='POST'){
    const dir=safe(data.dir);if(!dir)return sendJson(res,{error:'Not allowed'},403);
    const docs={};
    (function walk(d,depth){if(depth>5||Object.keys(docs).length>500)return;try{fs.readdirSync(d,{withFileTypes:true}).forEach(e=>{if(SKIP.includes(e.name)||e.name.startsWith('.'))return;const fp=path.join(d,e.name);if(e.isDirectory()){walk(fp,depth+1);return;}const ext=path.extname(e.name).slice(1);if(!['js','ts','jsx','tsx','py','go','rs','java','c','cpp','h','css','html','json','md','rb','php','sh'].includes(ext))return;let st;try{st=fs.statSync(fp);}catch(e){return;}if(st.size>200000)return;const rel=fp.replace(dir+'/','');try{docs[rel]=fs.readFileSync(fp,'utf8');}catch(e){}});}catch(e){}})(dir,0);
    function tokenize(text){return text.toLowerCase().replace(/[^\w\s]/g,' ').split(/\s+/).filter(t=>t.length>2&&!/^\d+$/.test(t));}
    const N=Math.max(Object.keys(docs).length,1);const df={};
    Object.values(docs).forEach(c=>{new Set(tokenize(c)).forEach(t=>{df[t]=(df[t]||0)+1;});});
    const idx={};
    Object.entries(docs).forEach(([file,content])=>{const tokens=tokenize(content+' '+path.basename(file));const tf={};tokens.forEach(t=>{tf[t]=(tf[t]||0)+1;});const top=Object.entries(tf).sort((a,b)=>b[1]-a[1]).slice(0,60).map(([t,c])=>({t,score:c*Math.log(N/(df[t]||1))})).filter(x=>x.score>0);idx[file]={tokens:top,preview:content.slice(0,300)};});
    codebaseIndexes.set(dir,{idx,ts:Date.now(),count:Object.keys(docs).length});
    return sendJson(res,{ok:true,files:Object.keys(docs).length});
  }
  if(route==='/api/codebase/search'&&req.method==='POST'){
    const dir=safe(data.dir);if(!dir)return sendJson(res,{error:'Not allowed'},403);
    const query=data.query||'';const ci=codebaseIndexes.get(dir);
    if(!ci)return sendJson(res,{results:[],indexed:false});
    function tokenize2(text){return text.toLowerCase().replace(/[^\w\s]/g,' ').split(/\s+/).filter(t=>t.length>2);}
    const qT=new Set(tokenize2(query));
    const results=Object.entries(ci.idx).map(([file,{tokens,preview}])=>{let score=0;tokens.forEach(({t,score:s})=>{if(qT.has(t))score+=s;});return{file,score,preview};}).filter(x=>x.score>0).sort((a,b)=>b.score-a.score).slice(0,10);
    return sendJson(res,{results,indexed:true,lastIndexed:new Date(ci.ts).toISOString()});
  }

  // ── @-mention context expansion ───────────────────────────────
  if(route==='/api/context/expand'&&req.method==='POST'){
    const dir=safe(data.dir)||os.homedir();const mentions=data.mentions||[];const openFiles=data.openFiles||[];
    const pieces=[];
    for(const m of mentions){
      try{
        if(m.type==='file'&&m.path){const s=safe(m.path);if(s&&fs.existsSync(s)){const c=fs.readFileSync(s,'utf8').slice(0,4000);pieces.push('@file:'+path.basename(m.path)+'\n```\n'+c+'\n```');}}
        else if(m.type==='folder'&&m.path){const s=safe(m.path);if(s){const ents=listDir(s).slice(0,30);pieces.push('@folder:'+path.basename(m.path)+'\n'+ents.map(e=>(e.type==='dir'?'📁 ':'📄 ')+e.name).join('\n'));}}
        else if(m.type==='git'){const r=await git(dir,'diff','HEAD','--stat');pieces.push('@git:diff-stat\n'+(r.out||'No uncommitted changes'));}
        else if(m.type==='open-files'){for(const f of openFiles.slice(0,5)){const s=safe(f.path);if(s&&fs.existsSync(s)){const c=fs.readFileSync(s,'utf8').slice(0,2000);pieces.push('@open:'+f.name+'\n```\n'+c+'\n```');}}}
        else if(m.type==='codebase'){
          const ci=codebaseIndexes.get(dir);
          if(ci&&m.query){function tkn(t){return t.toLowerCase().replace(/[^\w\s]/g,' ').split(/\s+/).filter(x=>x.length>2);}
            const qt=new Set(tkn(m.query));const top=Object.entries(ci.idx).map(([file,{tokens,preview}])=>{let s=0;tokens.forEach(({t,score})=>{if(qt.has(t))s+=score;});return{file,s,preview};}).filter(x=>x.s>0).sort((a,b)=>b.s-a.s).slice(0,3);
            for(const r of top){const fp=safe(dir+'/'+r.file);if(fp&&fs.existsSync(fp)){try{pieces.push('@codebase:'+r.file+'\n```\n'+fs.readFileSync(fp,'utf8').slice(0,2000)+'\n```');}catch(e){}}}
          }
        }
        else if(m.type==='rules'){for(const n of['.axiomrules','.cursorrules','AGENTS.md','CLAUDE.md']){const fp=path.join(dir,n);if(fs.existsSync(fp)){pieces.push('@rules:'+n+'\n'+fs.readFileSync(fp,'utf8').slice(0,3000));break;}}}
        else if(m.type==='web'&&m.content){pieces.push('@web:'+m.query+'\n'+m.content);}
      }catch(e){}
    }
    return sendJson(res,{context:pieces.join('\n\n---\n\n'),pieces});
  }

  // ── Composer: multi-file edit proposal ────────────────────────
  if(route==='/api/composer'&&req.method==='POST'){
    const apiKey=getKey(data.apiKey);if(!apiKey)return sendJson(res,{error:'No API key'},401);
    const dir=safe(data.dir);if(!dir)return sendJson(res,{error:'No project open'},400);
    const instruction=data.instruction||'',fileContext=data.fileContext||'',extraContext=data.extraContext||'',rules=data.rules||'';
    const sys=`You are AXIOM Composer, an AI that proposes multi-file code edits.${rules?'\n\nProject rules:\n'+rules:''}\nRespond with ONLY a JSON object:\n{"summary":"brief description","files":[{"path":"rel/path","action":"edit|create|delete","content":"full file content","explanation":"what changed"}]}`;
    const msg=`Project: ${dir}\n${extraContext?extraContext+'\n':''}${fileContext?'Current file:\n'+fileContext.slice(0,3000)+'\n':''}Instruction: ${instruction}`;
    try{
      const result={content:[{text:await aiCall(sys,[{role:'user',content:msg}],{apiKey,max_tokens:8192})}]};
      let text=result.content?.[0]?.text||'{}';text=text.replace(/^```\w*\n?/,'').replace(/\n?```$/,'');
      let proposal;try{proposal=JSON.parse(text);}catch(e){return sendJson(res,{error:'AI returned invalid JSON',raw:text.slice(0,500)});}
      for(const f of(proposal.files||[])){if(f.action==='edit'){try{const fp=path.resolve(dir,f.path);if(fp.startsWith(dir))f.original=fs.readFileSync(fp,'utf8').slice(0,5000);}catch(e){f.original='';}}};
      auditLog('composer_propose',{dir,files:(proposal.files||[]).length},req);
      return sendJson(res,{ok:true,proposal});
    }catch(e){return sendJson(res,{error:e.message},500);}
  }
  if(route==='/api/composer/apply'&&req.method==='POST'){
    const dir=safe(data.dir);if(!dir)return sendJson(res,{error:'Not allowed'},403);
    const applied=[];
    for(const f of(data.files||[]).slice(0,30)){
      try{const fp=path.resolve(dir,f.path);if(!fp.startsWith(dir)){applied.push({path:f.path,status:'denied'});continue;}
        if(f.action==='delete'){fs.unlinkSync(fp);applied.push({path:f.path,status:'deleted'});}
        else{fs.mkdirSync(path.dirname(fp),{recursive:true});fs.writeFileSync(fp,f.content||'');applied.push({path:f.path,status:'applied'});}
      }catch(e){applied.push({path:f.path,status:'error',error:e.message});}
    }
    auditLog('composer_apply',{dir,count:applied.length},req);
    return sendJson(res,{ok:true,applied});
  }

  // ── Bug Finder (AI diff review) ───────────────────────────────
  if(route==='/api/bug-finder'&&req.method==='POST'){
    const apiKey=getKey(data.apiKey);if(!apiKey)return sendJson(res,{error:'No API key'},401);
    const dir=safe(data.dir)||os.homedir();
    return new Promise(resolve=>{
      exec(`cd "${dir}" && git diff HEAD 2>&1`,{maxBuffer:2*1024*1024},(_err,diff)=>{
        if(!diff||diff.length<10)return resolve(sendJson(res,{issues:[],message:'No uncommitted changes to review'}));
        const sys='You are a code reviewer. Analyze this git diff for bugs, security issues, and code quality problems. Return ONLY a JSON array: [{"severity":"error|warning|info","file":"path","line":42,"title":"Issue title","description":"Details","fix":"Suggested fix"}]. Focus on real bugs, not style nitpicks.';
        aiCall(sys,[{role:'user',content:'Review this diff:\n\n'+diff.slice(0,12000)}],{apiKey,max_tokens:4096}).then(text=>{
          text=text.replace(/^```\w*\n?/,'').replace(/\n?```$/,'');let issues;try{issues=JSON.parse(text);}catch(e){issues=[];}
          resolve(sendJson(res,{issues,diffSize:diff.length}));
        }).catch(e=>resolve(sendJson(res,{issues:[],error:e.message})));
      });
    });
  }

  // ── Web search (DuckDuckGo HTML scrape) ───────────────────────
  if(route==='/api/web/search'&&req.method==='POST'){
    const q2=encodeURIComponent(data.query||'');if(!q2)return sendJson(res,{results:[]});
    try{
      const html=await new Promise((resolve,reject)=>{
        const r=https.get({hostname:'html.duckduckgo.com',path:'/html/?q='+q2,headers:{'User-Agent':'Mozilla/5.0 (compatible; AXIOM-IDE/1.0)','Accept':'text/html','Accept-Language':'en-US,en;q=0.9'},timeout:8000},resp=>{let d='';resp.on('data',c=>d+=c);resp.on('end',()=>resolve(d));});
        r.on('error',reject);r.on('timeout',()=>{r.destroy();reject(new Error('timeout'));});
      });
      const results=[];
      const titleRe=/<a[^>]+class="result__a"[^>]*href="([^"]+)"[^>]*>([^<]+)<\/a>/g;
      const snippetRe=/<a[^>]+class="result__snippet"[^>]*>([^<]*)<\/a>/g;
      const snips=[];let sm;while((sm=snippetRe.exec(html))!==null)snips.push(sm[1].replace(/&#x27;/g,"'").replace(/&amp;/g,'&').trim());
      let tm;let si=0;
      while((tm=titleRe.exec(html))!==null&&results.length<8){
        let url=tm[1];if(url.startsWith('//'))url='https:'+url;if(url.startsWith('/l/?'))continue;
        const title=tm[2].replace(/&amp;/g,'&').replace(/&lt;/g,'<').replace(/&gt;/g,'>').trim();
        results.push({url,title,snippet:snips[si++]||''});
      }
      return sendJson(res,{results,query:data.query});
    }catch(e){return sendJson(res,{results:[],error:e.message});}
  }

  // ── Per-hunk staging ─────────────────────────────────────────
  if(route==='/api/git/hunks'&&req.method==='GET'){
    const dir=safe(q.dir)||os.homedir();const file=q.file||'';
    const cmd=file?`cd "${dir}" && git diff --no-color -- "${sanitizeGitArg(file)}" 2>&1`:`cd "${dir}" && git diff --no-color 2>&1`;
    return new Promise(resolve=>{exec(cmd,{maxBuffer:2*1024*1024},(_e,out)=>{
      const hunks=[];let cur=null,fileHdr='';
      for(const line of(out||'').split('\n')){
        if(line.startsWith('diff --git')){if(cur)hunks.push(cur);cur=null;fileHdr=line;}
        else if(line.startsWith('--- ')||line.startsWith('+++ ')){fileHdr+='\n'+line;}
        else if(line.startsWith('@@')){
          if(cur)hunks.push(cur);
          const m=line.match(/@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)/);
          cur={file:fileHdr.split('\n')[0].replace('diff --git a/','').split(' ')[0],header:fileHdr,oldLine:+(m?.[1]||0),newLine:+(m?.[2]||0),context:(m?.[3]||'').trim(),lines:[line],patch:fileHdr+'\n'+line};
        }
        else if(cur){cur.lines.push(line);cur.patch+='\n'+line;}
      }
      if(cur)hunks.push(cur);
      resolve(sendJson(res,{hunks:hunks.slice(0,50)}));
    });});
  }
  if(route==='/api/git/stage-hunk'&&req.method==='POST'){
    const dir=safe(data.dir);if(!dir)return sendJson(res,{error:'Not allowed'},403);
    const patch=data.patch||'';if(!patch)return sendJson(res,{error:'No patch'},400);
    return new Promise(resolve=>{
      const tmp=path.join(os.tmpdir(),'ax_hunk_'+Date.now()+'.patch');
      fs.writeFileSync(tmp,patch+'\n');
      exec(`cd "${dir}" && git apply --cached "${tmp}" 2>&1`,{maxBuffer:256*1024},(err,out)=>{
        try{fs.unlinkSync(tmp);}catch(e){}resolve(sendJson(res,{ok:!err,output:(out||'').trim()}));
      });
    });
  }

  // ── AI Refactor ───────────────────────────────────────────────
  if(route==='/api/refactor'&&req.method==='POST'){
    const apiKey=getKey(data.apiKey);if(!apiKey)return sendJson(res,{error:'No API key'},401);
    const {action='',code='',lang='',selection=''}=data;
    const prompts={
      extract_function:'Extract the selected code into a well-named function. Return JSON: {"refactored":"full new file content","functionName":"name","explanation":"what changed"}',
      extract_variable:'Extract the selected expression into a named constant. Return JSON: {"refactored":"full new file content","variableName":"name"}',
      inline:'Inline the selected variable/function where it is used. Return JSON: {"refactored":"full new file content","explanation":"what changed"}',
      organize_imports:'Group, sort, and deduplicate imports. Return JSON: {"refactored":"full new file content"}',
      async_convert:'Convert to async/await if using callbacks/promises, or vice-versa. Return JSON: {"refactored":"full new file content","explanation":"what changed"}',
    };
    const sys='You are a code refactoring engine. '+(prompts[action]||'Improve the code. Return JSON: {"refactored":"full new file content","explanation":"what changed"}');
    const msg=`Language: ${lang}\nFull file:\n${code}\n${selection?'\nSelected code:\n'+selection:''}`;
    try{
      const result={content:[{text:await aiCall(sys,[{role:'user',content:msg}],{apiKey,max_tokens:8192})}]};
      let text=result.content?.[0]?.text||'{}';text=text.replace(/^```\w*\n?/,'').replace(/\n?```$/,'');
      let out2;try{out2=JSON.parse(text);}catch(e){out2={refactored:text};}
      return sendJson(res,out2);
    }catch(e){return sendJson(res,{error:e.message},500);}
  }

  // Refactor sub-routes — delegate to the main /api/refactor handler logic
  if(route==='/api/refactor/extract'&&req.method==='POST'){
    const apiKey=getKey(data.apiKey);if(!apiKey)return sendJson(res,{error:'No API key'},401);
    const {code='',lang='',selection=''}=data;
    const sys='You are a code refactoring engine. Extract the selected code into a well-named function. Return JSON: {"refactored":"full new file content","functionName":"extracted function name","explanation":"brief description"}';
    const msg=`Language: ${lang}\nFull file:\n${code}\nSelected code to extract:\n${selection}`;
    try{let text=await aiCall(sys,[{role:'user',content:msg}],{apiKey,max_tokens:4096});
    text=text.replace(/^```\w*\n?/,'').replace(/\n?```$/,'');
    let out;try{out=JSON.parse(text);}catch(e){out={refactored:text};}return sendJson(res,out);}
    catch(e){return sendJson(res,{error:e.message},500);}
  }
  if(route==='/api/refactor/rename'&&req.method==='POST'){
    const apiKey=getKey(data.apiKey);if(!apiKey)return sendJson(res,{error:'No API key'},401);
    const {code='',oldName='',newName=''}=data;
    if(!oldName||!newName)return sendJson(res,{error:'oldName and newName required'},400);
    // Simple text-level rename — replace all occurrences of the symbol
    const escaped=oldName.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
    const re=new RegExp(`\\b${escaped}\\b`,'g');
    const refactored=code.replace(re,newName);
    const count=(code.match(re)||[]).length;
    return sendJson(res,{refactored,renamedCount:count,oldName,newName});
  }
  if(route==='/api/refactor/cleanup'&&req.method==='POST'){
    const apiKey=getKey(data.apiKey);if(!apiKey)return sendJson(res,{error:'No API key'},401);
    const {code='',lang=''}=data;
    const sys='You are a code cleanup engine. Remove dead code, fix formatting, organize imports, remove unused variables. Return JSON: {"refactored":"full cleaned file content","changes":["list of changes made"]}';
    const msg=`Language: ${lang}\nCode to clean:\n${code}`;
    try{let text=await aiCall(sys,[{role:'user',content:msg}],{apiKey,max_tokens:4096});
    text=text.replace(/^```\w*\n?/,'').replace(/\n?```$/,'');
    let out;try{out=JSON.parse(text);}catch(e){out={refactored:text,changes:[]};}return sendJson(res,out);}
    catch(e){return sendJson(res,{error:e.message},500);}
  }

  // ── Database (MySQL) ───────────────────────────────────────────
  const DB_CONNS_FILE=path.join(DATA,'db_connections.json');
  const loadDbConns=()=>{try{return JSON.parse(fs.readFileSync(DB_CONNS_FILE,'utf8'));}catch(e){return[];}};
  const saveDbConns=(c)=>{atomicWriteSync(DB_CONNS_FILE,JSON.stringify(c));};
  if(route==='/api/db/connections'&&req.method==='GET'){
    return sendJson(res,{connections:loadDbConns().map(c=>({...c,password:undefined}))});
  }
  if(route==='/api/db/connections'&&req.method==='POST'){
    const {name='',type='mysql',host='localhost',port,user='root',password='',database=''}=data;
    if(!name||!host||!user)return sendJson(res,{error:'name, host and user required'},400);
    const defaultPort=type==='postgresql'?5432:type==='sqlite'?0:3306;
    const connPort=+(port||defaultPort);
    let conn;
    try{
      if(type==='sqlite'){
        // SQLite: just test the file path exists — no network connection needed
        if(!database)return sendJson(res,{error:'SQLite requires a database file path'},400);
        try{fs.accessSync(database);}catch(e){
          // If file doesn't exist, check we can write to parent dir
          try{fs.accessSync(path.dirname(database),fs.constants.W_OK);}catch(e2){
            return sendJson(res,{error:'SQLite file not found and directory not writable: '+database},400);
          }
        }
      }else if(type==='postgresql'){
        // Try pg module, fall back to a clear message if not installed
        let pg;try{pg=require('pg');}catch(e){
          // pg not installed — save anyway with a warning
          const id=crypto.randomUUID();
          const conns=loadDbConns();const existing=conns.findIndex(c=>c.id===data.id);
          const record={id:data.id||id,name,type,host,port:connPort,user,password,database,created:new Date().toISOString()};
          if(existing>=0)conns[existing]=record;else conns.push(record);
          saveDbConns(conns);
          return sendJson(res,{ok:true,id:record.id,message:'Saved (pg module not installed — run: npm install pg to enable live connections)',warning:true});
        }
        const client=new pg.Client({host,port:connPort,user,password,database:database||undefined,connectionTimeoutMillis:5000});
        try{await client.connect();await client.query('SELECT 1');}finally{try{await client.end();}catch(e){}}
      }else{
        // MySQL (default)
        let mysql2;try{mysql2=require('mysql2/promise');}catch(e){return sendJson(res,{error:'mysql2 not installed. Run: npm install mysql2'},500);}
        conn=await mysql2.createConnection({host,port:connPort,user,password,database:database||undefined,connectTimeout:5000});
        await conn.ping();
      }
      const id=crypto.randomUUID();
      const conns=loadDbConns();const existing=conns.findIndex(c=>c.id===data.id);
      const record={id:data.id||id,name,type,host,port:connPort,user,password,database,created:new Date().toISOString()};
      if(existing>=0)conns[existing]=record;else conns.push(record);
      saveDbConns(conns);
      return sendJson(res,{ok:true,id:record.id,message:'Connected successfully'});
    }catch(e){return sendJson(res,{error:'Connection failed: '+e.message},400);}
    finally{if(conn)try{await conn.end();}catch(e){}}
  }
  if(route.match(/^\/api\/db\/connections\/[^/]+$/)&&req.method==='DELETE'){
    const cid=route.split('/')[4];
    saveDbConns(loadDbConns().filter(c=>c.id!==cid));
    return sendJson(res,{ok:true});
  }
  if(route==='/api/db/query'&&req.method==='POST'){
    const {connectionId='',sql='',query='',limit=500}=data;
    const safeSql=(sql||query).trim();
    if(!safeSql)return sendJson(res,{error:'sql required'},400);
    const conns=loadDbConns();const cfg=conns.find(c=>c.id===connectionId);
    if(!cfg)return sendJson(res,{error:'Connection not found'},404);
    const firstWord=safeSql.split(/\s+/)[0].toUpperCase();
    const safeOps=new Set(['SELECT','SHOW','DESCRIBE','DESC','EXPLAIN','WITH','PRAGMA']);
    if(!safeOps.has(firstWord)&&!data.allowWrite)return sendJson(res,{error:'Only SELECT/SHOW/DESCRIBE/EXPLAIN allowed. Pass allowWrite:true to run write queries.'},403);
    let conn;
    try{
      if(cfg.type==='postgresql'){
        let pg;try{pg=require('pg');}catch(e){return sendJson(res,{error:'pg not installed. Run: npm install pg'},500);}
        const client=new pg.Client({host:cfg.host,port:+cfg.port,user:cfg.user,password:cfg.password,database:cfg.database||undefined,connectionTimeoutMillis:8000});
        await client.connect();
        try{
          const result=await client.query(safeSql);
          const columns=(result.fields||[]).map(f=>({name:f.name,type:f.dataTypeID}));
          const limited=(result.rows||[]).slice(0,+limit);
          return sendJson(res,{rows:limited,columns,rowCount:result.rowCount||result.rows?.length||0,truncated:(result.rows?.length||0)>+limit});
        }finally{try{await client.end();}catch(e){}}
      }else if(cfg.type==='sqlite'){
        let sqlite3;try{sqlite3=require('better-sqlite3');}catch(e){return sendJson(res,{error:'better-sqlite3 not installed. Run: npm install better-sqlite3'},500);}
        const db=new sqlite3(cfg.database,{readonly:!data.allowWrite});
        try{
          const stmt=db.prepare(safeSql);
          const rows=stmt.all();const limited=rows.slice(0,+limit);
          const columns=limited.length>0?Object.keys(limited[0]).map(n=>({name:n,type:'text'})):[];
          return sendJson(res,{rows:limited,columns,rowCount:rows.length,truncated:rows.length>+limit});
        }finally{try{db.close();}catch(e){}}
      }else{
        // MySQL (default)
        let mysql2;try{mysql2=require('mysql2/promise');}catch(e){return sendJson(res,{error:'mysql2 not installed'},500);}
        conn=await mysql2.createConnection({host:cfg.host,port:+cfg.port,user:cfg.user,password:cfg.password,database:cfg.database||undefined,connectTimeout:8000});
        const [rows,fields]=await conn.execute(safeSql);
        const columns=(fields||[]).map(f=>({name:f.name,type:f.type}));
        const limited=Array.isArray(rows)?rows.slice(0,+limit):rows;
        return sendJson(res,{rows:limited,columns,rowCount:Array.isArray(rows)?rows.length:0,truncated:Array.isArray(rows)&&rows.length>+limit});
      }
    }catch(e){return sendJson(res,{error:e.message},400);}
    finally{if(conn)try{await conn.end();}catch(e){}}
  }
  if(route==='/api/db/tables'&&req.method==='POST'){
    const {connectionId=''}=data;
    const conns=loadDbConns();const cfg=conns.find(c=>c.id===connectionId);
    if(!cfg)return sendJson(res,{error:'Connection not found'},404);
    let mysql2;try{mysql2=require('mysql2/promise');}catch(e){return sendJson(res,{error:'mysql2 not installed'},500);}
    let conn;
    try{
      conn=await mysql2.createConnection({host:cfg.host,port:+cfg.port,user:cfg.user,password:cfg.password,database:cfg.database||undefined,connectTimeout:5000});
      const [tables]=await conn.execute(`SELECT TABLE_NAME as name, TABLE_ROWS as rows, TABLE_TYPE as type FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() ORDER BY TABLE_NAME`);
      return sendJson(res,{tables:tables||[]});
    }catch(e){return sendJson(res,{error:e.message},400);}
    finally{if(conn)try{await conn.end();}catch(e){}}
  }

  // ── Workspaces ─────────────────────────────────────────────────
  const WS_FILE=path.join(DATA,'workspaces.json');
  const loadWS=()=>{try{return JSON.parse(fs.readFileSync(WS_FILE,'utf8'));}catch(e){return[];}};
  const saveWS=(w)=>{atomicWriteSync(WS_FILE,JSON.stringify(w));};
  if(route==='/api/workspaces'&&req.method==='GET'){
    return sendJson(res,{workspaces:loadWS()});
  }
  if(route==='/api/workspaces'&&req.method==='POST'){
    const{name='',folders=[],settings={}}=data;
    if(!name)return sendJson(res,{error:'name required'},400);
    const ws=loadWS();
    const existing=ws.findIndex(w=>w.id===data.id);
    const record={id:data.id||crypto.randomUUID(),name,folders,settings,updated:new Date().toISOString()};
    if(existing>=0)ws[existing]=record;else ws.unshift(record);
    saveWS(ws);return sendJson(res,{ok:true,workspace:record});
  }
  if(route.match(/^\/api\/workspaces\/[^/]+$/)&&req.method==='DELETE'){
    const wid=route.split('/')[3];saveWS(loadWS().filter(w=>w.id!==wid));return sendJson(res,{ok:true});
  }

  // ── Terminal Profiles ──────────────────────────────────────────
  const TP_FILE=path.join(DATA,'terminal_profiles.json');
  const DEFAULT_PROFILES=[
    {id:'default',name:'Default',shell:process.env.SHELL||'/bin/bash',args:[],env:{},cwd:'~',icon:'🖥',isDefault:true},
    {id:'zsh',name:'Zsh',shell:'/bin/zsh',args:[],env:{},cwd:'~',icon:'⚡'},
    {id:'fish',name:'Fish',shell:'/usr/bin/fish',args:[],env:{},cwd:'~',icon:'🐟'},
  ];
  const loadTP=()=>{try{return JSON.parse(fs.readFileSync(TP_FILE,'utf8'));}catch(e){return DEFAULT_PROFILES;}};
  const saveTP=(p)=>{atomicWriteSync(TP_FILE,JSON.stringify(p));};
  if(route==='/api/terminal/profiles'&&req.method==='GET'){
    return sendJson(res,{profiles:loadTP()});
  }
  if(route==='/api/terminal/profiles'&&req.method==='POST'){
    const{name='',shell='',args=[],env={},cwd='~',icon='🖥',isDefault=false}=data;
    if(!name||!shell)return sendJson(res,{error:'name and shell required'},400);
    const profiles=loadTP();
    if(isDefault)profiles.forEach(p=>p.isDefault=false);
    const existing=profiles.findIndex(p=>p.id===data.id);
    const record={id:data.id||crypto.randomUUID(),name,shell,args,env,cwd,icon,isDefault};
    if(existing>=0)profiles[existing]=record;else profiles.push(record);
    saveTP(profiles);return sendJson(res,{ok:true,profile:record});
  }
  if(route.match(/^\/api\/terminal\/profiles\/[^/]+$/)&&req.method==='DELETE'){
    const pid2=route.split('/')[4];
    saveTP(loadTP().filter(p=>p.id!==pid2));return sendJson(res,{ok:true});
  }

  // ── Notepads ──────────────────────────────────────────────────
  const NOTEPADS_FILE=path.join(DATA,'notepads.json');
  const loadNotepads=()=>{try{return JSON.parse(fs.readFileSync(NOTEPADS_FILE,'utf8'));}catch(e){return[];}};
  const saveNotepads=(np)=>{atomicWriteSync(NOTEPADS_FILE,JSON.stringify(np));};
  if(route==='/api/notepads'&&req.method==='GET')return sendJson(res,{notepads:loadNotepads()});
  if(route==='/api/notepads'&&req.method==='POST'){const np=loadNotepads();const n={id:crypto.randomUUID(),title:data.title||'Untitled',content:data.content||'',created:new Date().toISOString()};np.unshift(n);saveNotepads(np);return sendJson(res,{ok:true,notepad:n});}
  if(route.match(/^\/api\/notepads\/[^/]+$/)&&req.method==='PUT'){const nid=route.split('/')[3];const np=loadNotepads();const n=np.find(x=>x.id===nid);if(!n)return sendJson(res,{error:'Not found'},404);if(data.title!==undefined)n.title=data.title;if(data.content!==undefined)n.content=data.content;n.updated=new Date().toISOString();saveNotepads(np);return sendJson(res,{ok:true,notepad:n});}
  if(route.match(/^\/api\/notepads\/[^/]+$/)&&req.method==='DELETE'){const nid=route.split('/')[3];saveNotepads(loadNotepads().filter(x=>x.id!==nid));return sendJson(res,{ok:true});}

  // ── MCP Client (stdio JSON-RPC) ───────────────────────────────
  const mcpProcs=global._axiomMcp=global._axiomMcp||new Map();
  if(route==='/api/mcp/start'&&req.method==='POST'){
    const{command,args:mcpArgs=[],name:mcpName='mcp-'+Date.now()}=data;
    if(!command)return sendJson(res,{error:'command required'},400);
    if(mcpProcs.has(mcpName)){try{mcpProcs.get(mcpName).proc.kill();}catch(e){}mcpProcs.delete(mcpName);}
    try{
      const proc=spawn(command,mcpArgs,{stdio:['pipe','pipe','pipe'],env:{...process.env}});
      const state={proc,name:mcpName,command,seq:1,pending:{},buf:'',started:new Date().toISOString()};
      proc.stdout.on('data',chunk=>{state.buf+=chunk.toString();let nl;while((nl=state.buf.indexOf('\n'))!==-1){const line=state.buf.slice(0,nl);state.buf=state.buf.slice(nl+1);try{const msg=JSON.parse(line);if(msg.id!==undefined&&state.pending[msg.id]){state.pending[msg.id](msg);delete state.pending[msg.id];}}catch(e){}}});
      proc.on('close',()=>mcpProcs.delete(mcpName));
      mcpProcs.set(mcpName,state);
      proc.stdin.write(JSON.stringify({jsonrpc:'2.0',id:state.seq++,method:'initialize',params:{protocolVersion:'2024-11-05',capabilities:{},clientInfo:{name:'AXIOM',version:'6.0'}}})+'\n');
      await new Promise(r=>setTimeout(r,300));
      return sendJson(res,{ok:true,name:mcpName,pid:proc.pid});
    }catch(e){return sendJson(res,{error:e.message},500);}
  }
  if(route==='/api/mcp/stop'&&req.method==='POST'){const s=mcpProcs.get(data.name);if(s)try{s.proc.kill();}catch(e){}mcpProcs.delete(data.name);return sendJson(res,{ok:true});}
  if(route==='/api/mcp/list'&&req.method==='GET')return sendJson(res,{servers:[...mcpProcs.entries()].map(([name,s])=>({name,command:s.command,started:s.started}))});
  if(route==='/api/mcp/call'&&req.method==='POST'){
    const{name:mcpSrv,method:mcpMethod,params:mcpParams={}}=data;const s=mcpProcs.get(mcpSrv);
    if(!s)return sendJson(res,{error:'Server not running — start it first'},404);
    const mid=s.seq++;
    try{
      const result=await new Promise((resolve,reject)=>{
        s.pending[mid]=resolve;
        setTimeout(()=>{if(s.pending[mid]){delete s.pending[mid];reject(new Error('MCP timeout'));}},10000);
        s.proc.stdin.write(JSON.stringify({jsonrpc:'2.0',id:mid,method:mcpMethod,params:mcpParams})+'\n');
      });
      return sendJson(res,{ok:true,result:result.result||null,error:result.error||null});
    }catch(e){return sendJson(res,{error:e.message},500);}
  }

  // ── Workspace Problems ────────────────────────────────────────
  if(route==='/api/workspace/problems'&&req.method==='POST'){
    const dir=safe(data.dir);if(!dir)return sendJson(res,{error:'Not allowed'},403);
    const problems=[];
    const PATS=[
      {re:/\bTODO\b[:\s]*(.*)/i,sev:'info',type:'TODO'},
      {re:/\bFIXME\b[:\s]*(.*)/i,sev:'warning',type:'FIXME'},
      {re:/\bHACK\b[:\s]*(.*)/i,sev:'warning',type:'HACK'},
      {re:/\bconsole\.log\s*\(/,sev:'warning',type:'console.log'},
      {re:/\bdebugger\b/,sev:'error',type:'debugger'},
    ];
    (function walk(d,depth){if(depth>5||problems.length>500)return;try{fs.readdirSync(d,{withFileTypes:true}).forEach(e=>{if(SKIP.includes(e.name)||e.name.startsWith('.'))return;const fp=path.join(d,e.name);if(e.isDirectory()){walk(fp,depth+1);return;}const ext=path.extname(e.name).slice(1);if(!['js','ts','jsx','tsx','py','go','rs','java','c','cpp','rb','php','sh'].includes(ext))return;let st;try{st=fs.statSync(fp);}catch(e){return;}if(st.size>300000)return;try{const lines=fs.readFileSync(fp,'utf8').split('\n');const rel=fp.replace(dir+'/','');lines.forEach((line,i)=>{PATS.forEach(({re,sev,type})=>{if(re.test(line))problems.push({file:rel,line:i+1,severity:sev,type,text:line.trim().slice(0,100)});});});}catch(e){}});}catch(e){}})(dir,0);
    return sendJson(res,{problems:problems.slice(0,300),total:problems.length});
  }

  // ── File watcher (long-poll) ──────────────────────────────────
  const fwChanges=global._axiomFwChg=global._axiomFwChg||new Map();
  const fwWatchers=global._axiomFwW=global._axiomFwW||new Map();
  if(route==='/api/files/watch'&&req.method==='POST'){
    const dir=safe(data.dir);if(!dir)return sendJson(res,{error:'Not allowed'},403);
    if(!fwWatchers.has(dir)){
      try{const w=fs.watch(dir,{recursive:true},(event,file)=>{if(!file||SKIP.some(s=>file.includes(s)))return;const ch=fwChanges.get(dir)||[];ch.push({type:event,file,ts:Date.now()});fwChanges.set(dir,ch.slice(-50));});fwWatchers.set(dir,w);}catch(e){}
    }
    const since=+(data.since||0);const changes=(fwChanges.get(dir)||[]).filter(c=>c.ts>since);
    return sendJson(res,{changes,ts:Date.now()});
  }

  // ── Rules file (.axiomrules / .cursorrules / AGENTS.md) ───────
  if(route==='/api/rules'&&req.method==='GET'){
    const dir=safe(q.dir)||os.homedir();
    for(const n of['.axiomrules','.cursorrules','AGENTS.md','CLAUDE.md','.github/copilot-instructions.md']){
      try{const fp=path.join(dir,n);if(fs.existsSync(fp))return sendJson(res,{content:fs.readFileSync(fp,'utf8').slice(0,8000),file:n,found:true});}catch(e){}
    }
    return sendJson(res,{content:'',file:'',found:false});
  }

  // ── Settings sync export/import ───────────────────────────────
  if(route==='/api/settings/export'&&req.method==='GET'){
    const u=getReqUser(req);const uid=u?.id||'default';
    let kb={};try{kb=JSON.parse(fs.readFileSync(path.join(DATA,'keybindings',uid+'.json'),'utf8'));}catch(e){}
    let settings={};try{settings=JSON.parse(fs.readFileSync(SETTINGS_FILE,'utf8'));}catch(e){}
    const notepads=loadNotepads();
    res.writeHead(200,{'Content-Type':'application/json','Content-Disposition':'attachment; filename="axiom_settings_sync.json"','Access-Control-Allow-Origin':'*'});
    res.end(JSON.stringify({version:'6.0',exported:new Date().toISOString(),keybindings:kb,settings,notepads},null,2));return;
  }
  if(route==='/api/settings/import'&&req.method==='POST'){
    const u=getReqUser(req);const uid=u?.id||'default';
    if(data.keybindings){try{fs.mkdirSync(path.join(DATA,'keybindings'),{recursive:true});atomicWriteSync(path.join(DATA,'keybindings',uid+'.json'),JSON.stringify(data.keybindings));}catch(e){}}
    if(data.settings){try{atomicWriteSync(SETTINGS_FILE,JSON.stringify(data.settings));}catch(e){}}
    if(data.notepads){try{saveNotepads(data.notepads);}catch(e){}}
    return sendJson(res,{ok:true});
  }

  sendJson(res,{error:'Not found'},404);
});

// ── WebSocket upgrade handler ────────────────────────────────────
server.on('upgrade',(req,socket,_head)=>{
  const u=urlMod.parse(req.url,true);
  if(u.pathname.startsWith('/ws/')){
    socket.on('error',()=>{});
    handleWsUpgrade(req,socket,u.pathname);
  } else {
    socket.destroy();
  }
});

// ── Graceful Shutdown ────────────────────────────────────────────
function gracefulShutdown(signal){
  logInfo(`Received ${signal}, shutting down gracefully...`);
  server.close(()=>{
    logInfo('HTTP server closed');
    // Close all terminal sessions
    terminals.forEach((t,_id)=>{try{if(t.shell)t.shell.kill();}catch(e){}});
    // Close all file watchers
    Object.keys(fileWatchers).forEach(d=>unwatchDirectory(d));
    // Close DB pool
    try{if(dbPool)dbPool.end(()=>logInfo('DB pool closed'));}catch(e){}
    process.exit(0);
  });
  setTimeout(()=>{logWarn('Forced shutdown after timeout');process.exit(1);},10000);
}
process.on('SIGTERM',()=>gracefulShutdown('SIGTERM'));
process.on('SIGINT',()=>gracefulShutdown('SIGINT'));
process.on('uncaughtException',(err)=>{logError('Uncaught exception: '+err.stack);process.exit(1);});
process.on('unhandledRejection',(reason)=>{logError('Unhandled rejection: '+reason);});

// ── Start ────────────────────────────────────────────────────────
const BIND_HOST=process.env.NODE_ENV==='production'?'0.0.0.0':'127.0.0.1';
server.listen(PORT,BIND_HOST,async ()=>{try{
  // Test DB connectivity
  if(dbPool){try{const c=await Promise.race([dbPool.query('SELECT 1'),new Promise((_,r)=>setTimeout(()=>r(new Error('timeout')),3000))]);void c;dbAvailable=true;}catch(e){console.warn('[DB] MySQL not available:',e.message);dbAvailable=false;}}
  if(dbAvailable)await DB.seedDemo();
  const mem=Mem.startSession();const hasKey=!!getKey();
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
  console.log(`  ✦  MySQL   →  ${dbAvailable?'✅ Connected':'⚠️  Offline (file-only mode)'}`);
  console.log(`\n  Token: ${CFG.token}\n`);
  seedAdmin();
  // Only try to open browser in desktop/local mode
  if(process.env.NODE_ENV!=='production'&&!process.env.RAILWAY_ENVIRONMENT){
    const open=process.platform==='darwin'?'open':process.platform==='win32'?'start':'xdg-open';
    require('child_process').exec(`${open} http://localhost:${PORT}`);
  }
}catch(e){console.error('[STARTUP ERROR]',e.message,e.stack);}
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
  save(d){fs.mkdirSync(path.dirname(USERS_FILE),{recursive:true});atomicWriteSync(USERS_FILE,JSON.stringify(d,null,2));},
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

// Ensure the primary administrator account always exists
function seedAdmin(){
  try{
    const d=UsersDB.load();
    const ADMIN_EMAIL='estherzawadi887@gmail.com';
    const ADMIN_PW=process.env.ADMIN_PASSWORD||'Zawadi@18';
    const existing=d.users.find(u=>u.email.toLowerCase()===ADMIN_EMAIL.toLowerCase());
    if(existing){
      // Ensure role is admin even if account was created normally
      if(existing.role!=='admin'||existing.plan!=='pro'){
        existing.role='admin';existing.plan='pro';UsersDB.save(d);
        console.log('  [Admin] Upgraded',ADMIN_EMAIL,'→ admin/pro');
      }
      return;
    }
    const salt=makeSalt(),hash=hashPw(ADMIN_PW,salt);
    d.users.unshift({
      id:crypto.randomUUID(),
      name:'Esther Zawadi',
      email:ADMIN_EMAIL,
      plan:'pro',role:'admin',
      hash,salt,
      avatar:null,
      created_at:new Date().toISOString(),last_seen:null,
      api_key:null,total_cost:0,chat_count:0,settings:{}
    });
    UsersDB.save(d);
    console.log('  [Admin] Created administrator account:',ADMIN_EMAIL);
  }catch(e){console.warn('[Admin] seedAdmin failed:',e.message);}
}

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

// No demo accounts — users must register or use OAuth

