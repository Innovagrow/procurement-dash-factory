import re
from pathlib import Path

terminal_file = Path("C:/Users/admin/.cursor/projects/c-Users-admin-eurostat-dash-factory/terminals/852152.txt")

if terminal_file.exists():
    content = terminal_file.read_text(encoding='utf-8', errors='ignore')
    
    # Find URL pattern
    url_match = re.search(r'http://localhost:(\d+)', content)
    if url_match:
        print(f"Server running at: http://localhost:{url_match.group(1)}")
    else:
        print("Server URL not found yet...")
    
    # Show last 20 lines
    lines = content.split('\n')
    print("\nLast lines:")
    for line in lines[-20:]:
        if line.strip():
            print(line)
else:
    print("Terminal file not found")
