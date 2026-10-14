# Postgres
DATABASE_URL=postgres://zipy:CHANGE_ME@localhost:5432/zipy
DATABASE_SSL=false

# Session
SESSION_SECRET=CHANGE_ME_32_BYTES_OF_HEX

# Public URL
PUBLIC_BASE_URL=https://zipy.example.internal

# Storage
STORAGE_DRIVER=local
STORAGE_LOCAL_ROOT=/var/lib/zipy/objects

# LLM — either a hosted provider or a local one
LLM_DEFAULT_PROVIDER=ollama
OLLAMA_BASE_URL=http://127.0.0.1:11434
OLLAMA_MODEL=llama3.1:8b-instruct-q4_K_M

# Browser
PLAYWRIGHT_BROWSERS_PATH=/var/lib/zipy/playwright
PLAYWRIGHT_BROWSER=chromium
PLAYWRIGHT_HEADLESS=true
