#!/bin/bash

echo "🎮 Minecraft Server Performance Tester"
echo "======================================"

# Project directory (where script is located)
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" &> /dev/null && pwd)"
VENV_DIR="$SCRIPT_DIR/venv"

# Function untuk check command exists
command_exists() {
    command -v "$1" >/dev/null 2>&1
}

# Check Python
if ! command_exists python3 && ! command_exists python; then
    echo "❌ Python not found! Install with:"
    echo "   Ubuntu/Debian: sudo apt install python3 python3-pip python3-venv"
    echo "   CentOS/RHEL: sudo yum install python3 python3-pip"
    echo "   macOS: brew install python"
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
    echo "   Ubuntu: curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash - && sudo apt install -y nodejs"
else
    echo "✅ Node.js found: $(node --version)"
fi

# Setup virtual environment
setup_venv() {
    echo "📦 Setting up Python virtual environment..."
    
    if [ ! -d "$VENV_DIR" ]; then
        echo "   Creating new virtual environment..."
        $PYTHON_CMD -m venv "$VENV_DIR" || {
            echo "❌ Failed to create virtual environment"
            echo "   Try: sudo apt install python3-venv"
            exit 1
        }
    else
        echo "   Using existing virtual environment..."
    fi
    
    # Activate virtual environment
    source "$VENV_DIR/bin/activate" || {
        echo "❌ Failed to activate virtual environment"
        exit 1
    }
    
    echo "✅ Virtual environment activated: $VIRTUAL_ENV"
    
    # Upgrade pip
    pip install --upgrade pip >/dev/null 2>&1
    
    # Install Python dependencies
    echo "   Installing Python dependencies..."
    pip install mcrcon >/dev/null 2>&1 && {
        echo "✅ mcrcon installed successfully"
        MCRCON_AVAILABLE=true
    } || {
        echo "⚠️  mcrcon install failed, will try alternatives..."
        MCRCON_AVAILABLE=false
    }
}

# Try alternative mcrcon installations
install_mcrcon_alternatives() {
    if [ "$MCRCON_AVAILABLE" = true ]; then
        return 0
    fi
    
    echo "📦 Trying alternative mcrcon installations..."
    
    # Try with build dependencies
    if command_exists apt; then
        echo "   Installing build dependencies..."
        if sudo apt update >/dev/null 2>&1 && sudo apt install -y python3-dev gcc build-essential >/dev/null 2>&1; then
            pip install mcrcon >/dev/null 2>&1 && {
                echo "✅ mcrcon installed with build dependencies"
                MCRCON_AVAILABLE=true
                return 0
            }
        fi
    fi
    
    # Try snap installation
    if command_exists snap; then
        echo "   Trying snap installation..."
        if sudo snap install mcrcon-nsg >/dev/null 2>&1; then
            echo "✅ mcrcon-nsg snap installed"
            # Create symlink for easier access
            sudo ln -sf /snap/bin/mcrcon-nsg /usr/local/bin/mcrcon >/dev/null 2>&1
            MCRCON_AVAILABLE=true
            return 0
        else
            echo "   Snap installation failed (snapd might not be available)"
        fi
    fi
    
    # Build from source as last resort
    echo "   Building mcrcon from source..."
    if command_exists git && command_exists gcc; then
        MCRCON_BUILD_DIR="/tmp/mcrcon-build-$$"
        if git clone https://github.com/Tiiffi/mcrcon.git "$MCRCON_BUILD_DIR" >/dev/null 2>&1; then
            cd "$MCRCON_BUILD_DIR" || return 1
            if gcc -std=gnu11 -pedantic -Wall -Wextra -O2 -s -o mcrcon mcrcon.c >/dev/null 2>&1; then
                # Install to local bin
                mkdir -p "$SCRIPT_DIR/tools"
                cp mcrcon "$SCRIPT_DIR/tools/"
                chmod +x "$SCRIPT_DIR/tools/mcrcon"
                # Add to PATH for this session
                export PATH="$SCRIPT_DIR/tools:$PATH"
                echo "✅ mcrcon built from source"
                MCRCON_AVAILABLE=true
                cd "$SCRIPT_DIR"
                rm -rf "$MCRCON_BUILD_DIR"
                return 0
            fi
            cd "$SCRIPT_DIR"
            rm -rf "$MCRCON_BUILD_DIR"
        fi
    fi
    
    echo "⚠️  All mcrcon installation attempts failed - will use simulated TPS"
    MCRCON_AVAILABLE=false
}

# Test mcrcon availability
test_mcrcon() {
    if [ "$MCRCON_AVAILABLE" = true ]; then
        echo "🔍 Testing mcrcon availability..."
        
        # Test Python mcrcon
        if python -c "import mcrcon; print('Python mcrcon OK')" >/dev/null 2>&1; then
            echo "✅ Python mcrcon library working"
            return 0
        fi
        
        # Test command-line mcrcon
        if command_exists mcrcon; then
            if mcrcon -v >/dev/null 2>&1; then
                echo "✅ Command-line mcrcon working"
                return 0
            fi
        fi
        
        # Test snap mcrcon
        if command_exists mcrcon-nsg; then
            echo "✅ Snap mcrcon-nsg available"
            return 0
        fi
        
        echo "⚠️  mcrcon installed but not working properly"
        MCRCON_AVAILABLE=false
    fi
}

# Main setup
setup_venv
install_mcrcon_alternatives
test_mcrcon

# Create results folder
mkdir -p results

# Show final status
echo ""
echo "🚀 Environment Setup Complete"
echo "   Python: $($PYTHON_CMD --version)"
if command_exists node; then
    echo "   Node.js: $(node --version)"
else
    echo "   Node.js: Not available (real bot mode disabled)"
fi
echo "   mcrcon: $([ "$MCRCON_AVAILABLE" = true ] && echo "Available" || echo "Not available (simulated TPS)")"
echo "   Virtual env: $VIRTUAL_ENV"
echo ""

# Run the tester
echo "🚀 Starting Performance Tester..."
python minecraft_tester.py

# Keep virtual environment activated if running interactively
if [[ $- == *i* ]]; then
    echo ""
    echo "💡 Virtual environment is still active"
    echo "   To deactivate: deactivate"
    echo "   To run again: python minecraft_tester.py"
else
    echo ""
    echo "Press Enter to exit..."
    read
fi
