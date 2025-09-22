#!/bin/bash

echo "🎮 Minecraft Server Performance Tester"
echo "======================================"

# Function untuk check command exists
command_exists() {
    command -v "$1" >/dev/null 2>&1
}

# Check Python
if ! command_exists python3 && ! command_exists python; then
    echo "❌ Python not found! Install with: sudo apt install python3 (Ubuntu) or brew install python (macOS)"
    exit 1
fi

# Set python command
PYTHON_CMD="python3"
if ! command_exists python3 && command_exists python; then
    PYTHON_CMD="python"
fi

echo "✅ Python found: $($PYTHON_CMD --version)"

# Check Node.js for real bots
if ! command_exists node; then
    echo "⚠️  Node.js not found - real bot mode won't work"
    echo "   Install from: https://nodejs.org or use package manager"
else
    echo "✅ Node.js found: $(node --version)"
fi

# Install mcrcon if needed (optional for real TPS monitoring)
echo "📦 Checking dependencies..."
$PYTHON_CMD -m pip install --user mcrcon >/dev/null 2>&1 || echo "⚠️  mcrcon install failed (optional dependency)"

# Create results folder
mkdir -p results

# Run the tester
echo "🚀 Starting Performance Tester..."
$PYTHON_CMD minecraft_tester.py

echo ""
echo "Press Enter to exit..."
read
