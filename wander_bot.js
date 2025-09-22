const { EventEmitter } = require('events')
EventEmitter.defaultMaxListeners = 50

const fs = require('fs')
const path = require('path')
const mineflayer = require('mineflayer')
const { pathfinder, Movements, goals } = require('mineflayer-pathfinder')
const { GoalNear } = goals

// Konfigurasi
const CHUNK_SIZE = 16
const RING_MAX = 20
const SAMPLES_PER_RING = 10
const GOAL_TOLERANCE = 2
const BASE_TIMEOUT_MS = 35000
const BASE_STUCK_MS = 6000
const BASE_CHAT_MS = 3000
const MIN_SEPARATION = 48
const REPEL_WEIGHT = 32
const NAME_PREFIX = 'W_'
const MAX_RETRIES = 5

// Arg parsing
function arg(name, def) {
  const i = process.argv.indexOf('--' + name)
  return i > -1 ? process.argv[i + 1] : def
}

// Random username fallback
function randomName(prefix = NAME_PREFIX) {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_'
  let base = ''
  while (base.length < 12) base += chars[Math.floor(Math.random() * chars.length)]
  return (prefix + base).slice(0, 16)
}

// Hash untuk scatter bearing
function hashAngle(str) {
  let h = 2166136261 >>> 0
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return (h / 0xffffffff) * Math.PI * 2
}

// Setup bot
const usernameArg = arg('username', '')
const BOT_ID = parseInt(arg('bot-id', '0'))
const PERFORMANCE_MODE = process.argv.includes('--performance')

const bot = mineflayer.createBot({
  host: arg('host','127.0.0.1'),
  port: parseInt(arg('port','25565'),10),
  username: usernameArg.length>=3?usernameArg:randomName(),
  auth: 'offline',
  version: '1.21.1'
})

// Metrics state
const visited = new Set()
const STATS_DIR = path.join(process.cwd(),'results','bot_stats')
fs.mkdirSync(STATS_DIR,{recursive:true})

const metrics = {
  username:null,startTime:null,endTime:null,lastUpdate:null,
  start:{x:0,z:0},end:{x:0,z:0},distance2D:0,
  uniqueChunks:0,stuckCount:0,recoverClimb:0,recoverDig:0,
  goalsReached:0,newChunksReached:0
}

// Utility
function safeChat(m){try{bot.chat(m)}catch{}}
let lastChatTs=0
function chatThrottled(m){
  const now=Date.now()
  if(now-lastChatTs>=BASE_CHAT_MS+BOT_ID*500){
    lastChatTs=now
    safeChat(m)
  }
}
function chunkKey(cx,cz){return`${cx}:${cz}`}
bot.on('chunkColumnLoad',pt=>visited.add(chunkKey(pt.x,pt.z)))
function currentChunk(){const p=bot.entity.position;return{cx:Math.floor(p.x/CHUNK_SIZE),cz:Math.floor(p.z/CHUNK_SIZE),y:Math.floor(p.y)}}
function chunkCenter(cx,cz,y){return{x:cx*CHUNK_SIZE+CHUNK_SIZE/2,y,z:cz*CHUNK_SIZE+CHUNK_SIZE/2}}
function planarDist(a,b){const dx=a.x-b.x,dz=a.z-b.z;return Math.sqrt(dx*dx+dz*dz)}

function separationOffset(){
  const me=bot.entity?.position; if(!me) return {ox:0,oz:0}
  let ox=0,oz=0
  for(const [name,info] of Object.entries(bot.players)){
    if(!info?.entity||name===bot.username||!name.startsWith(NAME_PREFIX))continue
    const p=info.entity.position
    const dx=me.x-p.x,dz=me.z-p.z
    const d=Math.sqrt(dx*dx+dz*dz)
    if(d>0&&d<MIN_SEPARATION){
      const k=(MIN_SEPARATION-d)/MIN_SEPARATION
      ox+=(dx/d)*REPEL_WEIGHT*k
      oz+=(dz/d)*REPEL_WEIGHT*k
    }
  }
  return{ox,oz}
}

// Metrics functions
function metricInit(){
  metrics.username=bot.username
  metrics.startTime=Date.now()
  metrics.start={x:bot.entity.position.x,z:bot.entity.position.z}
}
let lastTrack=null
function trackDistanceTick(){
  const p=bot.entity?.position; if(!p)return
  if(!lastTrack){lastTrack={x:p.x,z:p.z};return}
  const dx=p.x-lastTrack.x,dz=p.z-lastTrack.z
  metrics.distance2D+=Math.sqrt(dx*dx+dz*dz)
  lastTrack={x:p.x,z:p.z}
}
function updateUniqueChunks(){metrics.uniqueChunks=visited.size}
function writeBotStats(finalize=false){
  const p=bot.entity?.position; if(p)metrics.end={x:p.x,z:p.z}
  if(finalize)metrics.endTime=Date.now()
  metrics.lastUpdate=Date.now()
  const jsonP=path.join(STATS_DIR,`${bot.username}.json`)
  fs.writeFileSync(jsonP,JSON.stringify(metrics,null,2))
  const csvP=path.join(STATS_DIR,`${bot.username}.csv`)
  const hdr=['username','start_x','start_z','end_x','end_z','distance2d','uniqueChunks','stuckCount','recoverClimb','recoverDig','goalsReached','newChunksReached','uptime_s']
  const uptime=((metrics.endTime||Date.now())-metrics.startTime)/1000
  const row=[metrics.username,Math.round(metrics.start.x),Math.round(metrics.start.z),Math.round(metrics.end.x),Math.round(metrics.end.z),metrics.distance2D.toFixed(2),metrics.uniqueChunks,metrics.stuckCount,metrics.recoverClimb,metrics.recoverDig,metrics.goalsReached,metrics.newChunksReached,uptime.toFixed(1)]
  if(!fs.existsSync(csvP))fs.writeFileSync(csvP,hdr.join(',')+'\n')
  fs.writeFileSync(csvP,fs.readFileSync(csvP)+'\n'+row.join(','))
}

let statTimer=null
function startStatTimers(){
  statTimer=setInterval(()=>{
    trackDistanceTick();updateUniqueChunks();writeBotStats(false)
  },4000+BOT_ID*200)
}
function stopStatTimers(){if(statTimer)clearInterval(statTimer)}

// Yield event loop
function yieldEventLoop(){return new Promise(r=>setImmediate(r))}

// Pathfinder globals
let spawnPos=null,spawnChunk=null,outwardBearing=null

async function gotoWithTimeout(pos,announce='',isNew=false){
  if(announce)chatThrottled(announce)
  return new Promise(resolve=>{
    let done=false
    bot.pathfinder.setGoal(null)
    const goal=new GoalNear(pos.x,pos.y,pos.z,GOAL_TOLERANCE)
    bot.pathfinder.setGoal(goal,false)
    const to=BASE_TIMEOUT_MS+Math.random()*10000
    const timer=setTimeout(()=>{if(!done){done=true;resolve(false)}},to)
    const iv=setInterval(()=>{
      if(!bot.pathfinder.isMoving()){
        clearInterval(iv);clearTimeout(timer)
        if(!done){
          done=true
          metrics.goalsReached++
          if(isNew)metrics.newChunksReached++
          resolve(true)
        }
      }
    },1000)
  })
}

async function trySurfaceRecovery(){
  const mcData=require('minecraft-data')(bot.version)
  const m=new Movements(bot,mcData)
  m.allow1by1towers=true;m.allowParkour=true;m.canDig=false;bot.pathfinder.setMovements(m)
  metrics.stuckCount++
  for(let i=0;i<3;i++){
    const p=bot.entity.position
    const up={x:p.x,y:p.y+4+i*2,z:p.z}
    if(await gotoWithTimeout(up,'im stuck, climbing')){
      metrics.recoverClimb++;return true}
  }
  m.canDig=true;bot.pathfinder.setMovements(m)
  for(let i=0;i<3;i++){
    const p=bot.entity.position
    const up={x:p.x,y:p.y+6+i*2,z:p.z}
    if(await gotoWithTimeout(up,'im stuck, digging')){
      metrics.recoverDig++;m.canDig=false;bot.pathfinder.setMovements(m);return true}
  }
  m.canDig=false;bot.pathfinder.setMovements(m)
  return false
}

async function initialOutwardScatter(){
  const base=spawnPos.clone()
  const radius=220+Math.random()*260
  const {ox,oz}=separationOffset()
  const target={x:base.x+Math.cos(outwardBearing)*radius+ox,y:base.y,z:base.z+Math.sin(outwardBearing)*radius+oz}
  chatThrottled(`i just got here, heading to ${Math.round(target.x)},${Math.round(target.z)}`)
  await gotoWithTimeout(target,false)
}

async function exploreLoop(){
  let lastPos=bot.entity.position.clone()
  let lastCheck=Date.now()
  let cycle=0
  while(true){
    try{
      if(++cycle%3===0)await yieldEventLoop()
      const now=Date.now()
      if(now-lastCheck>=BASE_STUCK_MS+Math.random()*4000){
        const cur=bot.entity.position.clone()
        if(planarDist(cur,lastPos)<2.0){
          chatThrottled('im stuck')
          if(!(await trySurfaceRecovery())){
            const fb=findFrontierGeneric()
            if(fb)await gotoWithTimeout(fb.target,'fallback',false)
          } else chatThrottled('recovered')
        }
        lastPos=cur;lastCheck=now
      }
      const cand=findFrontierOutward()
      if(!cand){
        const p=bot.entity.position
        const {ox,oz}=separationOffset()
        const far={x:p.x+(Math.random()*2-1)*256+ox,y:p.y,z:p.z+(Math.random()*2-1)*256+oz}
        await gotoWithTimeout(far,'random',false)
      } else {
        const {ox,oz}=separationOffset()
        const t={x:cand.target.x+ox,y:cand.target.y,z:cand.target.z+oz}
        const ok=await gotoWithTimeout(t,'new chunk',true)
        if(ok)visited.add(chunkKey(cand.chunk.tx,cand.chunk.tz))
      }
      await new Promise(r=>setTimeout(r,800+Math.random()*400))
    }catch{
      await new Promise(r=>setTimeout(r,1500+Math.random()*500))
    }
  }
}

function findFrontierGeneric(maxR=RING_MAX,samples=SAMPLES_PER_RING){
  const {cx,cz,y}=currentChunk()
  for(let r=1;r<=maxR;r++){
    for(let i=0;i<samples;i++){
      const th=(2*Math.PI*i)/samples
      const tx=cx+Math.round(r*Math.cos(th))
      const tz=cz+Math.round(r*Math.sin(th))
      if(!visited.has(chunkKey(tx,tz)))return{target:chunkCenter(tx,tz,y),chunk:{tx,tz}}
    }
  }
  return null
}

function findFrontierOutward(start=8,maxR=RING_MAX*2){
  if(!spawnChunk||outwardBearing===null)return findFrontierGeneric()
  const y=bot.entity.position.y
  for(let r=start;r<=maxR;r++){
    const ang=outwardBearing+(Math.random()-0.5)*(Math.PI/10)
    const tx=spawnChunk.cx+Math.round(r*Math.cos(ang))
    const tz=spawnChunk.cz+Math.round(r*Math.sin(ang))
    if(!visited.has(chunkKey(tx,tz)))return{target:chunkCenter(tx,tz,y),chunk:{tx,tz}}
  }
  return findFrontierGeneric()
}

// Scheduler and retry
let retryCount=0
function scheduleReconnect(){
  if(retryCount++>=MAX_RETRIES)return process.exit(1)
  const delay=4000+Math.random()*4000
  writeBotStats(true);stopStatTimers()
  setTimeout(()=>{
    bot.connect()
  },delay)
}

bot.on('end',scheduleReconnect)
bot.on('kicked',scheduleReconnect)
bot.on('error',(e)=>{})

bot.once('spawn',async()=>{
  const mcData=require('minecraft-data')(bot.version)
  const moves=new Movements(bot,mcData)
  moves.allow1by1towers=true;moves.allowParkour=true;moves.canDig=false
  bot.pathfinder.setMovements(moves)

  spawnPos=bot.entity.position.clone()
  spawnChunk={cx:Math.floor(spawnPos.x/CHUNK_SIZE),cz:Math.floor(spawnPos.z/CHUNK_SIZE)}
  outwardBearing=hashAngle(bot.username)

  metricInit();startStatTimers()

  await new Promise(r=>setTimeout(r,1000))
  await initialOutwardScatter()
  await exploreLoop()
})
