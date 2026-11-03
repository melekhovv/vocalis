const fs = require('node:fs'); const vm = require('node:vm'); const assert = require('node:assert/strict'); const {EventEmitter} = require('node:events');
const source=fs.readFileSync(require('node:path').join(__dirname,'../src/main/index.ts'),'utf8');
const fn=require('node:module').stripTypeScriptTypes(source.slice(source.indexOf('function startEngine()'),source.indexOf('function setupEngine()')));
const children=[],timers=[],states=[];
const ctx={existsSync:()=>true, pythonExe:'qa',engineDir:'qa',token:'test',process:{pid:1,env:{}},quitting:false,engineProc:null,enginePort:0,engineLog:['old error'],engineState:'starting',restarts:0,Date,spawn:()=>{const p=new EventEmitter();p.stdout=new EventEmitter();p.stderr=new EventEmitter();children.push(p);return p},setTimeout:f=>timers.push(f),pushLog:s=>ctx.engineLog.push(s),setEngineState:s=>states.push(s)};
vm.createContext(ctx);vm.runInContext(fn,ctx);ctx.startEngine();assert.equal(children.length,1);ctx.startEngine();assert.equal(children.length,1,'duplicate process');
children.at(-1).stdout.emit('data',Buffer.from('VOCALIS_READY 1234\n'));assert.equal(ctx.engineLog.length,0,'successful startup clears errors');
for(let i=0;i<4;i++){children.at(-1).emit('exit',1);if(timers.length){timers.shift()();children.at(-1).stdout.emit('data',Buffer.from('VOCALIS_READY 1234\n'))}}
assert.equal(children.length,4,'ready/crash loop must be bounded');assert.equal(timers.length,0);
ctx.startEngine();children.at(-1).emit('error',new Error('launch failed'));assert.equal(ctx.engineProc,null,'failed launch must allow retry');
console.log('PASS: duplicate start, cleared log, bounded restart, failed-spawn recovery');
