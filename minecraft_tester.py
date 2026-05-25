import asyncio
import json
import time
import os
import glob
import threading
import subprocess
from datetime import datetime, timedelta


class SequentialBotManager:
    """
    Ultra-conservative sequential bot spawning
    For servers with VERY strict connection throttle
    """
    
    def __init__(self, server_host, server_port, node_path="node", 
                 script="wander_bot.js", prefix="W_"):
        self.server_host = server_host
        self.server_port = server_port
        self.node_path = node_path
        self.script = script
        self.prefix = prefix
        self.procs = []

    def spawn_sequential(self, total_bots: int, delay_per_bot: float = 15.0):
        """
        Spawn bots one by one with long delay
        Most conservative approach for strict throttle
        
        Args:
            total_bots: Total bots to spawn
            delay_per_bot: Delay between each bot (15-20s recommended)
        """
        print(f"\n{'='*60}")
        print(f"SEQUENTIAL BOT SPAWNING (ULTRA CONSERVATIVE)")
        print(f"{'='*60}")
        print(f"Total bots:           {total_bots}")
        print(f"Delay per bot:        {delay_per_bot}s")
        print(f"Estimated time:       ~{(total_bots * delay_per_bot) / 60:.1f} minutes")
        print(f"Server throttle:      VERY STRICT")
        print(f"{'='*60}\n")
        
        spawned_count = 0
        
        for bot_id in range(total_bots):
            proc = self._spawn_single_bot(bot_id)
            
            if proc:
                self.procs.append(proc)
                spawned_count += 1
                print(f"  [{bot_id + 1}/{total_bots}] W_{bot_id} spawning...")
            else:
                print(f"  [{bot_id + 1}/{total_bots}] W_{bot_id} FAILED to spawn")
            
            # Critical: Long delay between each bot
            if bot_id < total_bots - 1:
                remaining = total_bots - bot_id - 1
                eta_min = (remaining * delay_per_bot) / 60
                print(f"      >> Waiting {delay_per_bot}s... (ETA: {eta_min:.1f} min)\n")
                time.sleep(delay_per_bot)
        
        print(f"\n{'='*60}")
        print(f"SPAWNING COMPLETE")
        print(f"{'='*60}")
        print(f"Total bots spawned:   {spawned_count}/{total_bots}")
        print(f"Success rate:         {spawned_count/total_bots*100:.1f}%")
        print(f"{'='*60}\n")
        
        print(">> Waiting 20s for stabilization...")
        time.sleep(20)
        
        return spawned_count

    def _spawn_single_bot(self, bot_id: int):
        """Spawn a single bot (1 bot = 1 process)"""
        cmd = [
            self.node_path, self.script,
            "--host", str(self.server_host),
            "--port", str(self.server_port),
            "--bots-per-process", "1",
            "--start-id", str(bot_id),
        ]

        try:
            env = os.environ.copy()
            env['NODE_OPTIONS'] = '--max-old-space-size=256'
            
            p = subprocess.Popen(
                cmd,
                stdout=subprocess.PIPE,
                stderr=subprocess.STDOUT,
                text=True,
                encoding='utf-8',
                errors='replace',
                env=env,
                bufsize=1
            )

            threading.Thread(
                target=self._log_output,
                args=(p, bot_id),
                daemon=True
            ).start()
            
            return p
            
        except Exception as e:
            print(f"      XX Failed: {e}")
            return None

    def _log_output(self, proc, bot_id):
        """Log bot output"""
        try:
            for line in proc.stdout:
                line_stripped = line.strip()
                if line_stripped:
                    line_clean = ''.join(c if ord(c) < 128 else '' for c in line_stripped)
                    
                    if not line_clean:
                        continue
                    
                    if 'Successfully spawned' in line_clean:
                        print(f"      [W_{bot_id}] ✓ Connected!")
                    elif 'throttled' in line_clean.lower():
                        print(f"      [W_{bot_id}] ✗ THROTTLED")
                    elif 'ECONNRESET' in line_clean:
                        print(f"      [W_{bot_id}] ✗ RESET")
        except:
            pass

    def stop_all(self):
        """Stop all bots"""
        print("\n" + "="*60)
        print("STOPPING ALL BOTS")
        print("="*60)
        
        for idx, p in enumerate(self.procs):
            try:
                if p.poll() is None:
                    p.terminate()
                    p.wait(timeout=3)
            except:
                try:
                    p.kill()
                except:
                    pass
        
        self.procs.clear()
        print("All bots stopped")
        print("="*60 + "\n")


class EnhancedPerformanceTester:
    """Performance tester with sequential mode for strict throttle"""
    
    def __init__(self, config_path="config.json"):
        with open(config_path, 'r') as f:
            self.config = json.load(f)
        
        self.server_host = self.config["server"]["host"]
        self.server_port = self.config["server"]["port"]
        self.test_start_time = None

    async def run_test(self, scenario_name="quick"):
        """Run performance test"""
        # Handle custom scenario (dict) or predefined scenario (string)
        if isinstance(scenario_name, dict):
            scenario = scenario_name
        else:
            scenario = self.config["scenarios"].get(scenario_name)
            if not scenario:
                print(f"Scenario '{scenario_name}' not found!")
                return
        
        print(f"\n{'='*70}")
        print(f"MINECRAFT SERVER PERFORMANCE TEST")
        print(f"{'='*70}")
        if isinstance(scenario_name, dict):
            print(f"Scenario:        CUSTOM")
            print(f"Description:     {scenario['description']}")
            print(f"Target bots:     {scenario['player_count']}")
            print(f"Duration:        {scenario['duration_minutes']} minutes")
        else:
            print(f"Scenario:        {scenario_name.upper()}")
            print(f"Description:     {scenario['description']}")
            print(f"Target bots:     {scenario['player_count']}")
            print(f"Duration:        {scenario['duration_minutes']} minutes")
        print(f"Server:          {self.server_host}:{self.server_port}")
        print(f"Mode:            SEQUENTIAL (Ultra Conservative)")
        print(f"{'='*70}\n")
        
        self.test_start_time = datetime.now()
        
        bot_manager = SequentialBotManager(
            self.server_host,
            self.server_port,
            prefix="W_"
        )
        
        player_count = scenario["player_count"]
        delay = 6.0
        # Determine delay based on bot count

        print(f"\n>>> DEPLOYING BOTS (SEQUENTIAL MODE)")
        spawned_count = bot_manager.spawn_sequential(
            total_bots=player_count,
            delay_per_bot=delay
        )
        
        if spawned_count == 0:
            print("XX No bots spawned! Aborting test.")
            return
        
        if scenario["duration_minutes"] > 0:
            print(f"\n>>> RUNNING TEST FOR {scenario['duration_minutes']} MINUTES")
            end_time = datetime.now() + timedelta(minutes=scenario['duration_minutes'])
            print(f"    Test will complete at: {end_time.strftime('%H:%M:%S')}")

            duration_sec = scenario["duration_minutes"] * 60
            start_time = time.time()

            while time.time() - start_time < duration_sec:
                elapsed = time.time() - start_time
                remaining = duration_sec - elapsed

                print(f"    Progress: {elapsed/60:.1f}/{scenario['duration_minutes']:.1f} min | "
                      f"Remaining: {remaining/60:.1f} min", end='\r')

                await asyncio.sleep(10)
        else:
            # Unlimited mode
            print(f"\n>>> RUNNING UNLIMITED TEST (Press Ctrl+C to stop)")
            start_time = time.time()

            try:
                while True:
                    elapsed = time.time() - start_time
                    print(f"    Progress: {elapsed/60:.1f} min (Unlimited)", end='\r')
                    await asyncio.sleep(10)
            except KeyboardInterrupt:
                print(f"\n\n>>> TEST STOPPED BY USER")
        
        print(f"\n\n>>> TEST COMPLETE")
        
        bot_manager.stop_all()
        
        self._generate_report(scenario_name, spawned_count)

    def _generate_report(self, scenario_name, spawned_count):
        """Generate test report"""
        print(f"\n{'='*70}")
        if isinstance(scenario_name, dict):
            if scenario_name.get('duration_minutes', 0) == 0:
                print(f"TEST REPORT - CUSTOM (UNLIMITED)")
            else:
                print(f"TEST REPORT - CUSTOM")
        else:
            print(f"TEST REPORT - {scenario_name.upper()}")
        print(f"{'='*70}")
        print(f"Bots spawned:    {spawned_count}")
        print(f"Start time:      {self.test_start_time.strftime('%Y-%m-%d %H:%M:%S')}")
        print(f"End time:        {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}")

        stats_dir = os.path.join('results', 'bot_stats')
        if os.path.exists(stats_dir):
            stats_files = glob.glob(os.path.join(stats_dir, 'W_*.json'))

            if stats_files:
                print(f"Stats collected: {len(stats_files)} bots")

                total_distance = 0
                total_chunks = 0

                for f in stats_files:
                    try:
                        with open(f, 'r') as sf:
                            data = json.load(sf)
                            total_distance += data.get('distance2D', 0)
                            total_chunks += data.get('uniqueChunks', 0)
                    except:
                        pass

                if len(stats_files) > 0:
                    print(f"Total distance:  {total_distance:.1f} blocks")
                    print(f"Total chunks:    {total_chunks}")
                    print(f"Avg per bot:     {total_distance/len(stats_files):.1f} blocks, "
                          f"{total_chunks/len(stats_files):.1f} chunks")

        print(f"{'='*70}\n")


async def main():
    print("""
===========================================
MINECRAFT SERVER PERFORMANCE TESTER - SEQUENTIAL MODE
  For Servers with VERY Strict Connection Throttle
===========================================
    """)
    
    tester = EnhancedPerformanceTester("config.json")
    
    print("\n[WARNING] This server has VERY strict throttle settings!")
    print("   Sequential mode will spawn bots one-by-one slowly.\n")
    
    print("Available scenarios:")
    for idx, (name, config) in enumerate(tester.config["scenarios"].items(), 1):
        print(f"  {idx}. {name:10s} - {config['description']}")
    
    print("\nEnter scenario name (or press Enter for 'quick'): ", end='')
    scenario_input = input().strip()

    if not scenario_input:
        scenario = "quick"
    elif scenario_input == "custom":
        # Custom scenario
        print("\n--- CUSTOM SCENARIO ---")
        try:
            player_count = int(input("Enter number of bots: ").strip())
            duration_input = input("Enter test duration (minutes, or 0 for unlimited): ").strip()
            duration_minutes = int(duration_input) if duration_input else 0

            if player_count <= 0:
                print("XX Bot count must be positive! Using quick scenario.")
                scenario = "quick"
            elif duration_minutes < 0:
                print("XX Duration cannot be negative! Using quick scenario.")
                scenario = "quick"
            else:
                # Create custom scenario dict
                scenario = {
                    "player_count": player_count,
                    "duration_minutes": duration_minutes,
                    "description": f"{player_count} bots - Custom test" + (" (Unlimited)" if duration_minutes == 0 else "")
                }
        except ValueError:
            print("XX Invalid input! Using quick scenario.")
            scenario = "quick"
    else:
        scenario = scenario_input

    await tester.run_test(scenario)


if __name__ == "__main__":
    asyncio.run(main())
