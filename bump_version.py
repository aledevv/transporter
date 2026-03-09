import os
import re
from datetime import datetime

VERSION_FILE = 'frontend/public/version.txt'

def bump_version():
    if not os.path.exists(VERSION_FILE):
        print(f"Error: {VERSION_FILE} not found.")
        return

    with open(VERSION_FILE, 'r') as f:
        content = f.read().strip()

    # Regex to match vX.Y.Z (YYYY-MM-DD)
    # Group 1: vX.Y.
    # Group 2: Z (the last number)
    # Group 3: everything else
    match = re.search(r'(v\d+\.\d+\.)(\d+)(.*)', content)
    
    if not match:
        print(f"Error: Could not parse version format in {content}")
        return

    prefix = match.group(1)
    last_number = int(match.group(2))
    suffix = match.group(3)

    new_number = last_number + 1
    today_str = datetime.now().strftime('%Y-%m-%d')
    
    new_version = f"{prefix}{new_number} ({today_str})"
    
    with open(VERSION_FILE, 'w') as f:
        f.write(new_version + '\n')
    
    print(f"Version bumped: {content} -> {new_version}")

if __name__ == "__main__":
    bump_version()
