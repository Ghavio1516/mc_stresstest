const { EventEmitter } = require('events')
EventEmitter.defaultMaxListeners = 50

const fs = require('fs')
const path = require('path')
const mineflayer = require('mineflayer')
const { pathfinder, Movements, goals } = require('mineflayer-pathfinder')
const { GoalNear } = goals

// ==== FAR TRAVEL EXPLORATION CONFIG ====
const CHUNK_SIZE = 16
const NAME_PREFIX = 'W_'

const FAR_DISTANCE = 20000
const BASE_TIMEOUT_MS = 200000
const BASE_STUCK_MS = 30000
const BASE_CHAT_MS = 30000
const STUCK_MIN_MOVE = 1.5

const GOAL_TOLERANCE = 10
const RING_MAX = 25
const SAMPLES_PER_RING = 10

const DIRECTIONS = [
  { name: 'NORTH', dx: 0, dz: -1 },
  { name: 'EAST',  dx: 1, dz:  0 },
  { name: 'SOUTH', dx: 0, dz:  1 },
  { name: 'WEST',  dx: -1, dz:  0 }
]

// Sector-based exploration: divide 360 degrees among bots so they spread out
// Each bot gets a unique sector and prefers frontier chunks within it
const SECTOR_COUNT = 8  // Number of sectors around spawn
const SECTOR_ANGLE = (Math.PI * 2) / SECTOR_COUNT

const ENABLE_CHAT = true   // Enable chat reporting for bot activity
const ENABLE_STATS = true
const STATS_INTERVAL = 15000

// ==== Args ====
function arg(name, def) {
  const i = process.argv.indexOf('--' + name)
  return i > -1 ? process.argv[i + 1] : def
}

const BOTS_PER_PROCESS = parseInt(arg('bots-per-process', '5'), 10)
const START_BOT_ID = parseInt(arg('start-id', '0'), 10)
const SERVER_HOST = arg('host', '127.0.0.1')
const SERVER_PORT = parseInt(arg('port', '25565'), 10)

function generateUsername(prefix, id) {
  return `${prefix}${id}`
}

// ==== OPTIMIZED Bot Class ====
class WanderBot {
  constructor(botId, host, port) {
    this.botId = botId
    this.host = host
    this.port = port
    this.username = generateUsername(NAME_PREFIX, botId)
    this.visited = new Set()

    this.metrics = {
      username: null,
      startTime: null,
      endTime: null,
      distance2D: 0,
      uniqueChunks: 0
    }

    this.lastTrack = null
    this.statTimer = null
    this.spawnPos = null
    this.outwardBearing = null
    this.targetIndex = this.botId % DIRECTIONS.length
    this.sectorIndex = this.botId % SECTOR_COUNT  // Unique sector per bot
    this.currentTargetDistance = FAR_DISTANCE
    this.phase = 1

    this.TIMEOUT_MS = BASE_TIMEOUT_MS
    this.STUCK_CHECK_MS = BASE_STUCK_MS
    this.isStuck = false
    this.lastPos = null
    this.lastPosTime = 0
  }

  createBot() {
    this.bot = mineflayer.createBot({
      host: this.host,
      port: this.port,
      username: this.username,
      auth: 'offline',
      version: '1.21.8',
      viewDistance: 'tiny',
      chatLengthLimit: 256,
      physicsEnabled: true,
      hideErrors: true,
      checkTimeoutInterval: 120000,
      keepAlive: true,
      closeTimeout: 180000
    })

    this.bot.loadPlugin(pathfinder)
    this.bot.setMaxListeners(50)

    if (this.bot._client) {
      this.bot._client.setMaxListeners(50)
    }

    this.setupEventHandlers()
  }

  setupEventHandlers() {
    let chunkLoadCounter = 0
    this.bot.on('chunkColumnLoad', (pt) => {
      if (++chunkLoadCounter % 2 === 0) {
        this.visited.add(`${pt.x}:${pt.z}`)
      }
    })

    this.bot.once('spawn', async () => {
      console.log(`[${this.username}] Spawned`)
      await this.onSpawn()
    })

    this.bot.on('kicked', () => this.cleanup())
    this.bot.on('end', () => this.cleanup())
    this.bot.on('error', (e) => console.error(`[${this.username}] err`, e?.message || e))

    // FIX: Handle being attacked/hit — reset pathfinding so bot doesn't
    // try to walk back into danger or get stuck with invalid goal
    this.bot.on('entityHurt', (entity) => {
      if (entity === this.bot.entity) {
        this.onHurt()
      }
    })
  }

  onHurt() {
    this.bot.pathfinder.setGoal(null)
    this.isStuck = false
    const p = this.bot.entity.position
    const msg = `[${this.username}] Hit! Canceling pathfinding at (${p.x.toFixed(0)}, ${p.z.toFixed(0)})`
    console.log(msg)
    if (ENABLE_CHAT) this.bot.chat(msg)
  }

  cleanup() {
    try {
      this.stopStatTimers()
      if (ENABLE_STATS) this.writeBotStats(true)
    } catch {}
  }

  async onSpawn() {
    try {
      const mcData = require('minecraft-data')(this.bot.version)
      const moves = new Movements(this.bot, mcData)

      moves.allow1by1towers = false
      moves.allowParkour = false
      moves.canDig = false
      moves.allowSprinting = false
      moves.scafoldingBlocks = []
      moves.maxDropDown = 4

      if (this.bot.pathfinder && this.bot.pathfinder.setMovements) {
        this.bot.pathfinder.setMovements(moves)
      }

      this.spawnPos = this.bot.entity.position.clone()

      const direction = DIRECTIONS[this.targetIndex]
      this.outwardBearing = Math.atan2(direction.dz, direction.dx)

      this.targetX = this.spawnPos.x + direction.dx * this.currentTargetDistance
      this.targetZ = this.spawnPos.z + direction.dz * this.currentTargetDistance

      console.log(`[${this.username}] Target: ${direction.name} (${this.targetX.toFixed(0)}, ${this.targetZ.toFixed(0)})`)

      this.metricInit()
      if (ENABLE_STATS) this.startStatTimers()

      await this.sleep(2000 + this.botId * 300)
      await this.exploreLoop()

    } catch (err) {
      // Silent fail
    }
  }

  metricInit() {
    this.metrics.username = this.bot.username
    this.metrics.startTime = Date.now()
    this.lastTrack = this.bot.entity.position
    this.lastPos = this.bot.entity.position.clone()
    this.lastPosTime = Date.now()
  }

  startStatTimers() {
    this.statTimer = setInterval(() => {
      try {
        this.trackDistanceTick()
        this.metrics.uniqueChunks = this.visited.size
        this.writeBotStats(false)
      } catch {}
    }, STATS_INTERVAL)
  }

  stopStatTimers() {
    if (this.statTimer) {
      clearInterval(this.statTimer)
      this.statTimer = null
    }
  }

  trackDistanceTick() {
    const p = this.bot.entity?.position
    if (!p || !this.lastTrack) return

    const dx = p.x - this.lastTrack.x
    const dz = p.z - this.lastTrack.z
    this.metrics.distance2D += Math.sqrt(dx * dx + dz * dz)
    this.lastTrack = { x: p.x, z: p.z }
  }

  writeBotStats(finalize = false) {
    if (finalize) this.metrics.endTime = Date.now()

    const STATS_DIR = path.join(process.cwd(), 'results', 'bot_stats')
    fs.mkdirSync(STATS_DIR, { recursive: true })

    const jsonPath = path.join(STATS_DIR, `${this.bot.username}.json`)
    fs.writeFileSync(jsonPath, JSON.stringify(this.metrics))
  }

  currentChunk() {
    const p = this.bot.entity.position
    return {
      cx: Math.floor(p.x / CHUNK_SIZE),
      cz: Math.floor(p.z / CHUNK_SIZE),
      y: Math.floor(p.y)
    }
  }

  chunkCenter(cx, cz, y) {
    return {
      x: cx * CHUNK_SIZE + 8,
      y,
      z: cz * CHUNK_SIZE + 8
    }
  }

  findFrontierSimple() {
    const { cx, cz, y } = this.currentChunk()
    const botAngle = this.sectorIndex * SECTOR_ANGLE

    // Build candidate chunks in expanding rings, then sort by angular proximity to this bot's sector
    const candidates = []

    for (let r = 1; r <= RING_MAX; r++) {
      const checks = [
        [cx + r, cz],
        [cx - r, cz],
        [cx, cz + r],
        [cx, cz - r],
        // Diagonal checks for more coverage
        [cx + r, cz + r],
        [cx + r, cz - r],
        [cx - r, cz + r],
        [cx - r, cz - r]
      ]

      for (const [tx, tz] of checks) {
        if (!this.visited.has(`${tx}:${tz}`)) {
          candidates.push({ tx, tz })
        }
      }
    }

    if (candidates.length === 0) {
      // All chunks visited, pick random far direction
      const angle = Math.random() * Math.PI * 2
      const dist = RING_MAX * CHUNK_SIZE
      const p = this.bot.entity.position
      return {
        target: { x: p.x + Math.cos(angle) * dist, y: p.y, z: p.z + Math.sin(angle) * dist },
        chunk: null
      }
    }

    // Score each candidate by angular distance from this bot's sector direction
    // Prefer chunks that are in this bot's sector
    const sorted = candidates.sort((a, b) => {
      const angleA = Math.atan2(a.tz - cz, a.tx - cx)
      const angleB = Math.atan2(b.tz - cz, b.tx - cx)
      const diffA = Math.abs(((angleA - botAngle) + Math.PI) % (Math.PI * 2) - Math.PI)
      const diffB = Math.abs(((angleB - botAngle) + Math.PI) % (Math.PI * 2) - Math.PI)
      return diffA - diffB
    })

    // Pick from top candidates (weighted toward this bot's sector)
    const pick = sorted[Math.floor(Math.random() * Math.min(3, sorted.length))]
    return {
      target: this.chunkCenter(pick.tx, pick.tz, y),
      chunk: { tx: pick.tx, tz: pick.tz }
    }
  }

  planarDist(a, b) {
    const dx = a.x - b.x
    const dz = a.z - b.z
    return Math.sqrt(dx * dx + dz * dz)
  }

  // FIX: Use bot.pathfinder.goto() which is event-based and properly
  // handles goal_reached, path_stop, noPath, and goal_updated events.
  // Old gotoWithTimeout polled isMoving() which couldn't distinguish
  // "reached goal" from "stuck with no path" — that's what caused freezes.
  async gotoWithTimeout(pos) {
    return new Promise((resolve) => {
      const timeout = setTimeout(() => {
        this.bot.pathfinder.setGoal(null)
        resolve(false)
      }, this.TIMEOUT_MS)

      let goalReached = false
      let noPath = false

      const onGoalReached = () => {
        goalReached = true
      }

      const onPathUpdate = (results) => {
        if (results.status === 'noPath' || (results.path && results.path.length === 0)) {
          noPath = true
        }
      }

      const onPathStop = () => {
        // Path stopped without reaching goal — bot may be stuck
        this.isStuck = true
      }

      this.bot.on('goal_reached', onGoalReached)
      this.bot.on('path_update', onPathUpdate)
      this.bot.on('path_stop', onPathStop)

      this.bot.pathfinder.goto(new GoalNear(pos.x, pos.y, pos.z, GOAL_TOLERANCE))
        .then(() => {
          clearTimeout(timeout)
          this.bot.removeListener('goal_reached', onGoalReached)
          this.bot.removeListener('path_update', onPathUpdate)
          this.bot.removeListener('path_stop', onPathStop)
          resolve(goalReached && !noPath)
        })
        .catch(() => {
          clearTimeout(timeout)
          this.bot.removeListener('goal_reached', onGoalReached)
          this.bot.removeListener('path_update', onPathUpdate)
          this.bot.removeListener('path_stop', onPathStop)
          resolve(false)
        })
    })
  }

  async exploreLoop() {
    let cycle = 0

    while (true) {
      try {
        if (++cycle % 10 === 0) await this.yieldEventLoop()

        // Check if bot is stuck (not moving for STUCK_CHECK_MS)
        const now = Date.now()
        const cur = this.bot.entity.position.clone()

        if (this.lastPos && this.planarDist(cur, this.lastPos) < STUCK_MIN_MOVE) {
          if (now - this.lastPosTime > this.STUCK_CHECK_MS) {
            if (!this.isStuck) {
              this.isStuck = true
              this.bot.pathfinder.setGoal(null)
              // Escape stuck: find a new nearby target
              const stuckPos = this.bot.entity.position.clone()
              const escapeTarget = {
                x: stuckPos.x + (Math.random() - 0.5) * 20,
                y: stuckPos.y,
                z: stuckPos.z + (Math.random() - 0.5) * 20
              }
              await this.gotoWithTimeout(escapeTarget)
            }
          }
        } else {
          this.isStuck = false
          this.lastPosTime = now
        }

        this.lastPos = cur

        // Find frontier and go there
        const cand = this.findFrontierSimple()
        if (cand) {
          const sectorDeg = ((this.sectorIndex * SECTOR_ANGLE * 180 / Math.PI) % 360).toFixed(0)
          const chunkInfo = cand.chunk ? `(${cand.chunk.tx}, ${cand.chunk.tz})` : '(random)'
          const dirName = DIRECTIONS[this.targetIndex].name
          const nextDist = cand.chunk ? `chunk (${cand.chunk.tx}, ${cand.chunk.tz})` : 'random far target'
          const msg = `[${this.username}] Sector ${sectorDeg}° (${dirName}) -> heading to ${nextDist}`
          console.log(msg)
          if (ENABLE_CHAT) this.bot.chat(msg)
          await this.gotoWithTimeout(cand.target)
          if (cand.chunk) {
            this.visited.add(`${cand.chunk.tx}:${cand.chunk.tz}`)
          }
        } else {
          const msg = `[${this.username}] No frontier found, resting`
          console.log(msg)
          if (ENABLE_CHAT) this.bot.chat(msg)
        }

        // Report stuck status and next move via in-game chat
        if (this.isStuck) {
          const p = this.bot.entity.position
          const msg = `[${this.username}] STUCK at (${p.x.toFixed(0)}, ${p.z.toFixed(0)}) — seeking escape`
          console.log(msg)
          if (ENABLE_CHAT) this.bot.chat(msg)
        }

        // Phase transition check
        if (this.phase === 1) {
          const distanceFromSpawn = this.planarDist(this.bot.entity.position, this.spawnPos)
          if (distanceFromSpawn >= 5000) {
            console.log(`[${this.username}] Reached ${Math.floor(distanceFromSpawn)} blocks, switching to local exploration`)
            this.phase = 2
          }
        }

        await this.sleep(2000 + Math.random() * 1000)

      } catch {
        await this.sleep(3000)
      }
    }
  }

  sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms))
  }

  yieldEventLoop() {
    return new Promise(r => setImmediate(r))
  }
}

// ==== Main ====
async function main() {
  const bots = []

  console.log(`Starting ${BOTS_PER_PROCESS} bots (W_${START_BOT_ID}-${START_BOT_ID + BOTS_PER_PROCESS - 1})`)

  for (let i = 0; i < BOTS_PER_PROCESS; i++) {
    const botId = START_BOT_ID + i
    const wanderBot = new WanderBot(botId, SERVER_HOST, SERVER_PORT)

    try {
      wanderBot.createBot()
      bots.push(wanderBot)

      if (i < BOTS_PER_PROCESS - 1) {
        await new Promise(r => setTimeout(r, 4000))
      }
    } catch (err) {
      console.error(`[W_${botId}] Failed: ${err.message}`)
    }
  }

  console.log(`Process ready with ${bots.length} bots\n`)

  const cleanup = () => {
    bots.forEach((bot) => {
      try {
        bot.cleanup()
        if (bot.bot && bot.bot.quit) bot.bot.quit()
      } catch {}
    })
    process.exit(0)
  }

  process.on('SIGINT', cleanup)
  process.on('SIGTERM', cleanup)
}

process.on('uncaughtException', () => {})
process.on('unhandledRejection', () => {})

main().catch(() => process.exit(1))