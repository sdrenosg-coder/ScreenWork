# Install once
curl -fsSL https://ollama.com/install.sh | sh

# Pull a model sized to the host
ollama pull llama3.1:8b-instruct-q4_K_M

# Start the server bound to loopback only; the worker reaches it in-process
OLLAMA_HOST=127.0.0.1:11434 ollama serve
