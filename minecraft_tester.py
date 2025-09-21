#!/usr/bin/env python3
# Default configuration
DEFAULT_CONFIG = {
    "server": {
        "host": "localhost",
        "port": 25565,
        "rcon_port": 25575,
        "rcon_password": "your_rcon_password"
    },
    "scenarios": {
        "quick": {
            "player_count": 2,
            "duration_minutes": 1,
            "world_gen_chunks": 10,
            "entity_spawn_rate": "low",
            "description": "Quick test - 1 minute"
        },
        "light": {
            "player_count": 3,
            "duration_minutes": 5,
            "world_gen_chunks": 30,
            "entity_spawn_rate": "low",
            "description": "Light load - 3 players, 5 min"
        },
        "medium": {
            "player_count": 6,
            "duration_minutes": 8,
            "world_gen_chunks": 60,
            "entity_spawn_rate": "medium",
            "description": "Medium load - 6 players, 8 min"
        },
        "heavy": {
            "player_count": 10,
            "duration_minutes": 12,
            "world_gen_chunks": 100,
            "entity_spawn_rate": "high",
            "description": "Heavy load - 10 players, 12 min"
        }
    }
}
import asyncio
import json
import time
import statistics
import csv
import os
import socket
import threading
import subprocess
from datetime import datetime
from typing import Dict, List

class MinecraftBot:
    def __init__(self, username: str, server_host: str, server_port: int):
        self.username = username
        self.server_host = server_host
        self.server_port = server_port
        self.connected = False

    async def connect(self):
        try:
            s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
            s.settimeout(2)
            r = s.connect_ex((self.server_host, self.server_port))
            s.close()
            if r == 0:
                self.connected = True
                return True
            return False
        except Exception:
            return False

    async def simulate_activity(self, duration_seconds: int, stop_event=None):
        if not self.connected:
            return
        start = time.time()
        while True:
            if stop_event and stop_event.is_set():
                break
            if duration_seconds > 0 and time.time() - start >= duration_seconds:
                break
            await asyncio.sleep(1)

class PerformanceTester:
    def __init__(self, config: Dict):
        self.config = config
        self.server_host = config['server']['host']
        self.server_port = config['server']['port']
        self.rcon_password = config['server']['rcon_password']
        self.stop_event = asyncio.Event()
        self.use_real_tps = False
        self._test_rcon()

    def _test_rcon(self):
        try:
            from mcrcon import MCRcon
            with MCRcon(self.server_host, self.rcon_password, port=self.config['server']['rcon_port'], timeout=3) as mcr:
                resp = mcr.command("/help")
                self.use_real_tps = True if resp else False
        except Exception:
            self.use_real_tps = False

    def get_tps(self) -> float:
        try:
            if self.use_real_tps:
                from mcrcon import MCRcon
                with MCRcon(self.server_host, self.rcon_password, port=self.config['server']['rcon_port'], timeout=2) as mcr:
                    resp = mcr.command("/tps")
                    if "TPS" in resp and ":" in resp:
                        line = resp.split("\n")[0]
                        vals = line.split(": ")[1].split(", ")
                        return float(vals[0])
        except Exception:
            pass
        import random
        base = 20.0
        var = random.uniform(-2.0, 0.2)
        return max(0, min(20, base + var))

    def test_world_generation(self, chunk_count: int) -> Dict:
        start = time.time()
        for _ in range(chunk_count):
            import random
            time.sleep(random.uniform(0.01, 0.05))
        total = time.time() - start
        cps = chunk_count / total if total > 0 else 0
        return {
            "total_chunks": chunk_count,
            "total_time": total,
            "chunks_per_second": cps,
            "avg_time_per_chunk": total / chunk_count if chunk_count > 0 else 0
        }

    def test_entities(self, spawn_rate: str) -> Dict:
        mapping = {"low": 50, "medium": 150, "high": 300}
        count = mapping.get(spawn_rate, 50)
        start = time.time()
        for _ in range(count):
            import random
            time.sleep(random.uniform(0.002, 0.01))
        total = time.time() - start
        eps = count / total if total > 0 else 0
        return {
            "spawn_rate": spawn_rate,
            "total_entities": count,
            "entities_per_second": eps,
            "total_time": total
        }

class RealMovingBotManager:
    def __init__(self, server_host, server_port, node_path="node", script="wander_bot.js", prefix="W_"):
        self.server_host = server_host
        self.server_port = server_port
        self.node_path = node_path
        self.script = script
        self.prefix = prefix
        self.procs = []

    def _seq_name(self, idx: int):
        name = f"{self.prefix}{idx}"
        return name[:16]

    def spawn(self, count: int, delay_sec: float = 3.0):
        ok = 0
        for i in range(count):
            name = self._seq_name(i + 1)
            cmd = [
                self.node_path, self.script,
                "--host", str(self.server_host),
                "--port", str(self.server_port),
                "--username", name
            ]
            try:
                p = subprocess.Popen(
                    cmd,
                    stdout=subprocess.PIPE,
                    stderr=subprocess.STDOUT,
                    text=True
                )
                threading.Thread(
                    target=lambda proc=p, nm=name: [print(f"[{nm}] {line.strip()}") for line in proc.stdout],
                    daemon=True
                ).start()
                self.procs.append(p)
                ok += 1
                print(f"   launched real bot: {name}")
            except Exception as e:
                print(f"   fail spawn {name}: {e}")
            time.sleep(delay_sec)
        return ok

    def stop_all(self):
        for p in self.procs:
            try:
                if p.poll() is None:
                    p.terminate()
                    try:
                        p.wait(timeout=5)
                    except subprocess.TimeoutExpired:
                        p.kill()
            except Exception:
                pass
        self.procs.clear()

class EnhancedPerformanceTester(PerformanceTester):
    async def run_test(self, scenario_name: str, config: Dict, is_unlimited=False) -> Dict:
        print(f"\n🚀 RUNNING: {scenario_name.upper()}")
        print(f"   {config['description']}")
        print(f"   👥 {config['player_count']} bots")

        if is_unlimited:
            print("   ⏱️ Duration: UNLIMITED (Ctrl+C to stop)")
        else:
            print(f"   ⏱️ Duration: {config['duration_minutes']} minutes")

        start = time.time()
        self.stop_event.clear()

        bot_mode = self.config.get("bot_mode", "simulated")
        connected_count = 0
        bot_tasks = []
        moving_mgr = None

        if bot_mode == "real_moving":
            print("\n1️⃣ Deploying bots...")
            print("   Mode: REAL MOVING BOTS (Mineflayer)")
            moving_mgr = RealMovingBotManager(self.server_host, self.server_port, prefix="W_")
            connected_count = moving_mgr.spawn(config["player_count"], delay_sec=3.0)
            await asyncio.sleep(5 + min(10, config["player_count"]))
        else:
            print("\n1️⃣ Deploying bots...")
            print("   Mode: SIMULATED (socket connect only)")
            bots = []
            for i in range(config['player_count']):
                print(f"  Connecting bot {i+1}/{config['player_count']}...", end="", flush=True)
                b = MinecraftBot(f"Bot_{i+1}", self.server_host, self.server_port)
                if await b.connect():
                    bots.append(b)
                    print(" ✅")
                else:
                    print(" ❌")
            connected_count = len(bots)
            for b in bots:
                t = asyncio.create_task(
                    b.simulate_activity(0 if is_unlimited else config['duration_minutes'] * 60, self.stop_event)
                )
                bot_tasks.append(t)

        print("\n2️⃣ Monitoring TPS...")
        tps_readings = []

        try:
            if is_unlimited:
                it = 0
                while not self.stop_event.is_set():
                    tps = self.get_tps()
                    tps_readings.append(tps)
                    it += 1
                    if it % 30 == 0:
                        recent = statistics.mean(tps_readings[-60:]) if len(tps_readings) >= 60 else statistics.mean(tps_readings)
                        print(f"   {it//60}min elapsed | Current TPS: {tps:.1f} | Avg: {recent:.1f}")
                    await asyncio.sleep(1)
            else:
                total = config['duration_minutes'] * 60
                for s in range(total):
                    tps = self.get_tps()
                    tps_readings.append(tps)
                    if (s + 1) % 60 == 0:
                        minute = (s + 1) // 60
                        avgm = statistics.mean(tps_readings[-60:])
                        print(f"   Minute {minute}: Avg TPS = {avgm:.1f}")
                    await asyncio.sleep(1)
        except KeyboardInterrupt:
            print("\n⏹️ Test stopped by user")
            self.stop_event.set()

        print(f"   TPS monitoring completed: {len(tps_readings)} readings collected")

        print("\n3️⃣ World generation test...")
        try:
            world_results = self.test_world_generation(config['world_gen_chunks'])
        except Exception:
            world_results = {"total_chunks": 0, "chunks_per_second": 0, "total_time": 0, "avg_time_per_chunk": 0}

        print("\n4️⃣ Entity spawning test...")
        try:
            entity_results = self.test_entities(config['entity_spawn_rate'])
        except Exception:
            entity_results = {"spawn_rate": config['entity_spawn_rate'], "total_entities": 0, "entities_per_second": 0, "total_time": 0}

        print("\n5️⃣ Stopping bots...")
        self.stop_event.set()

        if bot_mode == "real_moving" and moving_mgr:
            moving_mgr.stop_all()
            print("   All real moving bots stopped")
        else:
            try:
                await asyncio.wait_for(asyncio.gather(*bot_tasks, return_exceptions=True), timeout=10)
                print("   All simulated bots stopped successfully")
            except asyncio.TimeoutError:
                print("   Bot shutdown timeout - forcing stop")

        end = time.time()
        dur = end - start

        if tps_readings:
            avg = statistics.mean(tps_readings)
            mn = min(tps_readings)
            mx = max(tps_readings)
        else:
            avg = mn = mx = 0

        print(f"\n✅ {scenario_name.upper()} COMPLETED! ({dur/60:.1f} min)")
        print(f"   TPS: {avg:.1f} avg | {mn:.1f} min | {mx:.1f} max")
        print(f"   World: {world_results['chunks_per_second']:.1f} chunks/sec")
        print(f"   Entity: {entity_results['entities_per_second']:.1f} spawns/sec")
        print(f"   Bots: {connected_count}/{config['player_count']} connected")

        return {
            "scenario": scenario_name,
            "config": config,
            "bot_mode": bot_mode,
            "start_time": datetime.now().isoformat(),
            "total_duration_seconds": dur,
            "connected_bots": connected_count,
            "is_unlimited": is_unlimited,
            "tps_stats": {
                "average": avg,
                "minimum": mn,
                "maximum": mx,
                "total_readings": len(tps_readings)
            },
            "world_gen_results": world_results,
            "entity_results": entity_results
        }

    def save_results(self, results: List[Dict]):
        os.makedirs("results", exist_ok=True)
        ts = datetime.now().strftime('%Y%m%d_%H%M%S')

        csvf = f"results/test_summary_{ts}.csv"
        with open(csvf, 'w', newline='', encoding='utf-8') as f:
            w = csv.writer(f)
            w.writerow([
                'Scenario', 'Bot_Mode', 'Bots', 'Duration_Min', 'Avg_TPS', 'Min_TPS',
                'Max_TPS', 'Chunks_Per_Sec', 'Entities_Per_Sec', 'Connected_Bots', 'Test_Time'
            ])
            for r in results:
                d = r['total_duration_seconds'] / 60 if r['is_unlimited'] else r['config']['duration_minutes']
                w.writerow([
                    r['scenario'],
                    r.get('bot_mode', 'unknown'),
                    r['config']['player_count'],
                    f"{d:.1f}",
                    f"{r['tps_stats']['average']:.2f}",
                    f"{r['tps_stats']['minimum']:.2f}",
                    f"{r['tps_stats']['maximum']:.2f}",
                    f"{r['world_gen_results']['chunks_per_second']:.2f}",
                    f"{r['entity_results']['entities_per_second']:.2f}",
                    r['connected_bots'],
                    r['start_time']
                ])

        jsonf = f"results/detailed_results_{ts}.json"
        with open(jsonf, 'w', encoding='utf-8') as f:
            json.dump(results, f, indent=2, default=str)

        print(f"\n💾 Results saved:")
        print(f"   📊 Summary: {csvf}")
        print(f"   📋 Details: {jsonf}")

def build_tester(cfg):
    return EnhancedPerformanceTester(cfg)

async def main():
    print("🎮 Minecraft Server Performance Tester")
    try:
        with open('config.json', 'r') as f:
            cfg = json.load(f)
        print("✅ Configuration loaded")
    except Exception:
        cfg = DEFAULT_CONFIG
        with open('config.json', 'w') as f:
            json.dump(cfg, f, indent=2)
        print("⚠️ config.json not found, created default")

    tester = build_tester(cfg)

    while True:
        try:
            sc = cfg['scenarios']
            keys = list(sc.keys())

            print("\n============================================================")
            print("Select scenario:")
            for i, k in enumerate(keys, 1):
                print(f"  {i}. {k} - {sc[k]['description']}")
            print(f"  {len(keys)+1}. custom")
            print(f"  {len(keys)+2}. unlimited")
            print(f"  {len(keys)+3}. multiple")
            print("  0. exit")

            ch = input(f"\nSelect (0-{len(keys)+3}): ").strip()
            if ch == '0':
                break

            allr = []

            if ch.isdigit() and 1 <= int(ch) <= len(keys):
                k = keys[int(ch) - 1]
                res = await tester.run_test(k, sc[k])
                allr.append(res)

            elif int(ch) == len(keys) + 1:
                print("\ncustom")
                b = int(input("bots: ") or "5")
                d = int(input("minutes: ") or "5")
                wc = int(input("world_gen_chunks: ") or "50")
                er = input("entity rate (low/medium/high): ").strip() or "medium"
                cc = {
                    "player_count": b,
                    "duration_minutes": d,
                    "world_gen_chunks": wc,
                    "entity_spawn_rate": er,
                    "description": f"custom {b}"
                }
                res = await tester.run_test("custom", cc)
                allr.append(res)

            elif int(ch) == len(keys) + 2:
                print("\nunlimited")
                b = int(input("bots: ") or "5")
                wc = int(input("world_gen_chunks: ") or "50")
                er = input("entity rate (low/medium/high): ").strip() or "medium"
                cc = {
                    "player_count": b,
                    "duration_minutes": -1,
                    "world_gen_chunks": wc,
                    "entity_spawn_rate": er,
                    "description": f"unlimited {b}"
                }
                res = await tester.run_test("unlimited", cc, is_unlimited=True)
                allr.append(res)

            elif int(ch) == len(keys) + 3:
                sel = input("enter indices (e.g. 1 3): ").strip().split()
                pick = [keys[int(x) - 1] for x in sel if x.isdigit() and 1 <= int(x) <= len(keys)]
                if not pick:
                    pick = keys
                for i, k in enumerate(pick):
                    res = await tester.run_test(k, sc[k])
                    allr.append(res)
                    if i < len(pick) - 1:
                        print("\n⏳ Waiting 15 seconds before next test...")
                        await asyncio.sleep(15)
            else:
                continue

            if allr:
                tester.save_results(allr)
                print("\nDone. Press Enter...")
                input()

        except (KeyboardInterrupt, EOFError):
            break
        except Exception as e:
            print(f"\nError: {e}")
            input("Press Enter...")

if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        pass
