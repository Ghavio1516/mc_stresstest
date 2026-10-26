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
const JUMP_DURATION_MS = 500
const JUMP_RETRY_DELAY_MS = 1000
const BLOCK_BREAK_RETRY_DELAY_MS = 2000
const MAX_BLOCK_BREAK_ATTEMPTS = 3

// Blocks that can be broken with hand (no tool required)
const HAND_BREAKABLE_BLOCKS = new Set([
  'oak_leaves', 'birch_leaves', 'spruce_leaves', 'jungle_leaves',
  'acacia_leaves', 'dark_oak_leaves', 'mangrove_leaves', 'cherry_leaves',
  'tall_grass', 'short_grass', 'fern', 'large_fern',
  'dandelion', 'poppy', 'blue_orchid', 'allium', 'azure_bluet',
  'red_tulip', 'orange_tulip', 'white_tulip', 'pink_tulip',
  'oxeye_daisy', 'cornflower', 'lily_of_the_valley',
  'wither_rose', 'sunflower', 'lilac', 'rose_bush', 'peony',
  'azalea', 'flowering_azalea', 'moss_carpet', 'pink_petals',
  'vine', 'tripwire', 'web', 'snow', 'ice', 'packed_ice',
  'bamboo', 'dead_bush', 'seagrass', 'tall_seagrass'
])

// Blocks that require a tool (cannot be broken by hand efficiently)
const TOOL_REQUIRED_BLOCKS = new Set([
  'stone', 'cobblestone', 'dirt', 'grass_block', 'diorite', 'granite',
  'andesite', 'deepslate', 'iron_ore', 'gold_ore', 'diamond_ore',
  'coal_ore', 'lapis_ore', 'redstone_ore', 'emerald_ore', 'nether_quartz_ore',
  'bedrock', 'obsidian', 'anvil', 'chiseled_stone_bricks',
  'cracked_stone_bricks', 'mossy_stone_bricks', 'stone_bricks',
  'sandstone', 'red_sandstone', 'end_stone', 'netherrack',
  'basalt', 'blackstone', 'crying_obsidian'
])

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
    const msg = `[${this.username}] Hit! Jumping and rerouting at (${p.x.toFixed(0)}, ${p.z.toFixed(0)})`
    console.log(msg)
    if (ENABLE_CHAT) this.bot.chat(msg)
    // Jump to avoid danger, then find new target
    this.bot.setControlState('jump', true)
    setTimeout(() => {
      try {
        this.bot.setControlState('jump', false)
      } catch {}
    }, 500)
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

      moves.allow1by1towers = true
      moves.allowParkour = true
      moves.canDig = true
      moves.allowSprinting = true
      moves.scafoldingBlocks = ['oak_planks', 'birch_planks', 'spruce_planks', 'jungle_planks', 'acacia_planks', 'dark_oak_planks', 'mangrove_planks', 'cherry_planks', 'dirt', 'cobblestone', 'sandstone', 'planks']
      moves.maxDropDown = 4
      moves.allowJump = true

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

  // Check if a block at (x, y, z) is air or replaceable (can walk through)
  isBlockPassable(x, y, z) {
    try {
      const block = this.bot.blockAt({ x: Math.floor(x), y: Math.floor(y), z: Math.floor(z) })
      if (!block) return true
      const name = block.name
      return name === 'air' || name === 'cave_air' || name === 'void_air' ||
        name === 'water' || name === 'flowing_water' ||
        name === 'lava' || name === 'flowing_lava' ||
        name === 'snow' || name === 'powder_snow' ||
        HAND_BREAKABLE_BLOCKS.has(name)
    } catch {
      return true
    }
  }

  // Check if a block requires a tool to break efficiently
  blockRequiresTool(name) {
    return TOOL_REQUIRED_BLOCKS.has(name)
  }

  // Try to break blocks blocking the path to a target position
  // Returns true if path was cleared or is now passable
  async clearPathBlockage(targetPos) {
    const bot = this.bot
    const start = bot.entity.position
    const dx = targetPos.x - start.x
    const dz = targetPos.z - start.z
    const dist = Math.sqrt(dx * dx + dz * dz)
    if (dist < 1) return true

    // Check blocks along the direct line to target
    const steps = Math.ceil(dist / 2)
    let blocksBroken = 0

    for (let i = 1; i <= steps && blocksBroken < MAX_BLOCK_BREAK_ATTEMPTS; i++) {
      const t = i / steps
      const cx = Math.floor(start.x + dx * t)
      const cz = Math.floor(start.z + dz * t)
      const cy = Math.floor(start.y)

      // Check the block at foot level and one block above
      for (let yOffset = 0; yOffset <= 1; yOffset++) {
        const block = bot.blockAt({ x: cx, y: cy + yOffset, z: cz })
        if (!block) continue
        const name = block.name

        if (name === 'air' || name === 'cave_air' || name === 'void_air') continue
        if (name === 'water' || name === 'flowing_water') continue
        if (name === 'lava' || name === 'flowing_lava') continue

        // Check if hand-breakable
        if (HAND_BREAKABLE_BLOCKS.has(name)) {
          try {
            await bot.dig(block)
            blocksBroken++
            await this.sleep(200)
          } catch {
            // Block not breakable or already gone
          }
          continue
        }

        // Check if tool-required — bot has no tool, skip this path
        if (this.blockRequiresTool(name)) {
          return false
        }

        // Other blocks: try to break
        try {
          await bot.dig(block)
          blocksBroken++
          await this.sleep(200)
        } catch {
          // Cannot break this block
        }
      }
    }

    return true
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
          const arrived = await this.gotoWithTimeout(cand.target)
          if (!arrived && this.isStuck) {
            // Try to clear blocking blocks before retrying
            console.log(`[${this.username}] No path to target, trying to clear blocks`)
            if (ENABLE_CHAT) this.bot.chat(`[${this.username}] Clearing path!`)
            const canClear = await this.clearPathBlockage(cand.target)
            if (canClear) {
              // Retry with same target after clearing
              await this.sleep(BLOCK_BREAK_RETRY_DELAY_MS)
              const retryTarget = {
                x: cand.target.x + (Math.random() - 0.5) * 5,
                y: cand.target.y,
                z: cand.target.z + (Math.random() - 0.5) * 5
              }
              await this.gotoWithTimeout(retryTarget)
            } else {
              // Path blocked by unbreakable blocks, find alternative
              console.log(`[${this.username}] Path blocked by unbreakable blocks, finding alternative`)
              if (ENABLE_CHAT) this.bot.chat(`[${this.username}] Blocked, rerouting!`)
              // Find a new frontier target
              const altCand = this.findFrontierSimple()
              if (altCand) {
                await this.gotoWithTimeout(altCand.target)
                if (altCand.chunk) {
                  this.visited.add(`${altCand.chunk.tx}:${altCand.chunk.tz}`)
                }
              }
            }
          }
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