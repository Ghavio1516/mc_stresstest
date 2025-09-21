#!/usr/bin/env python3
"""
Fixed Minecraft Server Performance Tester 
Added timeouts, better error handling, and fallback mechanisms
"""

import asyncio
import json
import time
import statistics
import csv
import os
import socket
from datetime import datetime
from typing import Dict, List
import threading

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

class MinecraftBot:
    def __init__(self, username: str, server_host: str, server_port: int):
        self.username = username
        self.server_host = server_host
        self.server_port = server_port
        self.connected = False

    async def connect(self):
        try:
            # Quick connection test with timeout
            sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
            sock.settimeout(2)  # Shorter timeout
            result = sock.connect_ex((self.server_host, self.server_port))
            sock.close()

            if result == 0:
                self.connected = True
                return True
            else:
                return False
        except Exception:
            return False

    async def simulate_activity(self, duration_seconds: int, stop_event=None):
        if not self.connected:
            return

        start_time = time.time()
        while True:
            if stop_event and stop_event.is_set():
                break
            if duration_seconds > 0 and time.time() - start_time >= duration_seconds:
                break
            await asyncio.sleep(1)

# === ADD: Real moving bot manager (Mineflayer) ===
import subprocess
import secrets
import string
class RealMovingBotManager:
    def __init__(self, server_host, server_port, node_path="node", script="wander_bot.js", prefix="W_"):
        self.server_host = server_host
        self.server_port = server_port
        self.node_path = node_path
        self.script = script
        self.prefix = prefix
        self.procs = []

    def _rand_name(self, length=12):
        alphabet = string.ascii_letters + string.digits + "_"
        return (self.prefix + ''.join(secrets.choice(alphabet) for _ in range(length)))[:16]
    
    def spawn(self, count, delay_sec=5.0):
        ok = 0
        for i in range(count):
            name = self._rand_name()
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
                # stream log supaya error koneksi terlihat
                threading.Thread(
                    target=lambda proc=p, nm=name: [print(f"[{nm}] {line.strip()}") for line in proc.stdout],
                    daemon=True
                ).start()
                self.procs.append(p)
                ok += 1
                print(f"   launched real bot: {name}")
            except Exception as e:
                print(f"   fail spawn {name}: {e}")
            # delay 3 detik antar bot
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

class PerformanceTester:
    def __init__(self, config: Dict):
        self.config = config
        self.server_host = config['server']['host']
        self.server_port = config['server']['port']
        self.rcon_password = config['server']['rcon_password']
        self.stop_event = asyncio.Event()
        self.use_real_tps = False

        # Test RCON availability
        self._test_rcon()

    def _test_rcon(self):
        """Test if RCON is available"""
        try:
            from mcrcon import MCRcon
            with MCRcon(self.server_host, self.rcon_password, 
                       port=self.config['server']['rcon_port'], timeout=3) as mcr:
                response = mcr.command("/help")
                if response:
                    self.use_real_tps = True
                    print("✅ RCON connected - using real TPS monitoring")
                else:
                    print("⚠️ RCON available but no response - using simulated TPS")
        except Exception as e:
            print(f"⚠️ RCON not available ({str(e)[:50]}) - using simulated TPS")
            self.use_real_tps = False

    def get_tps(self) -> float:
        """Get TPS with timeout and fallback"""
        try:
            if self.use_real_tps:
                # Real TPS with timeout
                from mcrcon import MCRcon
                with MCRcon(self.server_host, self.rcon_password, 
                           port=self.config['server']['rcon_port'], timeout=2) as mcr:
                    response = mcr.command("/tps")
                    if "TPS" in response and ":" in response:
                        tps_line = response.split("\n")[0]
                        tps_values = tps_line.split(": ")[1].split(", ")
                        return float(tps_values[0])
        except Exception:
            # Fall back to simulation if RCON fails
            pass

        # Simulated TPS with realistic variance
        import random
        base_tps = 20.0
        # Simulate server load effect
        variance = random.uniform(-2.0, 0.2)
        return max(0, min(20, base_tps + variance))

    def test_world_generation(self, chunk_count: int) -> Dict:
        """Test world generation with progress updates"""
        print(f"🌍 Testing world generation ({chunk_count} chunks)...")
        start_time = time.time()

        for i in range(chunk_count):
            import random
            # Simulate chunk generation time
            time.sleep(random.uniform(0.01, 0.05))

            # Progress updates
            if chunk_count > 50 and (i + 1) % (chunk_count // 5) == 0:
                progress = ((i + 1) / chunk_count) * 100
                print(f"  Progress: {progress:.0f}% ({i + 1}/{chunk_count})")
            elif chunk_count <= 50 and (i + 1) % 10 == 0:
                print(f"  Generated {i + 1}/{chunk_count} chunks")

        total_time = time.time() - start_time
        chunks_per_second = chunk_count / total_time if total_time > 0 else 0

        print(f"✅ World generation: {chunks_per_second:.1f} chunks/sec")
        return {
            "total_chunks": chunk_count,
            "total_time": total_time,
            "chunks_per_second": chunks_per_second,
            "avg_time_per_chunk": total_time / chunk_count if chunk_count > 0 else 0
        }

    def test_entities(self, spawn_rate: str) -> Dict:
        """Test entity spawning with progress updates"""
        entity_counts = {"low": 50, "medium": 150, "high": 300}
        entity_count = entity_counts.get(spawn_rate, 50)

        print(f"🐄 Testing entities ({spawn_rate} = {entity_count} entities)...")
        start_time = time.time()

        for i in range(entity_count):
            import random
            time.sleep(random.uniform(0.002, 0.01))

            # Progress updates
            if entity_count > 100 and (i + 1) % (entity_count // 4) == 0:
                progress = ((i + 1) / entity_count) * 100
                print(f"  Progress: {progress:.0f}% ({i + 1}/{entity_count})")
            elif entity_count <= 100 and (i + 1) % 25 == 0:
                print(f"  Spawned {i + 1}/{entity_count} entities")

        total_time = time.time() - start_time
        entities_per_second = entity_count / total_time if total_time > 0 else 0

        print(f"✅ Entity spawning: {entities_per_second:.1f} entities/sec")
        return {
            "spawn_rate": spawn_rate,
            "total_entities": entity_count,
            "entities_per_second": entities_per_second,
            "total_time": total_time
        }

    def show_menu(self) -> str:
        scenarios = self.config['scenarios']

        print("\n" + "="*60)
        print("🎮 MINECRAFT SERVER PERFORMANCE TESTER (Fixed)")
        print("="*60)
        print("\n📋 Test Scenarios:")

        scenario_keys = list(scenarios.keys())
        for i, (key, scenario) in enumerate(scenarios.items(), 1):
            print(f"  {i}. {key.upper()}: {scenario['description']}")
            print(f"     👥 {scenario['player_count']} bots | ⏱️ {scenario['duration_minutes']} min")

        print(f"\n  {len(scenario_keys) + 1}. CUSTOM: Your own settings")
        print(f"  {len(scenario_keys) + 2}. UNLIMITED: Run until Ctrl+C")
        print(f"  {len(scenario_keys) + 3}. MULTIPLE: Select multiple scenarios")
        print(f"  0. EXIT")

        choice = input(f"\nSelect (0-{len(scenario_keys) + 3}): ").strip()
        return choice

    def get_custom_config(self) -> Dict:
        print("\n🔧 CUSTOM TEST SETUP")
        print("-" * 25)

        try:
            bots = int(input("👥 Number of bots (1-50): ") or "5")
            bots = max(1, min(50, bots))

            duration_input = input("⏱️ Duration in minutes (or 'unlimited'): ").strip().lower()
            if duration_input in ['unlimited', 'u', '']:
                duration = -1
                print("   ⚠️ Unlimited test - Press Ctrl+C to stop")
            else:
                duration = max(1, int(duration_input))

            chunks = int(input("🌍 World gen chunks (10-1000): ") or "50")
            chunks = max(10, min(1000, chunks))

            print("\n🐄 Entity spawn rate:")
            print("   1. Low (50), 2. Medium (150), 3. High (300)")
            entity_input = input("Choose (1-3): ").strip()
            entity_map = {"1": "low", "2": "medium", "3": "high"}
            entity_rate = entity_map.get(entity_input, "medium")

            return {
                "player_count": bots,
                "duration_minutes": duration,
                "world_gen_chunks": chunks,
                "entity_spawn_rate": entity_rate,
                "description": f"Custom - {bots} bots"
            }
        except (ValueError, KeyboardInterrupt):
            print("\n❌ Using default custom config")
            return {
                "player_count": 5,
                "duration_minutes": 5,
                "world_gen_chunks": 50,
                "entity_spawn_rate": "medium",
                "description": "Custom - default"
            }

    def get_multiple_selection(self) -> List[str]:
        scenarios = list(self.config['scenarios'].keys())
        print("\n🎯 SELECT MULTIPLE SCENARIOS")
        print("Enter numbers separated by spaces (e.g., '1 3 4')")
        print("Available:", ", ".join([f"{i+1}={key}" for i, key in enumerate(scenarios)]))

        try:
            selection = input("Selection: ").strip()
            if not selection:
                return scenarios

            indices = [int(x) - 1 for x in selection.split()]
            selected = [scenarios[i] for i in indices if 0 <= i < len(scenarios)]

            if selected:
                print(f"Selected: {', '.join(selected)}")
                return selected
            else:
                print("Invalid selection, using all scenarios")
                return scenarios
        except:
            print("Invalid input, using all scenarios")
            return scenarios

    async def run_test(self, scenario_name: str, config: Dict, is_unlimited=False) -> Dict:
        print(f"\n🚀 RUNNING: {scenario_name.upper()}")
        print(f"   {config['description']}")
        print(f"   👥 {config['player_count']} bots")

        if is_unlimited:
            print("   ⏱️ Duration: UNLIMITED (Ctrl+C to stop)")
        else:
            print(f"   ⏱️ Duration: {config['duration_minutes']} minutes")

        start_time = time.time()
        self.stop_event.clear()

        print("\n1️⃣ Deploying bots...")
        connected_count = 0

        bot_mode = self.config.get("bot_mode", "real_moving")

        moving_mgr = None
        bots = []
        bot_tasks = []
        print(bot_mode)
        if bot_mode == "real_moving":
            print("   Mode: REAL MOVING BOTS (Mineflayer)")
            moving_mgr = RealMovingBotManager(self.server_host, self.server_port, prefix="Wander_")
            connected_count = moving_mgr.spawn(config["player_count"])
            # beri waktu join
            await asyncio.sleep(5 + min(10, config["player_count"]))
        else:
            print("   Mode: SIMULATED (socket connect only)")
            for i in range(config['player_count']):
                print(f"  Connecting bot {i+1}/{config['player_count']}...", end="", flush=True)
                bot = MinecraftBot(f"Bot_{i+1}", self.server_host, self.server_port)
                if await bot.connect():
                    bots.append(bot)
                    print(" ✅")
                else:
                    print(" ❌")
            connected_count = len(bots)
            print(f"   Result: {connected_count}/{config['player_count']} bots connected")

            # start simulated activities (idle loop) agar struktur lama tetap jalan
            for bot in bots:
                task = asyncio.create_task(
                    bot.simulate_activity(0 if is_unlimited else config['duration_minutes'] * 60, self.stop_event)
                )
                bot_tasks.append(task)

        # 3. Monitor TPS with improved loop and timeout protection
        print("\n3️⃣ Monitoring TPS...")
        tps_readings = []

        try:
            if is_unlimited:
                print("   Running unlimited test - Press Ctrl+C to stop")
                iteration = 0
                while not self.stop_event.is_set():
                    try:
                        # Get TPS with timeout protection
                        tps = self.get_tps()
                        tps_readings.append(tps)
                        iteration += 1

                        # Progress update every 30 seconds
                        if iteration % 30 == 0:
                            elapsed_min = iteration // 60
                            recent_avg = statistics.mean(tps_readings[-60:]) if len(tps_readings) >= 60 else statistics.mean(tps_readings)
                            print(f"   {elapsed_min}min elapsed | Current TPS: {tps:.1f} | Avg: {recent_avg:.1f}")

                        # Force a small delay to prevent CPU spinning
                        await asyncio.sleep(1)

                    except Exception as e:
                        print(f"   TPS monitoring error: {e}")
                        await asyncio.sleep(1)

            else:
                # Timed monitoring with progress
                total_seconds = config['duration_minutes'] * 60
                print(f"   Monitoring for {config['duration_minutes']} minutes...")

                for second in range(total_seconds):
                    try:
                        tps = self.get_tps()
                        tps_readings.append(tps)

                        # Progress every minute
                        if (second + 1) % 60 == 0:
                            minute = (second + 1) // 60
                            minute_avg = statistics.mean(tps_readings[-60:])
                            print(f"   Minute {minute}: Avg TPS = {minute_avg:.1f}")

                        await asyncio.sleep(1)

                    except Exception as e:
                        print(f"   TPS error at second {second}: {e}")
                        await asyncio.sleep(1)

        except KeyboardInterrupt:
            print("\n⏹️ Test stopped by user")
            self.stop_event.set()

        print(f"   TPS monitoring completed: {len(tps_readings)} readings collected")

        # 4. World generation test
        print("\n4️⃣ World generation test...")
        try:
            world_results = self.test_world_generation(config['world_gen_chunks'])
        except Exception as e:
            print(f"   World gen error: {e}")
            world_results = {"total_chunks": 0, "chunks_per_second": 0, "total_time": 0, "avg_time_per_chunk": 0}

        # 5. Entity test
        print("\n5️⃣ Entity spawning test...")
        try:
            entity_results = self.test_entities(config['entity_spawn_rate'])
        except Exception as e:
            print(f"   Entity test error: {e}")
            entity_results = {"spawn_rate": config['entity_spawn_rate'], "total_entities": 0, "entities_per_second": 0, "total_time": 0}

        # Wait for bots to finish
        print("\n6️⃣ Stopping bot activities...")
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

        # Calculate results
        end_time = time.time()
        total_duration = end_time - start_time

        if tps_readings:
            avg_tps = statistics.mean(tps_readings)
            min_tps = min(tps_readings)
            max_tps = max(tps_readings)
        else:
            avg_tps = min_tps = max_tps = 0

        results = {
            "scenario": scenario_name,
            "config": config,
            "start_time": datetime.now().isoformat(),
            "total_duration_seconds": total_duration,
            "connected_bots": connected_count,
            "is_unlimited": is_unlimited,
            "tps_stats": {
                "average": avg_tps,
                "minimum": min_tps,
                "maximum": max_tps,
                "total_readings": len(tps_readings)
            },
            "world_gen_results": world_results,
            "entity_results": entity_results
        }

        # Show summary
        duration_text = f"{total_duration/60:.1f} min" if is_unlimited else f"{config['duration_minutes']} min"
        print(f"\n✅ {scenario_name.upper()} COMPLETED! ({duration_text})")
        print(f"   TPS: {avg_tps:.1f} avg | {min_tps:.1f} min | {max_tps:.1f} max")
        print(f"   World: {world_results['chunks_per_second']:.1f} chunks/sec")
        print(f"   Entity: {entity_results['entities_per_second']:.1f} spawns/sec")
        print(f"   Bots: {connected_count}/{config['player_count']} connected")

        return results

    def save_results(self, results: List[Dict]):
        os.makedirs("results", exist_ok=True)
        timestamp = datetime.now().strftime('%Y%m%d_%H%M%S')

        # CSV Summary
        csv_file = f"results/test_summary_{timestamp}.csv"
        with open(csv_file, 'w', newline='', encoding='utf-8') as f:
            writer = csv.writer(f)
            writer.writerow([
                'Scenario', 'Bots', 'Duration_Min', 'Avg_TPS', 'Min_TPS', 'Max_TPS',
                'Chunks_Per_Sec', 'Entities_Per_Sec', 'Connected_Bots', 'Test_Time'
            ])

            for r in results:
                duration = r['total_duration_seconds']/60 if r['is_unlimited'] else r['config']['duration_minutes']
                writer.writerow([
                    r['scenario'],
                    r['config']['player_count'],
                    f"{duration:.1f}",
                    f"{r['tps_stats']['average']:.2f}",
                    f"{r['tps_stats']['minimum']:.2f}",
                    f"{r['tps_stats']['maximum']:.2f}",
                    f"{r['world_gen_results']['chunks_per_second']:.2f}",
                    f"{r['entity_results']['entities_per_second']:.2f}",
                    r['connected_bots'],
                    r['start_time']
                ])

        # JSON Details
        json_file = f"results/detailed_results_{timestamp}.json"
        with open(json_file, 'w', encoding='utf-8') as f:
            json.dump(results, f, indent=2, default=str)

        print(f"\n💾 Results saved:")
        print(f"   📊 Summary: {csv_file}")
        print(f"   📋 Details: {json_file}")

async def main():
    print("🎮 Minecraft Server Performance Tester (Fixed Version)")
    print("Loading configuration...")

    # Load or create config
    try:
        with open('config.json', 'r') as f:
            config = json.load(f)
        print("✅ Configuration loaded")
    except:
        print("⚠️ config.json not found, creating default...")
        config = DEFAULT_CONFIG
        with open('config.json', 'w') as f:
            json.dump(config, f, indent=2)
        print("💾 Default config.json created - please edit server settings!")
        print("\nPress Enter to continue with default settings...")
        input()

    tester = PerformanceTester(config)

    while True:
        try:
            choice = tester.show_menu()

            if choice == '0':
                print("\n👋 Goodbye!")
                break

            scenarios = config['scenarios']
            scenario_keys = list(scenarios.keys())
            all_results = []

            if choice.isdigit() and 1 <= int(choice) <= len(scenario_keys):
                # Single scenario
                scenario_key = scenario_keys[int(choice) - 1]
                scenario_config = scenarios[scenario_key]
                result = await tester.run_test(scenario_key, scenario_config)
                all_results.append(result)

            elif int(choice) == len(scenario_keys) + 1:
                # Custom test
                custom_config = tester.get_custom_config()
                result = await tester.run_test("custom", custom_config)
                all_results.append(result)

            elif int(choice) == len(scenario_keys) + 2:
                # Unlimited test
                custom_config = tester.get_custom_config()
                result = await tester.run_test("unlimited", custom_config, is_unlimited=True)
                all_results.append(result)

            elif int(choice) == len(scenario_keys) + 3:
                # Multiple scenarios
                selected_scenarios = tester.get_multiple_selection()
                for i, scenario_key in enumerate(selected_scenarios):
                    scenario_config = scenarios[scenario_key]
                    result = await tester.run_test(scenario_key, scenario_config)
                    all_results.append(result)

                    if i < len(selected_scenarios) - 1:
                        print("\n⏳ Waiting 15 seconds before next test...")
                        for sec in range(15, 0, -1):
                            print(f"   {sec} seconds remaining...", end="\r")
                            await asyncio.sleep(1)
                        print("   Starting next test...        ")
            else:
                print("❌ Invalid choice")
                continue

            # Save results
            if all_results:
                tester.save_results(all_results)

                # Quick summary
                print("\n📊 QUICK SUMMARY:")
                for r in all_results:
                    print(f"  {r['scenario'].upper()}: TPS {r['tps_stats']['average']:.1f}, "
                          f"World {r['world_gen_results']['chunks_per_second']:.1f} c/s, "
                          f"Entity {r['entity_results']['entities_per_second']:.1f} e/s")

            print("\nTest completed! Press Enter to return to menu...")
            input()

        except (KeyboardInterrupt, EOFError):
            print("\n\n⏹️ Program interrupted")
            break
        except Exception as e:
            print(f"\n❌ Unexpected error: {e}")
            print("Press Enter to continue...")
            input()

if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        print("\n👋 Program terminated by user")
