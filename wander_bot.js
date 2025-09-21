const { EventEmitter } = require('events')
EventEmitter.defaultMaxListeners = 50

const mineflayer = require('mineflayer')
const { pathfinder, Movements, goals } = require('mineflayer-pathfinder')
const { GoalNear } = goals

const CHUNK_SIZE = 16
const RING_MAX = 20
const SAMPLES_PER_RING = 10
const GOAL_TOLERANCE = 2
const TIMEOUT_MS = 45000
const STUCK_CHECK_MS = 8000
const STUCK_MIN_MOVE = 2.0
const CHAT_COOLDOWN_MS = 4000
const MIN_SEPARATION = 48
const REPEL_WEIGHT = 32
const NAME_PREFIX = 'W_'

function arg(name, def) {
  const i = process.argv.indexOf('--' + name)
  return i > -1 ? process.argv[i + 1] : def
}

function randomName(prefix = NAME_PREFIX) {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_'
  let base = ''
  while (base.length < 12) base += chars[Math.floor(Math.random() * chars.length)]
  return (prefix + base).slice(0, 16)
}

function hashAngle(str) {
  let h = 2166136261 >>> 0
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return (h / 0xffffffff) * Math.PI * 2
}

const usernameArg = arg('username', '')

const bot = mineflayer.createBot({
  host: arg('host', '127.0.0.1'),
  port: parseInt(arg('port', '25565'), 10),
  username: usernameArg && usernameArg.length >= 3 ? usernameArg : randomName(),
  auth: 'offline',
  version: '1.21.1'
})

bot.loadPlugin(pathfinder)
bot.setMaxListeners(50)
if (bot._client && typeof bot._client.setMaxListeners === 'function') bot._client.setMaxListeners(50)

const visited = new Set()

function safeChat(msg) { try { bot.chat(msg) } catch {} }
let lastChatTs = 0
function chatThrottled(msg) {
  const now = Date.now()
  if (now - lastChatTs >= CHAT_COOLDOWN_MS) { lastChatTs = now; safeChat(msg) }
}

function chunkKey(cx, cz) { return `${cx}:${cz}` }
bot.on('chunkColumnLoad', (pt) => { visited.add(chunkKey(pt.x, pt.z)) })

function currentChunk() {
  const p = bot.entity.position
  return { cx: Math.floor(p.x / CHUNK_SIZE), cz: Math.floor(p.z / CHUNK_SIZE), y: Math.floor(p.y) }
}

function chunkCenter(cx, cz, y) { return { x: cx * CHUNK_SIZE + CHUNK_SIZE / 2, y, z: cz * CHUNK_SIZE + CHUNK_SIZE / 2 } }

function findFrontierGeneric(maxRing = RING_MAX, samples = SAMPLES_PER_RING) {
  const { cx, cz, y } = currentChunk()
  for (let r = 1; r <= maxRing; r++) {
    for (let i = 0; i < samples; i++) {
      const theta = (2 * Math.PI * i) / samples
      const tx = cx + Math.round(r * Math.cos(theta))
      const tz = cz + Math.round(r * Math.sin(theta))
      if (!visited.has(chunkKey(tx, tz))) return { target: chunkCenter(tx, tz, y), chunk: { tx, tz } }
    }
  }
  return null
}

let spawnPos = null
let spawnChunk = null
let outwardBearing = null

function findFrontierOutward(startRing = 8, maxRing = RING_MAX * 2) {
  if (!spawnChunk || outwardBearing === null) return findFrontierGeneric()
  const y = bot.entity.position.y
  for (let r = startRing; r <= maxRing; r++) {
    const jitter = (Math.random() - 0.5) * (Math.PI / 10)
    const ang = outwardBearing + jitter
    const tx = spawnChunk.cx + Math.round(r * Math.cos(ang))
    const tz = spawnChunk.cz + Math.round(r * Math.sin(ang))
    if (!visited.has(chunkKey(tx, tz))) return { target: chunkCenter(tx, tz, y), chunk: { tx, tz } }
  }
  return findFrontierGeneric()
}

function planarDist(a, b) { const dx = a.x - b.x, dz = a.z - b.z; return Math.sqrt(dx * dx + dz * dz) }

function separationOffset() {
  const me = bot.entity?.position
  if (!me) return { ox: 0, oz: 0 }
  let ox = 0, oz = 0
  for (const [name, info] of Object.entries(bot.players)) {
    if (!info?.entity) continue
    if (name === bot.username) continue
    if (!name.startsWith(NAME_PREFIX)) continue
    const p = info.entity.position
    const dx = me.x - p.x
    const dz = me.z - p.z
    const d = Math.sqrt(dx * dx + dz * dz)
    if (d > 0 && d < MIN_SEPARATION) {
      const k = (MIN_SEPARATION - d) / MIN_SEPARATION
      ox += (dx / d) * REPEL_WEIGHT * k
      oz += (dz / d) * REPEL_WEIGHT * k
    }
  }
  return { ox, oz }
}

async function gotoWithTimeout(pos, announce = '') {
  if (announce) chatThrottled(announce)
  return new Promise((resolve) => {
    let done = false
    bot.pathfinder.setGoal(null)
    const goal = new GoalNear(pos.x, pos.y, pos.z, GOAL_TOLERANCE)
    bot.pathfinder.setGoal(goal, false)
    const timer = setTimeout(() => { if (!done) { done = true; resolve(false) } }, TIMEOUT_MS)
    const iv = setInterval(() => {
      if (!bot.pathfinder.isMoving()) {
        clearInterval(iv); clearTimeout(timer)
        if (!done) { done = true; resolve(true) }
      }
    }, 1000)
  })
}

async function trySurfaceRecovery() {
  const mcData = require('minecraft-data')(bot.version)
  const m = new Movements(bot, mcData)
  m.allow1by1towers = true
  m.allowParkour = true
  m.canDig = false
  bot.pathfinder.setMovements(m)

  for (let i = 0; i < 3; i++) {
    const p = bot.entity.position
    const up = { x: p.x, y: p.y + 4 + i * 2, z: p.z }
    const ok = await gotoWithTimeout(up, 'im stuck, trying to climb up')
    if (ok) return true
  }

  m.canDig = true
  bot.pathfinder.setMovements(m)
  for (let i = 0; i < 3; i++) {
    const p = bot.entity.position
    const up = { x: p.x, y: p.y + 6 + i * 2, z: p.z }
    const ok = await gotoWithTimeout(up, 'im stuck, digging my way up')
    if (ok) {
      m.canDig = false
      bot.pathfinder.setMovements(m)
      return true
    }
  }
  m.canDig = false
  bot.pathfinder.setMovements(m)
  return false
}

async function initialOutwardScatter() {
  const base = spawnPos.clone()
  const radius = 220 + Math.random() * 260
  const { ox, oz } = separationOffset()
  const target = {
    x: base.x + Math.cos(outwardBearing) * radius + ox,
    y: base.y,
    z: base.z + Math.sin(outwardBearing) * radius + oz
  }
  chatThrottled(`i just got here, heading to ${Math.round(target.x)}, ${Math.round(target.z)}`)
  await gotoWithTimeout(target)
}

async function exploreLoop() {
  let lastPos = bot.entity.position.clone()
  let lastCheck = Date.now()
  while (true) {
    try {
      const now = Date.now()
      if (now - lastCheck >= STUCK_CHECK_MS) {
        const cur = bot.entity.position.clone()
        if (planarDist(cur, lastPos) < STUCK_MIN_MOVE) {
          chatThrottled('im stuck')
          const recovered = await trySurfaceRecovery()
          if (!recovered) {
            const fb = findFrontierGeneric()
            if (fb) await gotoWithTimeout(fb.target, `cant climb, fallback to ${Math.round(fb.target.x)}, ${Math.round(fb.target.z)}`)
          } else {
            chatThrottled('recovered, continuing')
          }
        }
        lastPos = cur
        lastCheck = now
      }

      const cand = findFrontierOutward()
      if (!cand) {
        const p = bot.entity.position
        const { ox, oz } = separationOffset()
        const far = { x: p.x + (Math.random() * 2 - 1) * 256 + ox, y: p.y, z: p.z + (Math.random() * 2 - 1) * 256 + oz }
        await gotoWithTimeout(far, `no frontier found, going to ${Math.round(far.x)}, ${Math.round(far.z)}`)
      } else {
        const { ox, oz } = separationOffset()
        const t = { x: cand.target.x + ox, y: cand.target.y, z: cand.target.z + oz }
        const msg = `im going to new chunk at ${Math.round(t.x)}, ${Math.round(t.z)}`
        const ok = await gotoWithTimeout(t, msg)
        if (ok) visited.add(chunkKey(cand.chunk.tx, cand.chunk.tz))
      }
      await new Promise((r) => setTimeout(r, 1000))
    } catch {
      await new Promise((r) => setTimeout(r, 1800))
    }
  }
}

function scheduleReconnect(ms) { setTimeout(() => process.exit(2), ms) }

bot.once('spawn', async () => {
  const mcData = require('minecraft-data')(bot.version)
  const moves = new Movements(bot, mcData)
  moves.allow1by1towers = true
  moves.allowParkour = true
  moves.canDig = false
  bot.pathfinder.setMovements(moves)

  spawnPos = bot.entity.position.clone()
  spawnChunk = { cx: Math.floor(spawnPos.x / CHUNK_SIZE), cz: Math.floor(spawnPos.z / CHUNK_SIZE) }
  outwardBearing = hashAngle(bot.username)

  await new Promise((r) => setTimeout(r, 1000))
  await initialOutwardScatter()
  await exploreLoop()
})

bot.on('kicked', () => { scheduleReconnect(4000 + Math.floor(Math.random() * 4000)) })
bot.on('end',    () => { scheduleReconnect(4000 + Math.floor(Math.random() * 4000)) })
bot.on('error',  () => {})
